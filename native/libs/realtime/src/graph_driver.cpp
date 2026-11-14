#include "siann/realtime/graph_driver.hpp"

#include <algorithm>
#include <cassert>
#include <climits>
#include <stdexcept>
#include <vector>

#include "siann/realtime/recorder.hpp"
#include "siann/realtime/stream_resampler.hpp"

namespace siann::realtime {

namespace {
// Every meterOutbox buffer gets its entries here, on the control side.
detail::MeterFrame emptyMeterFrame(std::size_t capacity) {
    detail::MeterFrame frame;
    frame.entries.resize(capacity);
    return frame;
}

constexpr int kDefaultSrcBlock = 64;  // session frames per step when no graph is live at start

// Device frames to session frames, rounding to nearest.
std::int64_t toSessionFrames(std::int64_t frames, std::int64_t sessionRate, std::int64_t deviceRate) {
    return (frames * sessionRate + deviceRate / 2) / deviceRate;
}

struct PlanarBuffer {
    std::vector<std::vector<float>> data;
    std::vector<float*> pointers;

    void allocate(int channels, int frames) {
        data.assign(static_cast<std::size_t>(channels), std::vector<float>(static_cast<std::size_t>(frames), 0.0f));
        pointers.clear();
        for (auto& c : data) {
            pointers.push_back(c.data());
        }
    }
};

}  // namespace

// Everything the SRC path needs on the audio thread, built on the control
// side by start() and dropped by stop().
struct GraphDriver::SrcPath {
    std::int64_t sessionRate = 0;
    std::int64_t deviceRate = 0;
    int block = 0;  // session frames per step
    int outputChannels = 0;
    std::unique_ptr<StreamResampler> output;  // session -> device
    std::unique_ptr<StreamResampler> input;   // device -> session; null without inputs

    // The FIFO: two block slots per channel; `head` is the block fed next, so
    // between steps the FIFO holds exactly one block.
    PlanarBuffer slots[2];
    int head = 0;
    // Device-rate output produced but not yet sent to the device.
    PlanarBuffer carry;
    int carryRead = 0;
    int carryCount = 0;
    // Session frames fed to the output resampler so far (including the silent
    // lookahead). Between steps the next block rendered is resampler input
    // [fed + block, fed + 2 * block) and starts at the playhead, so the
    // timeline position of input index 0 is playhead - (fed + block). It is
    // computed when needed, never stored: while stopped `fed` keeps growing
    // and a locate moves the playhead, and both must show up at once.
    std::int64_t fed = 0;

