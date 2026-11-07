#include "siann/host/clap_plugin_host.hpp"

#include <clap/clap.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <limits>
#include <map>
#include <set>
#include <span>
#include <system_error>
#include <thread>
#include <utility>

#include "clap_library.hpp"
#include "siann/host/state_envelope.hpp"

namespace fs = std::filesystem;

namespace siann::host {

namespace {

// As JucePluginHost, so that a plugin loads or fails alike in both.
constexpr std::uint32_t maxPluginChannels = 31;

// Events one block carries beside one per parameter. Past it, the newest value of a
// parameter left over goes at offset 0 of the next block instead (spec, "Precision
// contract").
constexpr std::size_t maxBlockEvents = 1024;

// Told nothing by the driver, blocks count as coming while the last one is this
// recent, or four block periods if those are longer.
constexpr std::int64_t minimumAudioWindowNanos = 50'000'000;

constexpr const char* hostName = "SIANN";
constexpr const char* hostVersion = "0.1.0";

// Plugins ask this during calls CLAP calls [audio-thread], which is symbolic: the
// main thread is one too, while it holds the audio thread out.
thread_local int tAudioScope = 0;

class AudioScope {
public:
    AudioScope() noexcept { ++tAudioScope; }
    ~AudioScope() { --tAudioScope; }
    AudioScope(const AudioScope&) = delete;
    AudioScope& operator=(const AudioScope&) = delete;
};

std::int64_t nowNanos() noexcept {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

class ClapInstance;

// What a host and its instances share, so an instance may outlive the host.
struct HostShared {
    std::thread::id mainThread = std::this_thread::get_id();
    std::vector<ClapInstance*> instances;
    std::vector<std::unique_ptr<std::function<void()>>> wakeHandlers;
    std::atomic<const std::function<void()>*> wakeHandler{nullptr};

    void wake() const noexcept {
        const auto* handler = wakeHandler.load(std::memory_order_acquire);
        if (handler != nullptr && *handler) {
            (*handler)();
        }
    }
};

class ClapInstance final : public PluginInstance, private PluginControl {
public:
    using EventSink = std::function<void(const PluginEvent&)>;

    ClapInstance(std::shared_ptr<HostShared> shared, std::shared_ptr<ClapLibrary> library, std::string uid,
                 std::int64_t sampleRate, int maxBlockFrames)
        : library_(std::move(library)), shared_(std::move(shared)), uid_(std::move(uid)),
          sampleRate_(static_cast<double>(sampleRate)), maxBlockFrames_(maxBlockFrames) {
        host_.clap_version = CLAP_VERSION;
        host_.host_data = this;
        host_.name = hostName;
        host_.vendor = hostName;
        host_.url = "";
        host_.version = hostVersion;
        host_.get_extension = hostGetExtension;
        host_.request_restart = hostRequestRestart;
        host_.request_process = hostRequestProcess;
        host_.request_callback = hostRequestCallback;
        inputEvents_.ctx = this;
        inputEvents_.size = inputEventsSize;
        inputEvents_.get = inputEventsGet;
        outputEvents_.ctx = this;
        outputEvents_.try_push = outputEventsTryPush;

        const clap_plugin_factory_t* factory = library_->factory();
        plugin_ = factory->create_plugin(factory, &host_, uid_.c_str());
        if (plugin_ == nullptr) {
            throw PluginError("plugin_load_failed", uid_ + " was not created");
        }
        try {
            if (!plugin_->init(plugin_)) {
                throw PluginError("plugin_load_failed", uid_ + " did not initialise");
            }
            readExtensions();
            readAudioPorts();
            loadParameters();
            if (!activate()) {
                throw PluginError("plugin_load_failed", uid_ + " did not activate");
            }
            readLatency();
            readTail();
        } catch (...) {
            plugin_->destroy(plugin_);
            throw;
        }
        audioWindowNanos_ = std::max(
            minimumAudioWindowNanos, static_cast<std::int64_t>(4.0e9 * maxBlockFrames_ / std::max(sampleRate_, 1.0)));
        shared_->instances.push_back(this);
    }

    ~ClapInstance() override {
        auto& instances = shared_->instances;
        instances.erase(std::remove(instances.begin(), instances.end(), this), instances.end());
        deactivate();
        plugin_->destroy(plugin_);
    }

    PluginCapabilities capabilities() const override { return capabilities_; }

    int latencyFrames() const override { return latencyFrames_.load(std::memory_order_relaxed); }

    int tailFrames() const override { return tailFrames_.load(std::memory_order_relaxed); }

    void process(const AudioBufferView& input, const AudioBufferView& output, EventList events) noexcept override {
        const int frames = output.frames;
        if (frames <= 0 || frames > maxBlockFrames_) {
            output.clear();
            return;
        }
        // ProcessingPause holds the other half of this. Skipped, the block passes its
        // input through. SIANN takes no lock here.
        processing_.store(true);
        if (paused_.load() == 0 && active_) {
            const AudioScope scope;
            if (!started_) {
                started_ = plugin_->start_processing(plugin_);
            }
            if (started_) {
                // Only blocks that reach the plugin count for the guess: they deliver.
                lastBlockNanos_.store(nowNanos(), std::memory_order_relaxed);
                blocksStarted_.fetch_add(1);  // before the block takes any value
                runPlugin(input, output, events, frames);
                blocksRun_.fetch_add(1);
            } else {
                passThrough(input, output, frames);
            }
        } else {
            passThrough(input, output, frames);
        }
        processCalls_.fetch_add(1);
        processing_.store(false);
    }

    void setBlocksComing(bool coming) override {
        blocksComingSaid_.store(coming ? 1 : 0);
        if (!coming && flushRequested_.load()) {
            shared_->wake();  // nothing else will deliver it now
        }
    }

    PluginControl& control() override { return *this; }

    // Main thread: what the plugin asked for since the last call.
    void serviceMainThread() {
        if (callbackRequested_.exchange(false)) {
            plugin_->on_main_thread(plugin_);
        }
        // While blocks are coming the next one delivers this; a pause would drop it dry.
        if (flushRequested_.load() && !blocksComing()) {
            const ProcessingPause pause(*this);
            flush();
        }
        if (restartRequested_.exchange(false)) {
            restart();
        }
        if (tailStale_.exchange(false)) {
            readTail();
        }
    }

private:
    struct ParameterSlot {
        clap_id id = CLAP_INVALID_ID;
        void* cookie = nullptr;
        double minimum = 0.0;
        double maximum = 1.0;
        bool stepped = false;
        // Normalized. The latest value anyone knows of: main thread, audio thread and
        // plugin all write it.
        std::atomic<double> value{0.0};
        std::atomic<bool> dirty{false};  // the plugin has not been told yet

        double plain(double normalized) const noexcept {
            const double exact = minimum + normalized * (maximum - minimum);
            return stepped ? std::round(exact) : exact;
        }

        double normalized(double plainValue) const noexcept {
            return maximum > minimum ? std::clamp((plainValue - minimum) / (maximum - minimum), 0.0, 1.0) : 0.0;
        }
    };

    // Holds the plugin out of processing: the block in flight finishes, and until
    // this goes process() skips the plugin, so this thread may make the plugin's
    // [audio-thread] calls and touch what process() owns. Only this side ever waits. A
    // count, not a flag, so a pause inside a pause ends when the outer one does. Both
    // atomics stay sequentially consistent, or each side could miss the other's store.
    class ProcessingPause {
    public:
        explicit ProcessingPause(ClapInstance& instance) : instance_(instance) {
            instance_.paused_.fetch_add(1);
            while (instance_.processing_.load()) {
                std::this_thread::yield();
            }
        }
        ~ProcessingPause() { instance_.paused_.fetch_sub(1); }
        ProcessingPause(const ProcessingPause&) = delete;
        ProcessingPause& operator=(const ProcessingPause&) = delete;

    private:
        ClapInstance& instance_;
        AudioScope scope_;
    };

    // --- what the plugin calls

    static ClapInstance& from(const clap_host_t* host) { return *static_cast<ClapInstance*>(host->host_data); }

    static const void* hostGetExtension(const clap_host_t*, const char* id) {
        static constexpr clap_host_thread_check_t threadCheck = {hostIsMainThread, hostIsAudioThread};
        static constexpr clap_host_latency_t latency = {hostLatencyChanged};
        static constexpr clap_host_tail_t tail = {hostTailChanged};
        static constexpr clap_host_params_t params = {hostParamsRescan, hostParamsClear, hostParamsRequestFlush};
        static constexpr clap_host_state_t state = {hostStateMarkDirty};
        if (std::strcmp(id, CLAP_EXT_THREAD_CHECK) == 0) {
            return &threadCheck;
        }
        if (std::strcmp(id, CLAP_EXT_LATENCY) == 0) {
            return &latency;
        }
        if (std::strcmp(id, CLAP_EXT_TAIL) == 0) {
            return &tail;
        }
        if (std::strcmp(id, CLAP_EXT_PARAMS) == 0) {
            return &params;
        }
        if (std::strcmp(id, CLAP_EXT_STATE) == 0) {
            return &state;
        }
        return nullptr;
    }

    static void hostRequestRestart(const clap_host_t* host) {
        auto& self = from(host);
        self.restartRequested_.store(true);
        self.shared_->wake();
    }

    // Instances process from load to unload, so there is nothing to start.
    static void hostRequestProcess(const clap_host_t*) {}

    static void hostRequestCallback(const clap_host_t* host) {
        auto& self = from(host);
        self.callbackRequested_.store(true);
        self.shared_->wake();
    }

    static bool hostIsMainThread(const clap_host_t* host) {
        return std::this_thread::get_id() == from(host).shared_->mainThread;
    }

    static bool hostIsAudioThread(const clap_host_t*) { return tAudioScope > 0; }

    // Read after activate, where the plugin is meant to call this. A plugin that
    // calls it while active gets what it needs for the new latency to count.
    static void hostLatencyChanged(const clap_host_t* host) {
        auto& self = from(host);
        if (!self.activating_) {
            self.restartRequested_.store(true);
            self.shared_->wake();
        }
    }

    static void hostTailChanged(const clap_host_t* host) {
        auto& self = from(host);
        self.tailStale_.store(true);
        self.shared_->wake();
    }

    // New infos need nothing here: parameters() always asks. RESCAN_ALL is legal only
    // deactivated, and restart() rebuilds the table after every deactivation.
    static void hostParamsRescan(const clap_host_t* host, clap_param_rescan_flags flags) {
        auto& self = from(host);
        if ((flags & (CLAP_PARAM_RESCAN_VALUES | CLAP_PARAM_RESCAN_ALL)) != 0) {
            self.refreshValues();
        }
        PluginEvent event;
        event.kind = PluginEvent::Kind::restartRequested;
        self.emit(event);
    }

    // Nothing keeps a reference to a parameter yet: automation is the graph's.
    static void hostParamsClear(const clap_host_t*, clap_id, clap_param_clear_flags) {}

    static void hostParamsRequestFlush(const clap_host_t* host) {
        auto& self = from(host);
        self.flushRequested_.store(true);
        self.shared_->wake();
    }

    // Nothing to do: the session asks for state when it saves.
    static void hostStateMarkDirty(const clap_host_t*) {}

    static std::uint32_t inputEventsSize(const clap_input_events_t* list) {
        return static_cast<ClapInstance*>(list->ctx)->eventCount_;
    }

    static const clap_event_header_t* inputEventsGet(const clap_input_events_t* list, std::uint32_t index) {
        const auto& self = *static_cast<ClapInstance*>(list->ctx);
        return index < self.eventCount_ ? &self.events_[index].header : nullptr;
    }

    static bool outputEventsTryPush(const clap_output_events_t* list, const clap_event_header_t* event) {
        static_cast<ClapInstance*>(list->ctx)->pluginEvent(*event);
        return true;
    }

    // --- the plugin's extensions

    template <typename T>
    const T* extension(const char* id) const {
        return static_cast<const T*>(plugin_->get_extension(plugin_, id));
    }

    void readExtensions() {
        params_ = extension<clap_plugin_params_t>(CLAP_EXT_PARAMS);
        latency_ = extension<clap_plugin_latency_t>(CLAP_EXT_LATENCY);
        tail_ = extension<clap_plugin_tail_t>(CLAP_EXT_TAIL);
        state_ = extension<clap_plugin_state_t>(CLAP_EXT_STATE);
        const auto* notePorts = extension<clap_plugin_note_ports_t>(CLAP_EXT_NOTE_PORTS);
        capabilities_.sampleAccurateParameters = true;  // events carry their offsets
        capabilities_.variableLatency = true;           // any plugin can restart with another
        capabilities_.midiInput = notePorts != nullptr && notePorts->count(plugin_, true) > 0;
        capabilities_.midiOutput = notePorts != nullptr && notePorts->count(plugin_, false) > 0;
        capabilities_.editor = plugin_->get_extension(plugin_, CLAP_EXT_GUI) != nullptr;
    }

    // Buffers for each port, and one flat array of channel pointers behind them. Ports
    // are fixed for the instance: the host offers no way to rescan them.
    void readPorts(bool isInput, std::vector<clap_audio_buffer_t>& buffers, std::vector<float*>& pointers) const {
        const auto* ports = extension<clap_plugin_audio_ports_t>(CLAP_EXT_AUDIO_PORTS);
        const std::uint32_t count = ports == nullptr ? 0 : ports->count(plugin_, isInput);
        std::uint32_t channels = 0;
        std::vector<std::uint32_t> perPort;
        for (std::uint32_t index = 0; index < count; ++index) {
            clap_audio_port_info_t info{};
            if (!ports->get(plugin_, index, isInput, &info)) {
                throw PluginError("plugin_load_failed", uid_ + " did not describe its audio ports");
            }
            if (info.channel_count > maxPluginChannels) {
                throw PluginError("plugin_load_failed", "the plugin has more channels than the host processes");
            }
            perPort.push_back(info.channel_count);
            channels += info.channel_count;
        }
        pointers.assign(channels, nullptr);
        buffers.assign(count, clap_audio_buffer_t{});
        std::uint32_t first = 0;
        for (std::uint32_t index = 0; index < count; ++index) {
            buffers[index].data32 = pointers.data() + first;
            buffers[index].channel_count = perPort[index];
            first += perPort[index];
        }
    }

    void readAudioPorts() {
        readPorts(true, inputBuffers_, inputPointers_);
        readPorts(false, outputBuffers_, outputPointers_);
        capabilities_.sidechain = inputBuffers_.size() > 1;
        const auto frames = static_cast<std::size_t>(maxBlockFrames_);
        inputScratch_.assign(inputPointers_.size() * frames, 0.0f);
        outputScratch_.assign(outputPointers_.size() * frames, 0.0f);
    }

    // The table the audio thread reads, so main thread only and while nothing
    // processes: instantiate, or under a pause.
    void loadParameters() {
        const std::uint32_t count = params_ == nullptr ? 0 : params_->count(plugin_);
        slots_ = std::make_unique<ParameterSlot[]>(count);
        slotCount_ = count;
        slotsById_.clear();
        slotsById_.reserve(count);
        for (std::uint32_t i = 0; i < count; ++i) {
            clap_param_info_t info{};
            if (!params_->get_info(plugin_, i, &info)) {
                continue;
            }
            auto& slot = slots_[i];
            slot.id = info.id;
            slot.cookie = info.cookie;
            slot.minimum = info.min_value;
            slot.maximum = info.max_value;
            slot.stepped = (info.flags & CLAP_PARAM_IS_STEPPED) != 0;
            slotsById_.emplace_back(info.id, i);
        }
        std::sort(slotsById_.begin(), slotsById_.end());
        events_.resize(count + maxBlockEvents);
        refreshValues();
    }

    // Main thread. A value still on its way to the plugin stays what it is.
    void refreshValues() {
        for (std::uint32_t i = 0; i < slotCount_; ++i) {
            auto& slot = slots_[i];
            double plain = 0.0;
            if (!slot.dirty.load() && params_->get_value(plugin_, slot.id, &plain)) {
                slot.value.store(slot.normalized(plain), std::memory_order_relaxed);
            }
        }
    }

    ParameterSlot* slotOf(clap_id id) noexcept {
        const auto found = std::lower_bound(slotsById_.begin(), slotsById_.end(), std::make_pair(id, std::uint32_t{0}));
        return found == slotsById_.end() || found->first != id ? nullptr : &slots_[found->second];
    }

    // --- activation

    // Main thread, with nothing processing.
    bool activate() {
        activating_ = true;
        active_ = plugin_->activate(plugin_, sampleRate_, 1, static_cast<std::uint32_t>(maxBlockFrames_));
        activating_ = false;
        return active_;
    }

    // The same. process() starts the plugin again, on the audio thread.
    void deactivate() {
        if (started_) {
            const AudioScope scope;
            plugin_->stop_processing(plugin_);
            started_ = false;
        }
        if (active_) {
            plugin_->deactivate(plugin_);
            active_ = false;
        }
    }

    // What makes a new latency count: CLAP lets it change only in activate. Input
    // passes through until the plugin is back.
    void restart() {
        const int before = latencyFrames_.load(std::memory_order_relaxed);
        {
            const ProcessingPause pause(*this);
            flush();
            deactivate();
            activate();
            loadParameters();
            if (active_) {
                readLatency();
                readTail();
            }
        }
        if (latencyFrames_.load(std::memory_order_relaxed) != before) {
            PluginEvent event;
            event.kind = PluginEvent::Kind::latencyChanged;
            event.latencyFrames = latencyFrames_.load(std::memory_order_relaxed);
            emit(event);
        }
        PluginEvent event;
        event.kind = PluginEvent::Kind::restartRequested;
        emit(event);
    }

    // Main thread, the plugin active.
    void readLatency() {
        const std::uint32_t frames = latency_ == nullptr ? 0 : latency_->get(plugin_);
        latencyFrames_.store(static_cast<int>(std::min<std::uint32_t>(frames, std::numeric_limits<int>::max())),
                             std::memory_order_relaxed);
    }

    void readTail() {
        const std::uint32_t frames = tail_ == nullptr ? 0 : tail_->get(plugin_);
        tailFrames_.store(static_cast<int>(std::min<std::uint32_t>(frames, std::numeric_limits<int>::max())),
                          std::memory_order_relaxed);
    }

    // The driver's word, or, told nothing, a guess from the last block that reached
    // the plugin: a stall past the window looks like a stop.
    bool blocksComing() const noexcept {
        const int said = blocksComingSaid_.load();
        if (said >= 0) {
            return said == 1;
        }
        const std::int64_t last = lastBlockNanos_.load(std::memory_order_relaxed);
        return last != 0 && nowNanos() - last < audioWindowNanos_;
    }

    bool valuesPending() const noexcept { return flushRequested_.load() || anyDirty_.load(); }

    // --- events

    void pushEvent(std::uint32_t time, const ParameterSlot& slot, double normalized) noexcept {
        clap_event_param_value_t event{};
        event.header.size = sizeof(event);
        event.header.time = time;
        event.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
        event.header.type = CLAP_EVENT_PARAM_VALUE;
        event.param_id = slot.id;
        event.cookie = slot.cookie;
        event.note_id = -1;
        event.port_index = -1;
        event.channel = -1;
        event.key = -1;
        event.value = slot.plain(normalized);
        // CLAP wants them sorted. A caller's list usually is, and this does nothing.
        std::uint32_t at = eventCount_++;
        for (; at > 0 && events_[at - 1].header.time > time; --at) {
            events_[at] = events_[at - 1];
        }
        events_[at] = event;
    }

    // Whoever calls this owns the events: the audio thread, or the main thread under
    // a pause. Values the main thread set go first, at offset 0.
    void collectEvents(EventList blockEvents, int frames) noexcept {
        eventCount_ = 0;
        if (anyDirty_.exchange(false)) {
            for (std::uint32_t i = 0; i < slotCount_; ++i) {
                auto& slot = slots_[i];
                if (slot.dirty.exchange(false) && slot.id != CLAP_INVALID_ID) {
                    pushEvent(0, slot, slot.value.load(std::memory_order_relaxed));
                }
            }
        }
        const std::uint32_t firstBlockEvent = eventCount_;
        for (const BlockEvent& event : blockEvents) {
            if (event.kind != BlockEventKind::parameterValue || event.data0 >= slotCount_) {
                continue;
            }
            auto& slot = slots_[event.data0];
            if (slot.id == CLAP_INVALID_ID) {
                continue;  // the plugin did not describe it: no event can name it
            }
            const double value = std::clamp(event.value, 0.0, 1.0);
            if (eventCount_ == events_.size()) {
                slot.value.store(value, std::memory_order_relaxed);
                slot.dirty.store(true);
                anyDirty_.store(true);
                continue;
            }
            pushEvent(static_cast<std::uint32_t>(std::clamp(event.sampleOffset, 0, frames - 1)), slot, value);
        }
        // In time order: the control side reads what the block ended on, unless a
        // newer value waits for the next block (one left over above).
        for (std::uint32_t i = firstBlockEvent; i < eventCount_; ++i) {
            ParameterSlot* slot = slotOf(events_[i].param_id);
            if (!slot->dirty.load()) {
                slot->value.store(slot->normalized(events_[i].value), std::memory_order_relaxed);
            }
        }
    }

    // From the plugin, in process() or flush: what it says goes to the sink at once.
    void pluginEvent(const clap_event_header_t& header) noexcept {
        if (header.space_id != CLAP_CORE_EVENT_SPACE_ID || header.type != CLAP_EVENT_PARAM_VALUE) {
            return;
        }
        const auto& edit = reinterpret_cast<const clap_event_param_value_t&>(header);
        ParameterSlot* slot = slotOf(edit.param_id);
        if (slot == nullptr) {
            return;
        }
        const double value = slot->normalized(edit.value);
        slot->value.store(value, std::memory_order_relaxed);
        PluginEvent event;
        event.kind = PluginEvent::Kind::parameterEdited;
        event.parameterIndex = static_cast<int>(slot - slots_.get());
        event.value = value;
        emit(event);
    }

    // Under a pause. The plugin's [audio-thread] call for what process() would do.
    void flush() {
        flushRequested_.store(false);
        if (params_ != nullptr && active_) {
            collectEvents({}, 1);
            params_->flush(plugin_, &inputEvents_, &outputEvents_);
        }
    }

    // --- audio

    void passThrough(const AudioBufferView& input, const AudioBufferView& output, int frames) const noexcept {
        const auto bytes = static_cast<std::size_t>(frames) * sizeof(float);
        for (int c = 0; c < output.channelCount; ++c) {
            const float* source = c < input.channelCount ? input.channels[c] : nullptr;
            if (source == nullptr) {
                std::memset(output.channels[c], 0, bytes);
            } else if (source != output.channels[c]) {
                std::memcpy(output.channels[c], source, bytes);
            }
        }
    }

    bool isOutputChannel(const float* channel) const noexcept {
        return std::find(outputPointers_.begin(), outputPointers_.end(), channel) != outputPointers_.end();
    }

    void runPlugin(const AudioBufferView& input, const AudioBufferView& output, EventList events, int frames) noexcept {
        const auto stride = static_cast<std::size_t>(maxBlockFrames_);
        const auto bytes = static_cast<std::size_t>(frames) * sizeof(float);
        // Channels of the plugin the view does not have run on scratch.
        for (std::size_t c = 0; c < outputPointers_.size(); ++c) {
            outputPointers_[c] = static_cast<int>(c) < output.channelCount ? output.channels[c]
                                                                           : outputScratch_.data() + c * stride;
        }
        for (std::size_t c = 0; c < inputPointers_.size(); ++c) {
            float* source = static_cast<int>(c) < input.channelCount ? input.channels[c] : nullptr;
            float* scratch = inputScratch_.data() + c * stride;
            if (source == nullptr) {
                std::memset(scratch, 0, bytes);
                inputPointers_[c] = scratch;
            } else if (isOutputChannel(source)) {
                std::memcpy(scratch, source, bytes);  // a plugin may write output before it reads input
                inputPointers_[c] = scratch;
            } else {
                inputPointers_[c] = source;
            }
        }

        flushRequested_.store(false);  // this block is the flush; after the store, so a later request stays
        collectEvents(events, frames);

        clap_process_t block{};
        block.steady_time = steadyTime_;
        block.frames_count = static_cast<std::uint32_t>(frames);
        block.audio_inputs = inputBuffers_.data();
        block.audio_outputs = outputBuffers_.data();
        block.audio_inputs_count = static_cast<std::uint32_t>(inputBuffers_.size());
        block.audio_outputs_count = static_cast<std::uint32_t>(outputBuffers_.size());
        block.in_events = &inputEvents_;
        block.out_events = &outputEvents_;
        const clap_process_status status = plugin_->process(plugin_, &block);
        steadyTime_ += frames;
        if (status == CLAP_PROCESS_ERROR) {
            output.clear();
            return;
        }
        for (int c = static_cast<int>(outputPointers_.size()); c < output.channelCount; ++c) {
            std::memset(output.channels[c], 0, bytes);
        }
    }

    // Main thread: what setParameter set before this has reached the plugin when it
    // returns, without passing a block dry. While blocks are coming, waits for one to
    // take the values. Values still pending when none is coming, or after a block that
    // began after this call passed by without reaching the plugin, are flushed under a
    // pause. Then waits for a block that took values to finish applying them: the
    // flags clear when a block takes the values, before the plugin sees them.
    void deliverPendingValues() {
        if (valuesPending()) {
            const std::uint64_t calls = processCalls_.load();
            while (valuesPending() && blocksComing() && processCalls_.load() < calls + 2) {
                std::this_thread::yield();
            }
            if (valuesPending()) {
                const ProcessingPause pause(*this);
                flush();
                return;
            }
        }
        // Blocks run one at a time: once blocksRun_ reaches this, the block that took
        // the values, begun before the flags were seen clear, has finished.
        const std::uint64_t started = blocksStarted_.load();
        while (blocksRun_.load() < started) {
            std::this_thread::yield();
        }
    }

    // --- PluginControl

    std::vector<std::uint8_t> getState() override {
        std::vector<std::uint8_t> payload;
        clap_ostream_t stream{};
        stream.ctx = &payload;
        stream.write = [](const clap_ostream_t* self, const void* buffer, std::uint64_t size) -> std::int64_t {
            auto& out = *static_cast<std::vector<std::uint8_t>*>(self->ctx);
            const auto* bytes = static_cast<const std::uint8_t*>(buffer);
            out.insert(out.end(), bytes, bytes + size);
            return static_cast<std::int64_t>(size);
        };
        deliverPendingValues();
        // A main-thread call CLAP lets run while the plugin processes: no pause.
        const bool saved = state_ == nullptr || state_->save(plugin_, &stream);
        if (!saved) {
            throw PluginError("bad_state", uid_ + " did not save its state");
        }
        return wrapPluginState(uid_, payload);
    }

    void setState(const std::vector<std::uint8_t>& state) override {
        auto payload = unwrapPluginState(state, uid_);
        clap_istream_t stream{};
        stream.ctx = &payload;
        stream.read = [](const clap_istream_t* self, void* buffer, std::uint64_t size) -> std::int64_t {
            auto& in = *static_cast<std::span<const std::uint8_t>*>(self->ctx);
            const auto count = static_cast<std::size_t>(std::min<std::uint64_t>(size, in.size()));
            if (count > 0) {
                std::memcpy(buffer, in.data(), count);
            }
            in = in.subspan(count);
            return static_cast<std::int64_t>(count);
        };
        bool loaded = true;
        {
            const ProcessingPause pause(*this);
            flush();  // no value set before this may land after it
            if (state_ != nullptr) {
                loaded = state_->load(plugin_, &stream);
            }
        }
        if (!loaded) {
            throw PluginError("bad_state", uid_ + " refused the state");
        }
        refreshValues();
        readTail();
    }

    std::vector<PluginParameterInfo> parameters() const override {
        std::vector<PluginParameterInfo> result;
        result.reserve(slotCount_);
        for (std::uint32_t i = 0; i < slotCount_; ++i) {
            clap_param_info_t info{};
            PluginParameterInfo parameter;
            if (params_->get_info(plugin_, i, &info)) {
                parameter.id = std::to_string(info.id);
                parameter.name = info.name;
                parameter.defaultValue = slots_[i].normalized(info.default_value);
                parameter.automatable = (info.flags & CLAP_PARAM_IS_AUTOMATABLE) != 0;
            }
            result.push_back(std::move(parameter));
        }
        return result;
    }

    ParameterSlot& slotAt(int index) const {
        if (index < 0 || static_cast<std::uint32_t>(index) >= slotCount_) {
            throw PluginError("bad_parameter", "no parameter " + std::to_string(index));
        }
        return slots_[static_cast<std::size_t>(index)];
    }

    double getParameter(int index) const override { return slotAt(index).value.load(std::memory_order_relaxed); }

    // Never pauses: the next block takes it, or runMainThreadCallbacks when none is coming.
    void setParameter(int index, double value) override {
        auto& slot = slotAt(index);
        slot.value.store(std::clamp(value, 0.0, 1.0), std::memory_order_relaxed);
        slot.dirty.store(true);
        anyDirty_.store(true);
        flushRequested_.store(true);
        shared_->wake();
    }

    void openEditor(EditorOwner) override {
        throw PluginError("editor_failed", "CLAP editors need a window from the desktop target");
    }

    void closeEditor() override {}

    bool editorOpen() const override { return false; }

    std::uintptr_t editorNativeHandle() const override { return 0; }

    void setEventSink(EventSink sink) override {
        // A plugin may be reporting on another thread right now, so the previous
        // sink stays alive until the instance goes; sinks are set rarely.
        sinks_.push_back(std::make_unique<EventSink>(std::move(sink)));
        sink_.store(sinks_.back().get(), std::memory_order_release);
    }

    void emit(const PluginEvent& event) const noexcept {
        const EventSink* sink = sink_.load(std::memory_order_acquire);
        if (sink != nullptr && *sink) {
            (*sink)(event);
        }
    }

    std::shared_ptr<ClapLibrary> library_;  // first in, last out: everything below is its code
    std::shared_ptr<HostShared> shared_;
    std::string uid_;
    double sampleRate_;
    int maxBlockFrames_;
    clap_host_t host_{};
    const clap_plugin_t* plugin_ = nullptr;
    const clap_plugin_params_t* params_ = nullptr;
    const clap_plugin_latency_t* latency_ = nullptr;
    const clap_plugin_tail_t* tail_ = nullptr;
    const clap_plugin_state_t* state_ = nullptr;
    PluginCapabilities capabilities_;

    // What process() owns, which the main thread touches only under a pause.
    bool activating_ = false;
    bool active_ = false;
    bool started_ = false;
    std::int64_t steadyTime_ = 0;
    std::unique_ptr<ParameterSlot[]> slots_;
    std::uint32_t slotCount_ = 0;
    std::vector<std::pair<clap_id, std::uint32_t>> slotsById_;
    std::vector<clap_event_param_value_t> events_;
    std::uint32_t eventCount_ = 0;
    clap_input_events_t inputEvents_{};
    clap_output_events_t outputEvents_{};
    std::vector<clap_audio_buffer_t> inputBuffers_;
    std::vector<clap_audio_buffer_t> outputBuffers_;
    std::vector<float*> inputPointers_;
    std::vector<float*> outputPointers_;
    std::vector<float> inputScratch_;
    std::vector<float> outputScratch_;

    std::vector<std::unique_ptr<EventSink>> sinks_;
    std::atomic<const EventSink*> sink_{nullptr};
    std::atomic<int> latencyFrames_{0};
    std::atomic<int> tailFrames_{0};
    std::atomic<bool> processing_{false};
    std::atomic<int> paused_{0};
    std::atomic<bool> anyDirty_{false};
    std::atomic<bool> callbackRequested_{false};
    std::atomic<bool> restartRequested_{false};
    std::atomic<bool> flushRequested_{false};
    std::atomic<bool> tailStale_{false};
    std::atomic<std::int64_t> lastBlockNanos_{0};
    std::atomic<int> blocksComingSaid_{-1};        // -1 until the driver says, then 0 or 1
    std::atomic<std::uint64_t> processCalls_{0};   // every process() call, counted after
    std::atomic<std::uint64_t> blocksStarted_{0};  // blocks that reached the plugin, counted before
    std::atomic<std::uint64_t> blocksRun_{0};      // the same, counted after
    std::int64_t audioWindowNanos_ = minimumAudioWindowNanos;
};

// For a plugin probed and thrown away: it gets a host, and nothing from it.
const clap_host_t* probeHost() {
    static const clap_host_t host = {
        CLAP_VERSION,
        nullptr,
        hostName,
        hostName,
        "",
        hostVersion,
        [](const clap_host_t*, const char*) -> const void* { return nullptr; },
        [](const clap_host_t*) {},
        [](const clap_host_t*) {},
        [](const clap_host_t*) {},
    };
    return &host;
}

bool probeHasEditor(const clap_plugin_factory_t* factory, const char* id) {
    const clap_plugin_t* plugin = factory->create_plugin(factory, probeHost(), id);
    if (plugin == nullptr) {
        return false;
    }
    const bool hasEditor = plugin->init(plugin) && plugin->get_extension(plugin, CLAP_EXT_GUI) != nullptr;
    plugin->destroy(plugin);
    return hasEditor;
}

std::string environmentValue(const char* name) {
#if defined(_MSC_VER)
    char* value = nullptr;
    std::size_t size = 0;
    if (_dupenv_s(&value, &size, name) != 0 || value == nullptr) {
        return {};
    }
    std::string result(value);
    std::free(value);
    return result;
#else
    const char* value = std::getenv(name);
    return value == nullptr ? std::string() : std::string(value);
#endif
}

std::shared_ptr<ClapLibrary> openPlugin(const std::string& path) {
    const fs::path file = pathFromUtf8(path);
    std::error_code ignored;
    if (!fs::exists(file, ignored)) {
        throw PluginError("plugin_not_found", "no such plugin: " + path);
    }
    if (file.extension() != ".clap") {
        throw PluginError("plugin_load_failed", "not a plugin format this host loads: " + path);
    }
    return ClapLibrary::open(file);
}

// CLAP's standard search path (clap/entry.h), then CLAP_PATH.
std::vector<fs::path> searchDirectories() {
    std::vector<fs::path> directories;
#if defined(_WIN32)
    constexpr char separator = ';';
    if (const auto common = environmentValue("COMMONPROGRAMFILES"); !common.empty()) {
        directories.push_back(fs::path(common) / "CLAP");
    }
    if (const auto local = environmentValue("LOCALAPPDATA"); !local.empty()) {
        directories.push_back(fs::path(local) / "Programs" / "Common" / "CLAP");
    }
#else
    constexpr char separator = ':';
    const auto home = environmentValue("HOME");
#if defined(__APPLE__)
    directories.emplace_back("/Library/Audio/Plug-Ins/CLAP");
    if (!home.empty()) {
        directories.push_back(fs::path(home) / "Library" / "Audio" / "Plug-Ins" / "CLAP");
    }
#else
    if (!home.empty()) {
        directories.push_back(fs::path(home) / ".clap");
    }
    directories.emplace_back("/usr/lib/clap");
#endif
#endif
    const auto extra = environmentValue("CLAP_PATH");
    for (std::size_t begin = 0; begin <= extra.size();) {
        const auto end = std::min(extra.find(separator, begin), extra.size());
        if (end > begin) {
            directories.emplace_back(extra.substr(begin, end - begin));
        }
        begin = end + 1;
    }
    return directories;
}

}  // namespace

struct ClapPluginHost::Impl {
    std::shared_ptr<HostShared> shared = std::make_shared<HostShared>();
    // By uid, the paths known to hold it: a uid is the same at every install.
    std::map<std::string, std::set<std::string>> known;
};

ClapPluginHost::ClapPluginHost() : impl_(std::make_unique<Impl>()) {}
ClapPluginHost::~ClapPluginHost() = default;

std::vector<PluginDescriptor> ClapPluginHost::scan() {
    // Lists without loading: loading a file runs its code in this process, and one
    // plugin that crashes on load would take the engine with it.
    std::vector<PluginDescriptor> result;
    std::set<fs::path> seen;
    for (const auto& directory : searchDirectories()) {
        std::error_code error;
        fs::recursive_directory_iterator walker(directory, fs::directory_options::skip_permission_denied, error);
        for (const fs::recursive_directory_iterator end; !error && walker != end; walker.increment(error)) {
            const fs::path& path = walker->path();
            if (path.extension() != ".clap") {
                continue;
            }
            walker.disable_recursion_pending();  // a macOS bundle is a directory
            if (seen.insert(path).second) {
                PluginDescriptor descriptor;
                descriptor.format = "clap";
                descriptor.path = pathToUtf8(path);
                descriptor.name = pathToUtf8(path.stem());
                result.push_back(std::move(descriptor));
            }
        }
    }
    return result;
}

std::vector<PluginDescriptor> ClapPluginHost::scanPath(const std::string& path) {
    const auto library = openPlugin(path);
    const clap_plugin_factory_t* factory = library->factory();
    std::vector<PluginDescriptor> result;
    const std::uint32_t count = factory->get_plugin_count(factory);
    for (std::uint32_t i = 0; i < count; ++i) {
        const clap_plugin_descriptor_t* found = factory->get_plugin_descriptor(factory, i);
        if (found == nullptr || !clap_version_is_compatible(found->clap_version)) {
            continue;
        }
        PluginDescriptor descriptor;
        descriptor.format = "clap";
        descriptor.uid = found->id;
        descriptor.name = found->name;
        descriptor.vendor = found->vendor == nullptr ? "" : found->vendor;
        descriptor.version = found->version == nullptr ? "" : found->version;
        descriptor.path = path;
        descriptor.hasEditor = probeHasEditor(factory, found->id);
        impl_->known[descriptor.uid].insert(path);
        result.push_back(std::move(descriptor));
    }
    if (result.empty()) {
        throw PluginError("plugin_load_failed", "no plugin in " + path);
    }
    return result;
}

std::unique_ptr<PluginInstance> ClapPluginHost::instantiate(const PluginDescriptor& descriptor, std::int64_t sampleRate,
                                                            int maxBlockFrames) {
    std::string path = descriptor.path;
    if (path.empty()) {
        const auto installs = impl_->known.find(descriptor.uid);
        if (installs == impl_->known.end() || installs->second.size() != 1) {
            throw PluginError("plugin_not_found", "unknown plugin, or more than one install of it: " + descriptor.name);
        }
        path = *installs->second.begin();
    }
    auto library = openPlugin(path);
    const clap_plugin_factory_t* factory = library->factory();
    const std::uint32_t count = factory->get_plugin_count(factory);
    for (std::uint32_t i = 0; i < count; ++i) {
        const clap_plugin_descriptor_t* found = factory->get_plugin_descriptor(factory, i);
        if (found != nullptr && (descriptor.uid.empty() || descriptor.uid == found->id)) {
            return std::make_unique<ClapInstance>(impl_->shared, std::move(library), found->id, sampleRate,
                                                  maxBlockFrames);
        }
    }
    throw PluginError("plugin_not_found", path + " does not hold " + descriptor.uid);
}

void ClapPluginHost::runMainThreadCallbacks() {
    auto& instances = impl_->shared->instances;
    for (std::size_t i = 0; i < instances.size(); ++i) {
        instances[i]->serviceMainThread();
    }
}

void ClapPluginHost::setWakeHandler(std::function<void()> handler) {
    // A plugin may be asking on another thread right now, so the previous handler
    // stays alive with the host's shared part; handlers are set rarely.
    auto& shared = *impl_->shared;
    shared.wakeHandlers.push_back(std::make_unique<std::function<void()>>(std::move(handler)));
    shared.wakeHandler.store(shared.wakeHandlers.back().get(), std::memory_order_release);
}

}  // namespace siann::host
