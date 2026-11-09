#include "siann/engine_app/engine_host.hpp"

#include <algorithm>
#include <exception>
#include <set>
#include <stdexcept>
#include <string_view>
#include <utility>

#include "siann/engine/offline.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/host/clap_plugin_host.hpp"
#include "siann/host/plugin_error.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/model/document.hpp"
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

playback::PlaybackOptions withoutAutoPlay(playback::PlaybackOptions options, PluginHostSet& hosts,
                                          const host::PluginRegistry& registry) {
    options.playOnStart = false;
    options.pluginHosts = hosts.byFormat();
    options.pluginRegistry = &registry;
    return options;
}

constexpr std::string_view kRegistrySchema = "siann.plugin_registry.v0";

std::string utf8(const std::filesystem::path& path) {
    const std::u8string text = path.u8string();
    return std::string(reinterpret_cast<const char*>(text.data()), text.size());
}

protocol::PluginRegistryEntry entryOf(const host::PluginInstall& install) {
    return {install.format, install.path, install.uid, install.name, install.approved};
}

[[noreturn]] void badRegistry(const std::string& why) {
    throw std::runtime_error(why);
}

const json::Value& member(const json::Value& object, std::string_view key, json::Value::Kind kind,
                          const char* where) {
    const json::Value* found = object.find(key);
    if (found == nullptr || found->kind() != kind) {
        badRegistry(std::string(where) + " needs " + std::string(key) + " of the right type");
    }
    return *found;
}

}  // namespace

std::vector<host::PluginInstall> readPluginRegistry(const std::filesystem::path& file) {
    std::error_code ec;
    if (!std::filesystem::exists(file, ec)) {
        return {};
    }
    json::Value root;
    try {
        root = json::parse(io::readFile(file));
    } catch (const std::exception& error) {
        badRegistry(std::string("not JSON: ") + error.what());
    }
    if (root.kind() != json::Value::Kind::object) {
        badRegistry("not a JSON object");
    }
    if (member(root, "schema", json::Value::Kind::string, "the file").asString() != kRegistrySchema) {
        badRegistry("its schema is not " + std::string(kRegistrySchema));
    }
    std::vector<host::PluginInstall> out;
    for (const json::Value& entry : member(root, "plugins", json::Value::Kind::array, "the file").asArray()) {
        if (entry.kind() != json::Value::Kind::object) {
            badRegistry("a plugin entry is not an object");
        }
        host::PluginInstall install;
        install.format = member(entry, "format", json::Value::Kind::string, "a plugin entry").asString();
        install.path = member(entry, "path", json::Value::Kind::string, "a plugin entry").asString();
        const json::Value* uid = entry.find("uid");
        if (uid != nullptr && uid->kind() == json::Value::Kind::string) {
            install.uid = uid->asString();
        } else if (uid != nullptr && !uid->isNull()) {
            badRegistry("a plugin entry's uid must be a string or null");
        }
        install.name = member(entry, "name", json::Value::Kind::string, "a plugin entry").asString();
        install.approved = member(entry, "approved", json::Value::Kind::boolean, "a plugin entry").asBool();
        out.push_back(std::move(install));
    }
    return out;
}

void writePluginRegistry(const std::filesystem::path& file, const std::vector<host::PluginInstall>& installs) {
    json::Array plugins;
    for (const host::PluginInstall& install : installs) {
        plugins.push_back(json::Value(json::Object{{"format", json::Value(install.format)},
                                                   {"path", json::Value(install.path)},
                                                   {"uid", install.uid ? json::Value(*install.uid) : json::Value()},
                                                   {"name", json::Value(install.name)},
                                                   {"approved", json::Value(install.approved)}}));
    }
    const json::Value root(json::Object{{"schema", json::Value(std::string(kRegistrySchema))},
                                        {"plugins", json::Value(std::move(plugins))}});
    if (file.has_parent_path()) {
        io::createDirectoriesDurable(file.parent_path());
    }
    io::writeFileAtomic(file, jcs::canonicalize(root));
}