    // Input path.
    int maxInputFrames = 0;
    std::vector<const float*> inputPointers;
    PlanarBuffer inputScratch;
    std::int64_t inputProduced = 0;  // session frames the input resampler produced so far
    std::int64_t stampLead = 0;      // srcOutputLatencyFrames + srcInputLatencyFrames
};

GraphDriver::GraphDriver(Options options) : options_(options), meterOutbox_(emptyMeterFrame(options.meterCapacity)) {
    if (options_.fadeFrames <= 0) {
        throw std::invalid_argument("fadeFrames must be positive");
    }
    if (options_.capture.slots > 0) {
        bank_ = std::make_unique<CaptureBank>(options_.capture);
    }
}

GraphDriver::~GraphDriver() {
    if (state_ == DriverState::realtime) {
        stop();
    }
}

void GraphDriver::setUpResampling(const host::AudioDeviceConfig& config) {
    src_.reset();
    const std::int64_t sessionRate = config.sampleRate;
    const std::int64_t deviceRate = deviceStatus_.sampleRate > 0 ? deviceStatus_.sampleRate : sessionRate;
    latency_ = LatencyReport{};
    latency_.sessionRate = sessionRate;
    latency_.deviceRate = deviceRate;
    latency_.inputLatencyFrames = toSessionFrames(deviceStatus_.inputLatencyFrames, sessionRate, deviceRate);
    latency_.outputLatencyFrames = toSessionFrames(deviceStatus_.outputLatencyFrames, sessionRate, deviceRate);

    if (deviceRate != sessionRate) {
        auto path = std::make_unique<SrcPath>();
        path->sessionRate = sessionRate;
        path->deviceRate = deviceRate;
        path->block = current_ != nullptr ? current_->maxBlockFrames() : kDefaultSrcBlock;
        path->outputChannels = config.outputChannels;
        path->output = std::make_unique<StreamResampler>(static_cast<double>(sessionRate),
                                                         static_cast<double>(deviceRate), config.outputChannels,
                                                         path->block);
        path->slots[0].allocate(config.outputChannels, path->block);
        path->slots[1].allocate(config.outputChannels, path->block);
        path->carry.allocate(config.outputChannels, 2 * path->output->maxOutputFrames());

        // Feed the resampler its lookahead in silence, so the first callback
        // renders only its share and the output delay is exactly the report.
        const int lookahead = path->output->lookaheadFrames();
        PlanarBuffer produced;
        produced.allocate(config.outputChannels, path->output->maxOutputFrames());
        for (int done = 0; done < lookahead;) {
            const int n = std::min(path->block, lookahead - done);
            const int out = path->output->process(path->slots[0].pointers.data(), n, produced.pointers.data());
            if (path->carryCount + out > 2 * path->output->maxOutputFrames()) {
                throw std::logic_error("the resampler produced more than its lookahead allows");
            }
            for (int c = 0; c < config.outputChannels; ++c) {
                std::copy_n(produced.data[static_cast<std::size_t>(c)].begin(), out,
                            path->carry.data[static_cast<std::size_t>(c)].begin() + path->carryCount);
            }
            path->carryCount += out;
            done += n;
        }
        path->fed = lookahead;  // slots[0] (silence) is the primed FIFO block
        latency_.srcOutputLatencyFrames = lookahead + path->block;

        if (config.inputChannels > 0) {
            const int maxIn = deviceStatus_.bufferFrames > 0 ? deviceStatus_.bufferFrames : config.bufferFrames;
            path->maxInputFrames = maxIn;
            path->input = std::make_unique<StreamResampler>(static_cast<double>(deviceRate),
                                                            static_cast<double>(sessionRate), config.inputChannels,
                                                            maxIn);
            path->inputPointers.assign(static_cast<std::size_t>(config.inputChannels), nullptr);
            path->inputScratch.allocate(config.inputChannels, path->input->maxOutputFrames());
            latency_.srcInputLatencyFrames =
                toSessionFrames(path->input->lookaheadFrames(), sessionRate, deviceRate);
        }
        path->stampLead = latency_.srcOutputLatencyFrames + latency_.srcInputLatencyFrames;
        src_ = std::move(path);
    }

    latency_.recordOffsetFrames = latency_.monitoredPathLatencyFrames + latency_.outputLatencyFrames +
                                  latency_.inputLatencyFrames + latency_.srcOutputLatencyFrames +
                                  latency_.srcInputLatencyFrames;
    resampling_ = ResamplingState{src_ != nullptr, deviceRate, sessionRate,
                                  latency_.srcOutputLatencyFrames + latency_.srcInputLatencyFrames};
}

std::uint64_t GraphDriver::publish(std::unique_ptr<graph::PreparedGraph> graph) {
    return publishInFamily(std::move(graph), 0);
}

std::uint64_t GraphDriver::publishInFamily(std::unique_ptr<graph::PreparedGraph> graph, std::uint64_t family) {
    if (!graph) {
        throw std::invalid_argument("cannot publish a null graph");
    }
    const std::uint64_t epoch = nextEpoch_++;
    owned_.emplace(epoch, std::move(graph));
    families_[epoch] = family != 0 ? family : epoch;
    latencyFault_.reset();  // compiled or recompiled for the nodes' current latencies
    if (state_ == DriverState::stopped) {
        installDirectly(epoch);
    } else if (inFlight_ || state_ != DriverState::realtime) {
        if (waiting_) {
            retire(*waiting_);  // superseded before it was ever sent
        }
        waiting_ = epoch;
    } else {
        send(epoch);
    }
    return epoch;
}

void GraphDriver::start(host::AudioDevice& device, const host::AudioDeviceConfig& config) {
    if (state_ != DriverState::stopped) {
        throw std::logic_error("the graph driver is already running");
    }
    if (config.sampleRate > 0) {
        clickSound_ = ClickSound::build(config.sampleRate);  // the session rate
        clickBurst_ = clickSound_.normal.size();
    }
    clickCursor_ = -1;
    deviceStatus_ = device.open(config);
    setUpResampling(config);
    srcUnderruns_.store(0, std::memory_order_relaxed);
    timing_.reset();
    deviceLost_.store(false, std::memory_order_release);
    device.setOnStopped([this](bool) { deviceLost_.store(true, std::memory_order_release); });
    device_ = &device;
    state_ = DriverState::realtime;
    // The live graph is already in current_; starting the device thread
    // publishes it to the callback. Every callback is timed into timing_
    // (spec, "Realtime rules and enforcement": a deadline miss is counted,
    // never acted on here).
    device.start([this](const host::AudioBufferView& in, const host::AudioBufferView& out) {
        const std::int64_t begin = nowNanos();
        process(in, out);
        timing_.record(out.frames, deviceStatus_.sampleRate, nowNanos() - begin);
    });
}

std::int64_t GraphDriver::nowNanos() const noexcept {
    if (options_.nowNanos != nullptr) {
        return options_.nowNanos();
    }
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

void GraphDriver::attachRecorder(Recorder* recorder) {
    if (state_ != DriverState::stopped) {
        throw std::logic_error("attach a recorder while the driver is stopped");
    }
    recorder_ = recorder;
}

void GraphDriver::stop() {
    if (state_ != DriverState::realtime) {
        return;
    }
    state_ = DriverState::stopping;
    device_->stop();  // returns after the callback has exited
    finishStop();
}

void GraphDriver::poll() {
    lendClickTempo();  // reclaims retired tables, then lends a waiting one
    if (state_ == DriverState::stopped) {
        drainParams();  // nobody else drives the graph; apply changes here
        drainCycle();
        drainClickTempo();
        reclaimClickTempos();
        TransportCommand command;
        while (transportInbox_.pop(command)) {
            applyLocate(command);
        }
        handleLatencyChanges();
        return;
    }
    if (state_ != DriverState::realtime) {
        return;
    }
    if (deviceLost_.load(std::memory_order_acquire)) {
        stop();
        return;
    }
    drainRetired();
    handleLatencyChanges();
    if (inFlight_ && std::chrono::steady_clock::now() - sentAt_ > options_.ackTimeout) {
        ++watchdogTrips_;
        stop();
    }
}

const graph::PreparedGraph* GraphDriver::liveGraph() const noexcept {
    const auto live = owned_.find(liveEpoch_);
    return live == owned_.end() ? nullptr : live->second.get();
}

void GraphDriver::handleLatencyChanges() {
    // The live graph's outbox: the audio thread produces, this side consumes.
    // A graph sent or waiting to be sent replaces the live one, so the live
    // graph's changes are stale then; drop them.
    const auto live = owned_.find(liveEpoch_);
    if (live == owned_.end()) {
        return;
    }
    const bool superseded = inFlight_.has_value() || waiting_.has_value();
    bool changed = false;
    graph::LatencyChange change;
    while (live->second->popLatencyChange(change)) {
        if (!superseded) {
            lastLatencyChange_ = LatencyChange{liveEpoch_, change.slot, change.latency};
            changed = true;
        }
    }
    if (!changed) {
        return;
    }
    // Recompile with state migration; the result keeps the live graph's slots.
    std::unique_ptr<graph::PreparedGraph> recompiled;
    try {
        recompiled = live->second->recompile();
    } catch (const graph::GraphError& error) {
        // Flagged, not silently misaligned: the live graph keeps its old
        // compensation until a later change recompiles successfully.
        ++latencyRecompileFailures_;
        latencyFault_ = LatencyFault{lastLatencyChange_->epoch, lastLatencyChange_->slot, lastLatencyChange_->latency,
                                     error.code(), error.what()};
        return;
    }
    ++latencyRecompiles_;
    publishInFamily(std::move(recompiled), families_.at(liveEpoch_));
}

bool GraphDriver::pushParam(const ParamChange& change) noexcept {
    return paramInbox_.push(change);
}

bool GraphDriver::pushLocate(const TransportCommand& command) noexcept {
    return transportInbox_.push(command);
}

bool GraphDriver::pushCycle(const CycleCommand& command) noexcept {
    return cycleInbox_.push(command);
}

void GraphDriver::setClickTempo(std::unique_ptr<const ClickTempo> tempo) {
    if (!tempo) {
        return;
    }
    // The newest wins: a table still waiting was never lent and goes now.
    pendingClickTempo_ = std::move(tempo);
    lendClickTempo();
}

void GraphDriver::lendClickTempo() {
    reclaimClickTempos();
    if (!pendingClickTempo_) {
        return;
    }
    if (state_ == DriverState::stopped) {
        // Nobody runs the callback: the audio-side fields are ours.
        drainClickTempo();
        reclaimClickTempos();
        const ClickTempo* old = clickTempo_;
        clickTempo_ = pendingClickTempo_.get();
        clickCursor_ = -1;
        clickTempos_.push_back(std::move(pendingClickTempo_));
        std::erase_if(clickTempos_, [old](const auto& owned) { return owned.get() == old; });
        return;
    }
    // Every table in clickInbox or clickRetire is one of clickTempos_, so
    // below kClickTempoTables neither queue can be full (spec, "Queues").
    // Otherwise the table waits for a poll() after the audio thread retired
    // some.
    if (clickTempos_.size() >= kClickTempoTables) {
        return;
    }
    const ClickTempo* raw = pendingClickTempo_.get();
    clickTempos_.push_back(std::move(pendingClickTempo_));
    const bool pushed = clickInbox_.push(raw);
    assert(pushed);
    (void)pushed;
}

void GraphDriver::drainCycle() noexcept {
    CycleCommand command;
    while (cycleInbox_.pop(command)) {
        cycle_ = command;
    }
}

void GraphDriver::drainClickTempo() noexcept {
    const ClickTempo* next = nullptr;
    while (clickInbox_.pop(next)) {
        if (clickTempo_ != nullptr) {
            // Cannot fail: at most kClickTempoTables tables are lent at a time.
            clickRetire_.push(clickTempo_);
        }
        clickTempo_ = next;
        clickCursor_ = -1;
    }
}

void GraphDriver::reclaimClickTempos() {
    const ClickTempo* retired = nullptr;
    while (clickRetire_.pop(retired)) {
        std::erase_if(clickTempos_, [retired](const auto& owned) { return owned.get() == retired; });
    }
}

bool GraphDriver::popMeter(MeterSample& sample) noexcept {
    while (meterCursor_ >= meterOutbox_.front().count) {
        if (!meterOutbox_.take()) {
            return false;
        }
        meterCursor_ = 0;
    }
    const detail::MeterFrame& frame = meterOutbox_.front();
    const detail::MeterFrame::Entry& entry = frame.entries[meterCursor_++];
    sample = MeterSample{frame.epoch, entry.slot, frame.blockStart, frame.frames, entry.reading};
    return true;
}

void GraphDriver::applyLocate(const TransportCommand& command) noexcept {
    lastLocate_ = command;
    playhead_.store(command.position, std::memory_order_release);
    if (current_ != nullptr) {
        current_->locate(command.generation, command.position);
    }
    if (command.play && !playing_.load()) {
        // Start, then undo it if pause() covers this generation. With
        // sequentially consistent operations either this thread sees the
        // pause or pause()'s store of false comes after ours, so a pause
        // racing a queued start always wins.
        playing_.store(true);
        if (command.generation <= pausedThrough_.load()) {
            playing_.store(false);
        } else {
            riseRemaining_ = options_.fadeFrames;  // from silence: fade in
        }
    }
    // After the playhead: a reader that sees this generation sees its position.
    appliedLocate_.store(command.generation, std::memory_order_release);
}

void GraphDriver::replayLocate() noexcept {
    if (current_ != nullptr && lastLocate_.generation != 0) {
        current_->locate(lastLocate_.generation, lastLocate_.position);
    }
}

void GraphDriver::send(std::uint64_t epoch) {
    if (!graphInbox_.push(Handoff{owned_.at(epoch).get(), epoch, families_.at(epoch)})) {
        throw std::logic_error("graphInbox full with no transition in flight");
    }
    inFlight_ = epoch;
    sentAt_ = std::chrono::steady_clock::now();
}

void GraphDriver::installDirectly(std::uint64_t epoch) {
    const std::uint64_t old = liveEpoch_;
    current_ = owned_.at(epoch).get();
    currentEpoch_ = epoch;
    currentFamily_ = families_.at(epoch);
    liveEpoch_ = epoch;
    replayLocate();
    riseRemaining_ = options_.fadeFrames;
    pathRise_ = 0;
    pathEdges_ = {};
    if (old != 0 && old != epoch) {
        retire(old);
    }
}

void GraphDriver::retire(std::uint64_t epoch) {
    const auto found = families_.find(epoch);
    const std::uint64_t family = found != families_.end() ? found->second : epoch;
    if (found != families_.end()) {
        families_.erase(found);
    }
    if (owned_.erase(epoch) == 0 || !options_.onRetired) {
        return;
    }
    // A latency recompile still playing keeps the family's instances alive.
    const bool familyLeft = std::any_of(families_.begin(), families_.end(),
                                        [family](const auto& entry) { return entry.second == family; });
    if (!familyLeft) {
        options_.onRetired(family);
    }
}

void GraphDriver::drainRetired() {
    Handoff h;
    while (retireOutbox_.pop(h)) {
        if (h.epoch != 0) {
            retire(h.epoch);
        }
        if (inFlight_) {
            liveEpoch_ = *inFlight_;
            inFlight_.reset();
        }
    }
    if (!inFlight_ && waiting_) {
        const std::uint64_t epoch = *waiting_;
        waiting_.reset();
        send(epoch);
    }
}

void GraphDriver::finishStop() {
    // The callback has exited: the audio-side fields are ours again.
    Handoff h;
    while (graphInbox_.pop(h)) {
        next_ = h;  // a graph sent but never picked up
    }
    if (next_.graph != nullptr) {
        if (current_ != nullptr && currentEpoch_ != next_.epoch) {
            retire(currentEpoch_);
        }
        current_ = next_.graph;
        currentEpoch_ = next_.epoch;
        currentFamily_ = next_.family;
        next_ = {};
        replayLocate();
    }
    duckActive_ = false;
    duckRemaining_ = 0;
    pathDuck_ = false;
    pathRise_ = 0;
    pathEdges_ = {};
    if (locatePending_) {
        applyLocate(pendingLocate_);
        locatePending_ = false;
    }
    drainCycle();
    drainClickTempo();
    reclaimClickTempos();
    if (retirePending_ && unsentRetire_.epoch != 0) {
        retire(unsentRetire_.epoch);
    }
    unsentRetire_ = {};
    retirePending_ = false;
    while (retireOutbox_.pop(h)) {
        if (h.epoch != 0) {
            retire(h.epoch);
        }
    }
    liveEpoch_ = currentEpoch_;
    inFlight_.reset();
    state_ = DriverState::stopped;
    device_ = nullptr;
    src_.reset();
    lendClickTempo();  // a table still waiting is installed directly
    if (waiting_) {
        const std::uint64_t epoch = *waiting_;
        waiting_.reset();
        installDirectly(epoch);
    }
}

// ---- audio thread ----------------------------------------------------------

void GraphDriver::process(const host::AudioBufferView& input, const host::AudioBufferView& output) noexcept {
    drainCycle();
    drainClickTempo();
    if (retirePending_ && retireOutbox_.push(unsentRetire_)) {
        retirePending_ = false;
    }
    if (!duckActive_) {
        Handoff h;
        if (graphInbox_.pop(h)) {
            if (current_ == nullptr) {
                current_ = h.graph;
                currentEpoch_ = h.epoch;
                currentFamily_ = h.family;
                replayLocate();
                riseRemaining_ = options_.fadeFrames;
                if (!retireOutbox_.push(Handoff{nullptr, 0})) {  // acknowledge: nothing retired
                    unsentRetire_ = Handoff{nullptr, 0};
                    retirePending_ = true;
                }
            } else {
                next_ = h;
                duckActive_ = true;
                duckRemaining_ = options_.fadeFrames;
                // A latency recompile of the live graph ramps only its
                // affected edges, unless a rise (whole or path) is still running.
                pathDuck_ = riseRemaining_ == 0 && pathRise_ == 0 && h.graph->recompiledFrom() == current_;
            }
        }
    }
    if (!duckActive_ && !locatePending_) {
        TransportCommand command;
        if (transportInbox_.pop(command)) {
            if (current_ == nullptr || !playing_.load(std::memory_order_acquire)) {
                applyLocate(command);  // nothing audible to fade
            } else {
                pendingLocate_ = command;
                locatePending_ = true;
                duckActive_ = true;
                duckRemaining_ = options_.fadeFrames;
            }
        }
    }

    drainParams();

    const bool playing = playing_.load(std::memory_order_acquire);
    if (src_ == nullptr) {
        // After this block's transport command: the input block lines up with
        // the output block rendered from the current playhead in this same
        // callback, so a start captures from its first block.
        const std::int64_t stamp = playhead_.load(std::memory_order_relaxed);
        if (recorder_ != nullptr) {
            recorder_->capture(input, stamp, playing);
        }
        if (bank_) {
            bank_->process(input, stamp, playing);
        }
    }
    if (src_ != nullptr) {
        processResampled(input, output, playing);
    } else {
        const int chunk = current_ != nullptr ? current_->maxBlockFrames() : output.frames;
        for (int offset = 0; offset < output.frames; offset += chunk) {
            renderBlock(output, offset, std::min(chunk, output.frames - offset), playing);
        }
    }

    if (duckActive_ && duckRemaining_ == 0) {
        const bool swapped = next_.graph != nullptr;
        if (swapped) {
            const Handoff old{current_, currentEpoch_, currentFamily_};
            const bool recompiled = next_.graph->recompiledFrom() == current_;
            current_ = next_.graph;
            currentEpoch_ = next_.epoch;
            currentFamily_ = next_.family;
            next_ = {};
            replayLocate();
            if (recompiled) {
                // Hold the affected edges at zero until the rebuilt delay
                // lines are full, then raise them (EdgeRamp: remaining above
                // the fade holds). A hold or rise still running from an
                // earlier recompile carries over: its delay lines are shared
                // with this graph and may still be filling. Merged before the
                // old graph (which owns pathEdges_) goes to the butler.
                const std::int64_t settle = std::min<std::int64_t>(current_->settleFrames(), INT_MAX / 2);
                const std::span<const std::uint8_t> carried =
                    pathRise_ > 0 ? pathEdges_ : std::span<const std::uint8_t>{};
                pathEdges_ = current_->holdEdges(carried);
                pathRise_ = std::max(static_cast<int>(settle) + options_.fadeFrames, pathRise_);
            } else {
                pathEdges_ = {};
                pathRise_ = 0;  // a new graph rises as a whole
            }
            if (!retireOutbox_.push(old)) {
                unsentRetire_ = old;
                retirePending_ = true;
            }
        } else if (locatePending_) {
            applyLocate(pendingLocate_);
            locatePending_ = false;
        }
        duckActive_ = false;
        if (pathDuck_) {
            pathDuck_ = false;  // the output itself was not ramped
        } else {
            riseRemaining_ = options_.fadeFrames;
        }
    }
}

void GraphDriver::drainParams() noexcept {
    // Older epochs are dropped, the current epoch applies, and the first change
    // for a newer epoch waits until that graph has been swapped in. A latency
    // recompile keeps the slots of its family's epoch, so changes for that
    // epoch apply to it too.
    for (;;) {
        ParamChange change;
        if (paramHeld_) {
            change = heldParam_;
        } else if (!paramInbox_.pop(change)) {
            return;
        }
        if (change.epoch > currentEpoch_) {
            heldParam_ = change;
            paramHeld_ = true;
            return;
        }
        paramHeld_ = false;
        if ((change.epoch == currentEpoch_ || change.epoch == currentFamily_) && current_ != nullptr) {
            current_->setParameter(change.slot, change.paramId, change.value, change.rampFrames);
        }
    }
}

void GraphDriver::pushMeters(std::int64_t position, int frames) noexcept {
    detail::MeterFrame& frame = meterOutbox_.back();
    frame.epoch = currentEpoch_;
    frame.blockStart = position;
    frame.frames = frames;
    frame.count = 0;
    std::uint64_t dropped = 0;
    for (const graph::NodeId slot : current_->meteredNodes()) {
        if (frame.count < frame.entries.size()) {
            frame.entries[frame.count++] = detail::MeterFrame::Entry{slot, current_->meterReading(slot)};
        } else {
            ++dropped;  // full: drop, never wait
        }
    }
    if (meterOutbox_.publish()) {
        dropped += meterOutbox_.back().count;  // the dispatcher never read that frame
    }
    if (dropped != 0) {
        meterDrops_.fetch_add(dropped, std::memory_order_relaxed);
    }
}

void GraphDriver::processResampled(const host::AudioBufferView& input, const host::AudioBufferView& output,
                                   bool playing) noexcept {
    SrcPath& s = *src_;
    if ((recorder_ != nullptr || bank_) && s.input != nullptr && input.channelCount >= s.input->channels()) {
        // Session frame m of the input resampler is device input time
        // m * deviceRate / sessionRate; the output path played timeline position
        // m + base there. Stamped as the playhead would be with that latency.
        // base is taken now, before this callback renders: after a stop or a
        // locate it is the base the blocks rendered from here on will use.
        const std::int64_t base = playhead_.load(std::memory_order_relaxed) - (s.fed + s.block);
        const int channels = s.input->channels();
        for (int offset = 0; offset < input.frames; offset += s.maxInputFrames) {
            const int n = std::min(s.maxInputFrames, input.frames - offset);
            for (int c = 0; c < channels; ++c) {
                s.inputPointers[static_cast<std::size_t>(c)] = input.channel(c) + offset;
            }
            const int produced = s.input->process(s.inputPointers.data(), n, s.inputScratch.pointers.data());
            const std::int64_t stamp = s.inputProduced + base + s.stampLead;
            s.inputProduced += produced;
            const host::AudioBufferView resampled{s.inputScratch.pointers.data(), channels, produced};
            if (recorder_ != nullptr) {
                recorder_->capture(resampled, stamp, playing);
            }
            if (bank_) {
                bank_->process(resampled, stamp, playing);
            }
        }
    }

    // Each step yields at least block * deviceRate / sessionRate - 1 frames
    // once the lookahead is in, so this bound is never reached in practice.
    const std::int64_t maxSteps =
        static_cast<std::int64_t>(output.frames) * s.sessionRate / s.deviceRate / s.block + 3;
    const int channels = std::min(output.channelCount, s.outputChannels);
    std::int64_t steps = 0;
    int written = 0;
    while (written < output.frames) {
        if (s.carryCount > 0) {
            const int n = std::min(s.carryCount, output.frames - written);
            for (int c = 0; c < channels; ++c) {
                const float* from = s.carry.pointers[static_cast<std::size_t>(c)] + s.carryRead;
                std::copy_n(from, n, output.channel(c) + written);
            }
            for (int c = channels; c < output.channelCount; ++c) {
                std::fill_n(output.channel(c) + written, n, 0.0f);
            }
            s.carryRead += n;
            s.carryCount -= n;
            written += n;
            continue;
        }
        if (steps == maxSteps) {
            for (int c = 0; c < output.channelCount; ++c) {
                std::fill_n(output.channel(c) + written, output.frames - written, 0.0f);
            }
            srcUnderruns_.fetch_add(static_cast<std::uint64_t>(output.frames - written), std::memory_order_relaxed);
            break;
        }
        srcStep(playing);
        ++steps;
    }
}

void GraphDriver::srcStep(bool playing) noexcept {
    SrcPath& s = *src_;
    const int fresh = s.head ^ 1;
    const host::AudioBufferView view{s.slots[fresh].pointers.data(), s.outputChannels, s.block};
    const int chunk = current_ != nullptr ? std::min(current_->maxBlockFrames(), s.block) : s.block;
    for (int offset = 0; offset < s.block; offset += chunk) {
        renderBlock(view, offset, std::min(chunk, s.block - offset), playing);
    }
    s.carryCount = s.output->process(s.slots[s.head].pointers.data(), s.block, s.carry.pointers.data());
    s.carryRead = 0;
    s.fed += s.block;
    s.head = fresh;
}

void GraphDriver::renderBlock(const host::AudioBufferView& output, int offset, int frames, bool playing) noexcept {
    // Cycle: a block that reaches the right locator renders up to it, wraps,
    // and renders the rest from the left locator (spec, "Cycle").
    while (frames > 0) {
        const std::int64_t position = playhead_.load(std::memory_order_relaxed);
        // While a recording captures, the wrap is suspended (m5b-engine-record).
        const bool wraps = playing && current_ != nullptr && cycle_.enabled && cycle_.left < cycle_.right &&
                           position < cycle_.right && position + frames >= cycle_.right &&
                           !captureActive_.load(std::memory_order_acquire);
        const int span = wraps ? static_cast<int>(cycle_.right - position) : frames;
        renderSpan(output, offset, span, playing);
        if (wraps) {
            wrapToLeft();
        }
        offset += span;
        frames -= span;
    }
}

void GraphDriver::wrapToLeft() noexcept {
    // A locate of the armed generation without a duck: the streams claim the
    // slot the butler prefilled from the left locator. A generation already
    // applied (the next wrap not armed in time) still moves the playhead; the
    // streams then count underruns as after a late locate.
    playhead_.store(cycle_.left, std::memory_order_release);
    if (cycle_.generation > appliedLocate_.load(std::memory_order_relaxed)) {
        lastLocate_ = TransportCommand{cycle_.generation, cycle_.left, false};
        if (current_ != nullptr) {
            current_->locate(cycle_.generation, cycle_.left);
        }
        appliedLocate_.store(cycle_.generation, std::memory_order_release);
    }
    cycleWraps_.fetch_add(1, std::memory_order_relaxed);
}

void GraphDriver::addClick(const host::AudioBufferView& output, int offset, int frames,
                           std::int64_t position) noexcept {
    const bool on = clickEnabled_.load(std::memory_order_acquire);
    if (!on || clickTempo_ == nullptr || clickSound_.normal.empty()) {
        clickCursor_ = -1;
        clickBurst_ = clickSound_.normal.size();
        return;
    }
    if (position != clickCursor_) {
        // Started, located, wrapped or a new tempo table: find the next beat.
        clickBeat_ = clickTempo_->firstBeatAtOrAfter(position);
        clickBeatFrame_ = clickTempo_->beatFrame(clickBeat_);
    }
    const float gain = clickGain_.load(std::memory_order_relaxed);
    const std::size_t length = clickSound_.normal.size();
    for (int i = 0; i < frames; ++i) {
        if (position + i == clickBeatFrame_) {
            clickBurst_ = 0;
            clickAccent_ = clickBeat_ % 4 == 0;
            ++clickBeat_;
            clickBeatFrame_ = clickTempo_->beatFrame(clickBeat_);
        }
        if (clickBurst_ < length) {
            const float v = (clickAccent_ ? clickSound_.accent : clickSound_.normal)[clickBurst_] * gain;
            ++clickBurst_;
            for (int c = 0; c < output.channelCount; ++c) {
                output.channel(c)[offset + i] += v;
            }
        }
    }
    clickCursor_ = position + frames;
}

void GraphDriver::renderSpan(const host::AudioBufferView& output, int offset, int frames, bool playing) noexcept {
    const std::int64_t position = playhead_.load(std::memory_order_relaxed);
    const host::AudioBufferView* source = nullptr;
    // Path ramps run inside the graph on the affected edges only: the duck in
    // the old graph (with the recompiled graph's mask; the edges are the same)
    // and, after the swap, the hold and rise in the new one. A later locate,
    // recompile or structural publish may duck the whole output on top of a
    // path rise (which keeps counting down meanwhile).
    graph::EdgeRamp ramp;
    ramp.fadeFrames = options_.fadeFrames;
    if (pathDuck_) {
        ramp.edges = next_.graph->rampedEdges();
        ramp.remaining = duckRemaining_;
    } else if (pathRise_ > 0 && current_ != nullptr) {
        ramp.edges = pathEdges_;
        ramp.remaining = pathRise_;
        ramp.rising = true;
    }
    if (current_ != nullptr && playing) {
        current_->process(graph::ProcessContext{position, frames}, ramp);
        pushMeters(position, frames);
        source = &current_->output();
        playhead_.store(position + frames, std::memory_order_release);
    }
    if (pathDuck_) {
        duckRemaining_ = std::max(duckRemaining_ - frames, 0);
    } else if (pathRise_ > 0) {
        pathRise_ = std::max(pathRise_ - frames, 0);
    }
    const float fade = static_cast<float>(options_.fadeFrames);
    for (int i = 0; i < frames; ++i) {
        float gain = 1.0f;
        if (pathDuck_) {
            // the output is not scaled during a path duck
        } else if (duckActive_) {
            gain = duckRemaining_ > 0 ? static_cast<float>(duckRemaining_) / fade : 0.0f;
            if (duckRemaining_ > 0) {
                --duckRemaining_;
            }
        } else if (riseRemaining_ > 0) {
            gain = 1.0f - static_cast<float>(riseRemaining_) / fade;
            --riseRemaining_;
        }
        for (int c = 0; c < output.channelCount; ++c) {
            float v = 0.0f;
            if (source != nullptr && c < source->channelCount) {
                v = source->channel(c)[i] * gain;
            }
            output.channel(c)[offset + i] = v;
        }
    }
    // After the graph's output and its meters, before device-side SRC; only
    // while the graph plays.
    if (source != nullptr) {
        addClick(output, offset, frames, position);
    }
}

}  // namespace siann::realtime
