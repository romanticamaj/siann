#include "siann/engine_app/engine_host.hpp"

#include <algorithm>
#include <exception>
#include <utility>

#include "siann/engine/offline.hpp"
#include "siann/host/clap_plugin_host.hpp"
#include "siann/host/plugin_error.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/playback/plugin_instances.hpp"
#if defined(SIANN_ENGINE_WITH_JUCE)
#include "siann/host/juce_plugin_host.hpp"
#endif

namespace siann::engine_app {

// The engine's plugin hosts: CLAP in every build, JUCE's formats with JUCE.
struct PluginHostSet {
    host::ClapPluginHost clap;
#if defined(SIANN_ENGINE_WITH_JUCE)
    host::JucePluginHost juce;
#endif

    playback::PluginHosts byFormat() {
        playback::PluginHosts hosts{{"clap", &clap}};
#if defined(SIANN_ENGINE_WITH_JUCE)
        hosts.emplace("vst3", &juce);
#if defined(__APPLE__)
        hosts.emplace("au", &juce);
#endif
#endif
        return hosts;
    }
};

namespace {

constexpr int kOutputChannels = 2;
// render.start renders in blocks of 512 (Jobs v0).
constexpr int kRenderBlockFrames = 512;

playback::PlaybackOptions withoutAutoPlay(playback::PlaybackOptions options, PluginHostSet& hosts) {
    options.playOnStart = false;
    options.pluginHosts = hosts.byFormat();
    return options;
}

protocol::PluginCapabilityFlags flagsOf(const host::PluginCapabilities& capabilities) {
    protocol::PluginCapabilityFlags flags;
    flags.sampleAccurateParameters = capabilities.sampleAccurateParameters;
    flags.midiInput = capabilities.midiInput;
    flags.midiOutput = capabilities.midiOutput;
    flags.sidechain = capabilities.sidechain;
    flags.variableLatency = capabilities.variableLatency;
    flags.editor = capabilities.editor;
    return flags;
}

protocol::PluginEditorState editorState(const std::string& slotId, host::PluginInstance& instance) {
    return {slotId, instance.control().editorOpen(), static_cast<std::uint64_t>(instance.control().editorNativeHandle())};
}

// Why a graph could not be built, or nothing when `build` went through. Whatever one
// media file can do to a compile, the engine serves on (Process model, device policy).
template <class Build>
std::optional<protocol::DeviceProblem> graphProblem(Build build) {
    try {
        build();
    } catch (const engine::EngineError& error) {
        return protocol::DeviceProblem{error.code(), error.what()};
    } catch (const media::MediaError& error) {
        return protocol::DeviceProblem{error.code(), error.what()};
    } catch (const std::exception& error) {
        return protocol::DeviceProblem{"load_failed", error.what()};
    }
    return std::nullopt;
}

}  // namespace

EngineHost::EngineHost(session::Session& session, EngineHostOptions options)
    : pluginHosts_(std::make_unique<PluginHostSet>()),
      ownerWindow_(options.ownerWindow),
      session_(&session),
      device_(std::move(options.device)),
      deviceId_(std::move(options.deviceId)),
      listDevices_(std::move(options.listDevices)),
      deviceFactory_(std::move(options.deviceFactory)),
      missingDevice_(options.deviceError.value_or(protocol::DeviceProblem{"no_device", "no audio device was given"})),
      playbackOptions_(withoutAutoPlay(std::move(options.playback), *pluginHosts_)),
      diagnostic_(std::move(options.diagnostic)),
      bufferFrames_(options.bufferFrames),
      backoff_(options.backoff),
      clock_(std::move(options.clock)) {
    bind(session);
}

void EngineHost::bind(session::Session& session) {
    // What refers to the old engine goes first, then the engine, whose driver stops
    // the device. The device object stays: the new driver opens it again.
    publisher_.reset();
    audition_.unbind(session);  // until a graph is built, merge and discard reach the session
    auditioner_.reset();
    pendingInstances_.clear();
    if (engine_) {
        engine_->stop();
        if (device_) {
            device_->setOnStopped([](bool) {});  // not the old driver's any more
        }
        engine_.reset();
    }
    running_ = false;
    loaded_ = false;
    session_ = &session;
    engine_ = std::make_unique<playback::PlaybackEngine>(session, playbackOptions_);
    loadAttemptHead_ = session.history().head().envelope.id;
    if (auto problem = graphProblem([this] { engine_->load(); })) {
        say("cannot load the session (" + problem->code + "): " + problem->message);
        problem_ = std::move(problem);
        return;
    }
    loaded_ = true;
    auditioner_.emplace(*engine_, session);
    audition_.rebind(*auditioner_);
    problem_.reset();
    if (device_) {
        startDevice();
    } else {
        report(missingDevice_);
    }
    if (!running_ && engine_->options().butlerThread) {
        // Without a device the graph still follows the session, and its old
        // streams are only released through the butler.
        engine_->butler().start();
    }
    if (channel_ != nullptr) {
        makePublisher();
    }
}

void EngineHost::rebind(session::Session& session) {
    bind(session);
}

EngineHost::~EngineHost() {
    shutdown();
}

std::chrono::steady_clock::time_point EngineHost::now() const {
    return clock_ ? clock_() : std::chrono::steady_clock::now();
}

void EngineHost::startDevice() {
    host::AudioDeviceConfig config;
    config.deviceId = deviceId_;
    config.bufferFrames = bufferFrames_;
    config.outputChannels = kOutputChannels;
    try {
        device_->close();                 // a no-op unless a run or a failed start left it open
        engine_->start(*device_, config);  // asks the device for the session rate
        running_ = true;
        startedAt_ = now();
        reopenAt_.reset();
    } catch (const host::DeviceError& error) {
        engine_->driver().stop();
        report({error.code(), error.what()});
        scheduleReopen();
    } catch (const std::exception& error) {
        engine_->driver().stop();
        report({"device_open_failed", error.what()});
        scheduleReopen();
    }
}

// As the shell schedules a restart: double up to the maximum, and start over after a
// run of resetAfter. The shift stops growing long before the maximum can overflow it.
void EngineHost::scheduleReopen() {
    constexpr int kMaxDoublings = 20;
    const auto at = now();
    if (startedAt_ && at - *startedAt_ >= backoff_.resetAfter) {
        reopenFailures_ = 0;
    }
    startedAt_.reset();
    using Rep = std::chrono::milliseconds::rep;
    const std::chrono::milliseconds doubled = backoff_.initial * (Rep{1} << reopenFailures_);
    const std::chrono::milliseconds delay = std::min(doubled, backoff_.max);
    reopenFailures_ = std::min(reopenFailures_ + 1, kMaxDoublings);
    reopenAt_ = at + delay;
}

void EngineHost::reopenDevice() {
    reopenAt_.reset();
    startDevice();
    if (running_) {
        problem_.reset();
        say("audio device running again");
    }
}

void EngineHost::say(const std::string& line) const {
    if (diagnostic_) {
        diagnostic_(line);
    }
}

void EngineHost::report(protocol::DeviceProblem problem) {
    if (!problem_ || problem_->code != problem.code || problem_->message != problem.message) {
        say("no audio device (" + problem.code + "): " + problem.message);
    }
    problem_ = std::move(problem);
}

protocol::AuditionPort* EngineHost::auditionPort() noexcept {
    return &audition_;
}

void EngineHost::attachPublisher(protocol::RealtimeChannel& channel, protocol::EventStream& events) {
    channel_ = &channel;
    events_ = &events;
    if (loaded_) {
        makePublisher();
    }
}

void EngineHost::makePublisher() {
    protocol::MeterPublisher::Options options;
    realtime::Transport& transport = engine_->transport();
    options.playing = [&transport] { return transport.playing(); };
    options.playhead = [&transport] { return transport.position(); };
    publisher_.emplace(engine_->dispatcher(), *channel_, *events_, std::move(options));
    publisher_->graphPublished(engine_->driver().liveEpoch(), engine_->meterSlots());
}

void EngineHost::tick() {
    // CLAP's main-thread callbacks (restarts, flushes) first, so the engine's tick
    // drains what they reported.
    pluginHosts_->clap.runMainThreadCallbacks();
    if (!loaded_) {
        // The first graph could not be built: again once main has a new head.
        if (session_->history().head().envelope.id != loadAttemptHead_) {
            bind(*session_);
        }
        return;
    }
    if (const auto problem = graphProblem([this] { engine_->tick(); })) {
        // A document whose media cannot be read: the graph that plays stays live.
        say("cannot compile the session (" + problem->code + "): " + problem->message);
    }
    if (running_ && engine_->driver().state() != realtime::DriverState::realtime) {
        running_ = false;
        engine_->transport().stop();
        report({"device_lost", "the audio device stopped"});
        scheduleReopen();
    }
    if (reopenAt_ && now() >= *reopenAt_) {
        reopenDevice();
    }
    if (publisher_) {
        if (publisher_->epoch() != engine_->driver().liveEpoch()) {
            publisher_->graphPublished(engine_->driver().liveEpoch(), engine_->meterSlots());
        }
        publisher_->tick();
    }
}

void EngineHost::shutdown() {
    running_ = false;
    reopenAt_.reset();
    if (engine_) {
        engine_->stop();
    }
    if (device_) {
        device_->close();
    }
}

// ---- PluginPort ----------------------------------------------------------------

protocol::PluginInstantiateResult EngineHost::instantiate(const protocol::PluginInstantiateRequest& request) {
    const playback::PluginHosts hosts = pluginHosts_->byFormat();
    const auto found = hosts.find(request.descriptor.format);
    if (found == hosts.end()) {
        throw protocol::PluginPortError("no_plugin_host",
                                        "this engine hosts no " + request.descriptor.format + " plugins");
    }
    host::PluginHost& pluginHost = *found->second;
    const std::int64_t sampleRate = session_->history().head().document.root().sampleRate;
    const int maxBlock = std::max(engine_->options().maxBlockFrames, kRenderBlockFrames);
    protocol::PluginInstantiateResult result;
    std::unique_ptr<host::PluginInstance> instance;
    try {
        host::PluginDescriptor descriptor;
        descriptor.format = request.descriptor.format;
        descriptor.uid = request.descriptor.uid;
        descriptor.name = request.descriptor.name;
        descriptor.path = request.descriptor.path;
        if (!descriptor.path.empty()) {
            // The probe names the plugin: its uid goes into the document.
            const auto probed = pluginHost.scanPath(descriptor.path);
            const auto match = std::find_if(probed.begin(), probed.end(), [&](const host::PluginDescriptor& one) {
                return descriptor.uid.empty() || one.uid == descriptor.uid;
            });
            if (match == probed.end()) {
                throw host::PluginError("plugin_not_found", "no plugin " + descriptor.uid + " in " + descriptor.path);
            }
            descriptor = *match;
        }
        instance = pluginHost.instantiate(descriptor, sampleRate, maxBlock);
        result.descriptor = {descriptor.format, descriptor.uid, descriptor.name, descriptor.path};
        if (request.stateBlob) {
            const auto file = playback::blobPath(session_->bundlePath(), *request.stateBlob);
            std::error_code ec;
            if (std::filesystem::exists(file, ec)) {  // otherwise the default state, as a compile does
                const std::string bytes = io::readFile(file);
                instance->control().setState(std::vector<std::uint8_t>(bytes.begin(), bytes.end()));
            }
        } else {
            result.state = instance->control().getState();
        }
    } catch (const host::PluginError& error) {
        throw protocol::PluginPortError(error.code(), error.what());
    }
    result.latencyFrames = instance->latencyFrames();
    result.tailFrames = instance->tailFrames();
    result.capabilities = flagsOf(instance->capabilities());
    pendingInstances_[request.slotId] = std::move(instance);
    return result;
}

void EngineHost::settle(const model::PluginSlot& slot, bool inserted) {
    auto found = pendingInstances_.find(slot.id);
    if (found == pendingInstances_.end()) {
        return;
    }
    std::unique_ptr<host::PluginInstance> instance = std::move(found->second);
    pendingInstances_.erase(found);
    if (inserted) {
        engine_->plugins().adopt(slot, std::move(instance));  // the next compile reuses it
    }
}

host::PluginInstance& EngineHost::requireInstance(const std::string& slotId) const {
    const model::Document* heard = engine_->heardDocument();
    const bool known = session_->history().head().document.pluginSlot(slotId) != nullptr ||
                       (heard != nullptr && heard->pluginSlot(slotId) != nullptr);
    if (!known) {
        throw protocol::PluginPortError("not_found", "no plugin slot " + slotId);
    }
    host::PluginInstance* instance = engine_->plugins().instance(slotId);
    if (instance == nullptr) {
        throw protocol::PluginPortError("plugin_missing", "the plugin of slot " + slotId + " did not load");
    }
    return *instance;
}

protocol::PluginEditorState EngineHost::openEditor(const std::string& slotId) {
    host::PluginInstance& instance = requireInstance(slotId);
    try {
        instance.control().openEditor(host::EditorOwner{ownerWindow_});
    } catch (const host::PluginError& error) {
        throw protocol::PluginPortError(error.code(), error.what());
    }
    return editorState(slotId, instance);
}

protocol::PluginEditorState EngineHost::closeEditor(const std::string& slotId) {
    host::PluginInstance& instance = requireInstance(slotId);
    instance.control().closeEditor();
    return editorState(slotId, instance);
}

void EngineHost::setParameter(const std::string& slotId, const std::string& paramId, double value) {
    host::PluginInstance& instance = requireInstance(slotId);
    const std::vector<host::PluginParameterInfo> parameters = instance.control().parameters();
    const auto found = std::find_if(parameters.begin(), parameters.end(),
                                    [&](const host::PluginParameterInfo& one) { return one.id == paramId; });
    if (found == parameters.end()) {
        throw protocol::PluginPortError("not_found", "the plugin of slot " + slotId + " has no parameter " + paramId);
    }
    const auto index = static_cast<std::uint32_t>(found - parameters.begin());
    const std::optional<playback::PluginInstanceStatus> status = engine_->plugins().status(slotId);
    if (status && status->format == "clap" && index < engine_->plugins().pendingParameterCapacity(slotId)) {
        // Block-accurate: the driver hands it to the node on the audio thread. The
        // node holds a value for each parameter the instance had at install; one the
        // plugin added since goes through PluginControl, which CLAP also delivers by
        // the next block.
        engine_->dispatcher().setParameter(realtime::ParamKey{playback::pluginSlotKey(slotId), index}, value, 0);
        return;
    }
    try {
        instance.control().setParameter(static_cast<int>(index), value);
    } catch (const host::PluginError& error) {
        throw protocol::PluginPortError(error.code(), error.what());
    }
}

std::vector<protocol::PluginStatus> EngineHost::plugins() const {
    std::vector<protocol::PluginStatus> out;
    const model::Document* heard = engine_->heardDocument();
    if (heard == nullptr) {
        return out;
    }
    for (const playback::PluginInstanceStatus& one : engine_->plugins().status(*heard)) {
        protocol::PluginStatus status;
        status.slotId = one.slotId;
        status.trackId = one.trackId;
        status.format = one.format;
        status.uid = one.uid;
        status.running = one.running;
        if (one.error) {
            status.error = std::make_pair(one.error->code, one.error->message);
        }
        if (one.running) {
            status.capabilities = flagsOf(*one.capabilities);
            status.latencyFrames = one.latencyFrames;
            status.tailFrames = one.tailFrames;
            status.callbacks = one.callbacks;
            status.xruns = one.xruns;
            status.maxCallbackMicros = static_cast<double>(one.maxCallbackNanos) / 1'000.0;
            status.unmeasuredCallbacks = one.unmeasuredCallbacks;
            status.midiOutputOverflows = one.midiOutputOverflows;
            status.midiOutputSysex = one.midiOutputSysex;
        }
        out.push_back(std::move(status));
    }
    return out;
}

std::vector<std::string> EngineHost::formats() const {
    std::vector<std::string> out;
    for (const auto& [format, pluginHost] : pluginHosts_->byFormat()) {
        (void)pluginHost;
        out.push_back(format);
    }
    return out;
}

std::shared_ptr<engine::PluginNodeSource> EngineHost::instantiateForRender(const model::Document& document) {
    return std::make_shared<playback::RenderInstanceSet>(document, pluginHosts_->byFormat(), session_->bundlePath(),
                                                         kRenderBlockFrames);
}

void EngineHost::destroyRenderInstances(std::shared_ptr<engine::PluginNodeSource> instances) {
    instances.reset();  // here, on the command thread
}

void EngineHost::requireDevice() const {
    if (!running_) {
        throw protocol::TransportPortError(
            "no_device", problem_ ? problem_->message : std::string("the engine has no running audio device"));
    }
}

protocol::TransportState EngineHost::play() {
    requireDevice();
    engine_->transport().play();
    return transportState();
}

protocol::TransportState EngineHost::stop() {
    requireDevice();
    engine_->transport().stop();
    return transportState();
}

protocol::TransportState EngineHost::locate(std::int64_t frames) {
    requireDevice();
    engine_->transport().locate(frames);
    return transportState();
}

protocol::TransportState EngineHost::transportState() const {
    const realtime::Transport& transport = engine_->transport();
    return {transport.playing(), transport.position()};
}

protocol::EngineStatus EngineHost::status() const {
    protocol::EngineStatus out;
    if (running_) {
        const host::AudioDeviceStatus& device = engine_->driver().deviceStatus();
        out.device = protocol::DeviceInfo{deviceId_.empty() ? "default" : deviceId_, device.sampleRate,
                                          device.bufferFrames, device.inputLatencyFrames, device.outputLatencyFrames};
    } else {
        out.deviceError = problem_;
    }
    if (loaded_) {
        const rt::CallbackTimer& timing = engine_->driver().callbackTiming();
        out.playing = engine_->transport().playing();
        out.xruns = timing.misses();
        out.maxCallbackMicros = static_cast<double>(timing.maxCallbackNanos()) / 1'000.0;
        out.unmeasuredCallbacks = timing.unmeasured();
        out.underruns = engine_->underruns();
        out.srcUnderruns = engine_->driver().srcUnderruns();
    }
    return out;
}

std::vector<protocol::DeviceDescription> EngineHost::devices() const {
    std::vector<protocol::DeviceDescription> listed = listDevices_ ? listDevices_() : std::vector<protocol::DeviceDescription>{};
    // Without an id the engine runs the default device: the first one so marked.
    bool marked = false;
    for (protocol::DeviceDescription& one : listed) {
        one.current = !marked && (deviceId_.empty() ? one.isDefault : one.id == deviceId_);
        marked = marked || one.current;
    }
    return listed;
}

protocol::DeviceInfo EngineHost::selectDevice(const std::string& id) {
    const std::vector<protocol::DeviceDescription> listed = devices();
    const bool known = std::any_of(listed.begin(), listed.end(),
                                   [&](const protocol::DeviceDescription& one) { return one.id == id; });
    if (!known) {
        throw protocol::TransportPortError("not_found", "no audio device " + id + "; engine.devices lists them");
    }
    if (!deviceFactory_) {
        throw protocol::TransportPortError("not_supported", "this engine host cannot select a device");
    }
    std::unique_ptr<host::AudioDevice> chosen;
    try {
        chosen = deviceFactory_(id);
    } catch (const host::DeviceError& error) {
        throw protocol::TransportPortError(error.code(), error.what());
    }
    // The old device first: stop its callbacks and the transport, then close it.
    if (loaded_) {
        engine_->driver().stop();
        engine_->plugins().setBlocksComing(false);
        engine_->transport().stop();
    }
    running_ = false;
    reopenAt_.reset();
    startedAt_.reset();
    if (device_) {
        device_->close();
    }
    device_ = std::move(chosen);
    deviceId_ = id;
    reopenFailures_ = 0;
    if (!loaded_) {
        // Opened once the session's graph can be built.
        throw protocol::TransportPortError(problem_ ? problem_->code : std::string("load_failed"),
                                           problem_ ? problem_->message : std::string("the session did not load"));
    }
    startDevice();
    if (!running_) {
        throw protocol::TransportPortError(problem_ ? problem_->code : std::string("device_open_failed"),
                                           problem_ ? problem_->message : std::string("the device did not open"));
    }
    if (problem_) {
        problem_.reset();
        say("audio device " + id + " running");
    }
    return *status().device;
}

}  // namespace siann::engine_app