namespace {

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
      registryFile_(std::move(options.pluginRegistryFile)),
      ownerWindow_(options.ownerWindow),
      session_(session),
      device_(std::move(options.device)),
      deviceId_(std::move(options.deviceId)),
      diagnostic_(std::move(options.diagnostic)),
      bufferFrames_(options.bufferFrames),
      backoff_(options.backoff),
      clock_(std::move(options.clock)),
      engine_(session, withoutAutoPlay(std::move(options.playback), *pluginHosts_, registry_)) {
    fillRegistry(options.pluginDirs);  // before the first load resolves through it
    if (auto problem = graphProblem([this] { engine_.load(); })) {
        say("cannot load the session (" + problem->code + "): " + problem->message);
        problem_ = std::move(problem);
        return;
    }
    loaded_ = true;
    auditioner_.emplace(engine_, session);
    audition_.emplace(*auditioner_);
    if (device_) {
        startDevice();
    } else {
        report(options.deviceError.value_or(protocol::DeviceProblem{"no_device", "no audio device was given"}));
    }
    if (!running_ && engine_.options().butlerThread) {
        // Without a device the graph still follows the session, and its old
        // streams are only released through the butler.
        engine_.butler().start();
    }
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
        engine_.start(*device_, config);  // asks the device for the session rate
        running_ = true;
        startedAt_ = now();
        reopenAt_.reset();
    } catch (const host::DeviceError& error) {
        engine_.driver().stop();
        report({error.code(), error.what()});
        scheduleReopen();
    } catch (const std::exception& error) {
        engine_.driver().stop();
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
    return audition_ ? &*audition_ : nullptr;
}

void EngineHost::attachPublisher(protocol::RealtimeChannel& channel, protocol::EventStream& events) {
    if (!loaded_) {
        return;
    }
    protocol::MeterPublisher::Options options;
    realtime::Transport& transport = engine_.transport();
    options.playing = [&transport] { return transport.playing(); };
    options.playhead = [&transport] { return transport.position(); };
    publisher_.emplace(engine_.dispatcher(), channel, events, std::move(options));
    publisher_->graphPublished(engine_.driver().liveEpoch(), engine_.meterSlots());
}

void EngineHost::tick() {
    // CLAP's main-thread callbacks (restarts, flushes) first, so the engine's tick
    // drains what they reported.
    pluginHosts_->clap.runMainThreadCallbacks();
    if (!loaded_) {
        return;
    }
    if (const auto problem = graphProblem([this] { engine_.tick(); })) {
        // A document whose media cannot be read: the graph that plays stays live.
        say("cannot compile the session (" + problem->code + "): " + problem->message);
    }
    if (running_ && engine_.driver().state() != realtime::DriverState::realtime) {
        running_ = false;
        engine_.transport().stop();
        report({"device_lost", "the audio device stopped"});
        scheduleReopen();
    }
    if (reopenAt_ && now() >= *reopenAt_) {
        reopenDevice();
    }
    if (publisher_) {
        if (publisher_->epoch() != engine_.driver().liveEpoch()) {
            publisher_->graphPublished(engine_.driver().liveEpoch(), engine_.meterSlots());
        }
        publisher_->tick();
    }
}

void EngineHost::shutdown() {
    running_ = false;
    reopenAt_.reset();
    engine_.stop();
    if (device_) {
        device_->close();
    }
}

// ---- the plugin registry (m5-plugin-registry, Protocol v0 item 21) ---------------

// What scan lists over the standard directories and `pluginDirs`, which runs no
// plugin code, then what the registry file says of those paths. Nothing is probed.
// A listed path inside the session's bundle or on a share is not registered,
// wherever it was found (a --plugin-dir holding the bundle, a CLAP_PATH entry):
// the code a downloaded bundle ships never loads (Protocol v0 item 21).
void EngineHost::fillRegistry(const std::vector<std::string>& pluginDirs) {
    std::set<host::PluginHost*> scanned;  // vst3 and au share the JUCE host
    for (const auto& [format, pluginHost] : pluginHosts_->byFormat()) {
        if (!scanned.insert(pluginHost).second) {
            continue;
        }
        try {
            for (const host::PluginDescriptor& found : pluginHost->scan(pluginDirs)) {
                if (const auto refused = installRefusal(found.path)) {
                    say("the " + found.format + " plugin " + found.path + " is not registered (" + *refused + ")");
                    continue;
                }
                registry_.addScanned(found.format, found.path, found.name);
            }
        } catch (const std::exception& error) {
            say("cannot list the " + format + " plugins: " + error.what());
        }
    }
    if (registryFile_.empty()) {
        return;
    }
    std::vector<host::PluginInstall> kept;
    try {
        kept = readPluginRegistry(registryFile_);
    } catch (const std::exception& error) {
        say("the plugin registry " + utf8(registryFile_) + " is unreadable (" + error.what() +
            "); starting with no approvals");
        return;
    }
    for (const host::PluginInstall& install : kept) {
        if (!registry_.restore(install)) {
            unscannedKept_.push_back(install);
        }
    }
}

// Writes what is known of each install: the probed ones, and the file's entries
// for paths not listed this time.
void EngineHost::keepRegistry() const {
    if (registryFile_.empty()) {
        return;
    }
    std::vector<host::PluginInstall> installs;
    for (const host::PluginInstall& install : registry_.installs()) {
        if (install.uid || install.approved) {
            installs.push_back(install);
        }
    }
    installs.insert(installs.end(), unscannedKept_.begin(), unscannedKept_.end());
    writePluginRegistry(registryFile_, installs);
}

std::vector<protocol::PluginRegistryEntry> EngineHost::registry() const {
    std::vector<protocol::PluginRegistryEntry> out;
    for (const host::PluginInstall& install : registry_.installs()) {
        out.push_back(entryOf(install));
    }
    return out;
}

protocol::PluginRegistryEntry EngineHost::approve(const std::string& format, const std::string& path, bool approved) {
    const host::PluginInstall* install = registry_.find(format, path);
    if (install == nullptr) {
        throw protocol::PluginPortError("plugin_not_registered", "unregistered_path: no " + format +
                                                                     " plugin is registered at " + path);
    }
    if (const auto refused = installRefusal(install->path)) {
        throw protocol::PluginPortError("plugin_not_registered", install->path + " is refused (" + *refused + ")");
    }
    const host::PluginInstall before = *install;
    if (approved && !install->uid) {
        // The user's choice to run this code: probe it now.
        const playback::PluginHosts hosts = pluginHosts_->byFormat();
        const auto found = hosts.find(format);
        if (found == hosts.end()) {
            throw protocol::PluginPortError("no_plugin_host", "this engine hosts no " + format + " plugins");
        }
        std::vector<host::PluginDescriptor> probed;
        try {
            probed = found->second->scanPath(install->path);
        } catch (const host::PluginError& error) {
            throw protocol::PluginPortError(error.code(), error.what());
        } catch (const std::exception& error) {
            throw protocol::PluginPortError("plugin_load_failed", error.what());
        }
        if (probed.empty()) {
            throw protocol::PluginPortError("plugin_load_failed", "no plugin in " + install->path);
        }
        // A library holding several plugins is approved as the first it lists.
        registry_.setProbed(format, install->path, probed.front().uid, probed.front().name);
    }
    const std::string installPath = install->path;
    if (registry_.approve(format, installPath, approved) != host::ApproveOutcome::done) {
        throw protocol::PluginPortError("plugin_load_failed", "the probe of " + installPath + " named no plugin");
    }
    try {
        keepRegistry();
    } catch (...) {
        registry_.restore(before);  // not kept, so not approved either
        throw;
    }
    return entryOf(*registry_.find(format, installPath));
}

// Why an install's path may not load: on a share, or inside the session's bundle.
std::optional<std::string> EngineHost::installRefusal(const std::string& path) const {
    return model::pluginPathRefusal(path, session_.bundlePath());
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
    const std::int64_t sampleRate = session_.history().head().document.root().sampleRate;
    const int maxBlock = std::max(engine_.options().maxBlockFrames, kRenderBlockFrames);
    protocol::PluginInstantiateResult result;
    std::unique_ptr<host::PluginInstance> instance;
    // Through the registry (Protocol v0 item 21): a path must be a registered,
    // approved install's; a uid alone needs exactly one approved install.
    host::PluginInstall chosen;
    if (!request.descriptor.path.empty()) {
        const host::PluginInstall* install = registry_.find(request.descriptor.format, request.descriptor.path);
        if (install == nullptr) {
            throw protocol::PluginPortError("plugin_not_registered", "unregistered_path: no " +
                                                                         request.descriptor.format +
                                                                         " plugin is registered at " +
                                                                         request.descriptor.path);
        }
        if (!install->approved) {
            throw protocol::PluginPortError("plugin_not_approved", install->path +
                                                                       " is registered but not approved; plugin.approve "
                                                                       "approves it");
        }
        if (!request.descriptor.uid.empty() && install->uid != request.descriptor.uid) {
            throw protocol::PluginPortError("plugin_not_found",
                                            "no plugin " + request.descriptor.uid + " in " + install->path);
        }
        chosen = *install;
    } else {
        host::PluginResolution resolved = registry_.resolve(request.descriptor.format, request.descriptor.uid, "");
        if (!resolved.install) {
            throw protocol::PluginPortError(resolved.code, resolved.message);
        }
        chosen = std::move(*resolved.install);
    }
    if (const auto refused = installRefusal(chosen.path)) {
        throw protocol::PluginPortError("plugin_not_registered", "the registered install at " + chosen.path +
                                                                     " is refused (" + *refused + ")");
    }
    try {
        host::PluginDescriptor descriptor;
        descriptor.format = chosen.format;
        descriptor.uid = chosen.uid.value_or("");
        descriptor.name = chosen.name;
        descriptor.path = chosen.path;
        instance = pluginHost.instantiate(descriptor, sampleRate, maxBlock);
        result.descriptor = {descriptor.format, descriptor.uid, descriptor.name, descriptor.path};
        if (request.stateBlob) {
            const auto file = playback::blobPath(session_.bundlePath(), *request.stateBlob);
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
        engine_.plugins().adopt(slot, std::move(instance));  // the next compile reuses it
    }
}

host::PluginInstance& EngineHost::requireInstance(const std::string& slotId) const {
    const model::Document* heard = engine_.heardDocument();
    const bool known = session_.history().head().document.pluginSlot(slotId) != nullptr ||
                       (heard != nullptr && heard->pluginSlot(slotId) != nullptr);
    if (!known) {
        throw protocol::PluginPortError("not_found", "no plugin slot " + slotId);
    }
    host::PluginInstance* instance = engine_.plugins().instance(slotId);
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
    const std::optional<playback::PluginInstanceStatus> status = engine_.plugins().status(slotId);
    if (status && status->format == "clap" && index < engine_.plugins().pendingParameterCapacity(slotId)) {
        // Block-accurate: the driver hands it to the node on the audio thread. The
        // node holds a value for each parameter the instance had at install; one the
        // plugin added since goes through PluginControl, which CLAP also delivers by
        // the next block.
        engine_.dispatcher().setParameter(realtime::ParamKey{playback::pluginSlotKey(slotId), index}, value, 0);
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
    const model::Document* heard = engine_.heardDocument();
    if (heard == nullptr) {
        return out;
    }
    for (const playback::PluginInstanceStatus& one : engine_.plugins().status(*heard)) {
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
    return std::make_shared<playback::RenderInstanceSet>(document, pluginHosts_->byFormat(),
                                                         engine_.options().pluginRegistry, session_.bundlePath(),
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
    engine_.transport().play();
    return transportState();
}

protocol::TransportState EngineHost::stop() {
    requireDevice();
    engine_.transport().stop();
    return transportState();
}

protocol::TransportState EngineHost::locate(std::int64_t frames) {
    requireDevice();
    engine_.transport().locate(frames);
    return transportState();
}

protocol::TransportState EngineHost::transportState() const {
    const realtime::Transport& transport = engine_.transport();
    return {transport.playing(), transport.position()};
}

protocol::EngineStatus EngineHost::status() const {
    protocol::EngineStatus out;
    if (running_) {
        const host::AudioDeviceStatus& device = engine_.driver().deviceStatus();
        out.device = protocol::DeviceInfo{deviceId_.empty() ? "default" : deviceId_, device.sampleRate,
                                          device.bufferFrames, device.inputLatencyFrames, device.outputLatencyFrames};
    } else {
        out.deviceError = problem_;
    }
    if (loaded_) {
        const rt::CallbackTimer& timing = engine_.driver().callbackTiming();
        out.playing = engine_.transport().playing();
        out.xruns = timing.misses();
        out.maxCallbackMicros = static_cast<double>(timing.maxCallbackNanos()) / 1'000.0;
        out.unmeasuredCallbacks = timing.unmeasured();
        out.underruns = engine_.underruns();
        out.srcUnderruns = engine_.driver().srcUnderruns();
    }
    return out;
}

}  // namespace siann::engine_app
