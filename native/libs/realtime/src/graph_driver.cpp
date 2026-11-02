#include "siann/realtime/graph_driver.hpp"

#include <algorithm>
#include <climits>
#include <stdexcept>

#include "siann/realtime/recorder.hpp"

namespace siann::realtime {

namespace {
// Every meterOutbox buffer gets its entries here, on the control side.
detail::MeterFrame emptyMeterFrame(std::size_t capacity) {
    detail::MeterFrame frame;
    frame.entries.resize(capacity);
    return frame;
}
}  // namespace

GraphDriver::GraphDriver(Options options) : options_(options), meterOutbox_(emptyMeterFrame(options.meterCapacity)) {
    if (options_.fadeFrames <= 0) {
        throw std::invalid_argument("fadeFrames must be positive");
    }
}

GraphDriver::~GraphDriver() {
    if (state_ == DriverState::realtime) {
        stop();
    }
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
    deviceStatus_ = device.open(config);
    deviceLost_.store(false, std::memory_order_release);
    device.setOnStopped([this](bool) { deviceLost_.store(true, std::memory_order_release); });
    device_ = &device;
    state_ = DriverState::realtime;
    // The live graph is already in current_; starting the device thread
    // publishes it to the callback.
    device.start([this](const host::AudioBufferView& in, const host::AudioBufferView& out) { process(in, out); });
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
    if (state_ == DriverState::stopped) {
        drainParams();  // nobody else drives the graph; apply changes here
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
    appliedLocate_.store(command.generation, std::memory_order_release);
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
    riseRemaining_ = options_.fadeFrames;
    pathRise_ = 0;
    pathEdges_ = {};
    if (old != 0 && old != epoch) {
        retire(old);
    }
}

void GraphDriver::retire(std::uint64_t epoch) {
    owned_.erase(epoch);
    families_.erase(epoch);
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
    if (waiting_) {
        const std::uint64_t epoch = *waiting_;
        waiting_.reset();
        installDirectly(epoch);
    }
}

// ---- audio thread ----------------------------------------------------------

void GraphDriver::process(const host::AudioBufferView& input, const host::AudioBufferView& output) noexcept {
    if (recorder_ != nullptr) {
        // The input block lines up with the output block rendered from the
        // current playhead in this same callback.
        recorder_->capture(input, playhead_.load(std::memory_order_relaxed), playing_.load(std::memory_order_acquire));
    }
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

    const int chunk = current_ != nullptr ? current_->maxBlockFrames() : output.frames;
    for (int offset = 0; offset < output.frames; offset += chunk) {
        renderBlock(output, offset, std::min(chunk, output.frames - offset));
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

void GraphDriver::renderBlock(const host::AudioBufferView& output, int offset, int frames) noexcept {
    const bool playing = playing_.load(std::memory_order_acquire);
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
}

}  // namespace siann::realtime
