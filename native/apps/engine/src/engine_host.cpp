#include "siann/engine_app/engine_host.hpp"

#include <algorithm>
#include <chrono>
#include <ctime>
#include <exception>
#include <random>
#include <set>
#include <stdexcept>
#include <string_view>
#include <utility>

#include "siann/engine/offline.hpp"
#include "siann/session/takes.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/host/clap_plugin_host.hpp"
#include "siann/host/plugin_error.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/model/document.hpp"
#include "siann/playback/plugin_instances.hpp"
#if defined(SIANN_ENGINE_WITH_JUCE)
#include "siann/host/juce_editor_window.hpp"
#include "siann/host/juce_plugin_host.hpp"
#endif

namespace siann::engine_app {

// The engine's plugin hosts: CLAP in every build, JUCE's formats with JUCE. With
// JUCE, CLAP editors embed into the desktop target's windows (m5-clap-editor-window);
// the factory is declared first so it outlives the CLAP host and its instances.
struct PluginHostSet {
#if defined(SIANN_ENGINE_WITH_JUCE)
    host::JuceEditorWindowFactory editorWindows;
    host::ClapPluginHost clap{&editorWindows};
    host::JucePluginHost juce;
#else
    host::ClapPluginHost clap{nullptr};  // the headless target: no window to embed into
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
      session_(&session),
      device_(std::move(options.device)),
      deviceId_(std::move(options.deviceId)),
      listDevices_(std::move(options.listDevices)),
      deviceFactory_(std::move(options.deviceFactory)),
      missingDevice_(options.deviceError.value_or(protocol::DeviceProblem{"no_device", "no audio device was given"})),
      playbackOptions_(withoutAutoPlay(std::move(options.playback), *pluginHosts_, registry_)),
      diagnostic_(std::move(options.diagnostic)),
      bufferFrames_(options.bufferFrames),
      backoff_(options.backoff),
      clock_(std::move(options.clock)),
      actor_(std::move(options.actor)),
      timestamp_(std::move(options.timestamp)) {
    if (playbackOptions_.capture.slots == 0) {
        playbackOptions_.capture.slots = options.recordSlots;
    }
    fillRegistry(options.pluginDirs);  // before the first load resolves through it
    bind(session);
}

void EngineHost::bind(session::Session& session) {
    // A recording ends into the session it was made in, before anything changes;
    // the armed set is the old session's tracks and goes with it.
    if (recording_) {
        finishRecording(realtime::EndedBy::stop);
    }
    clearArms();
    lastTakes_.clear();
    armHead_ = session.history().head().envelope.id;
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
    // Cycle and click are engine state, not the graph's: every engine gets them.
    engine_->setCycle(session.cycle());
    engine_->setClick(click_.enabled, click_.gainMilliDb);
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
    if (inputId_) {
        // The input selected with the device (m5b-engine-record): its own device
        // where it is another one, which the backend pairs with the output.
        config.inputChannels = inputRequest_;
        config.inputDeviceId = *inputId_ != deviceId_ ? *inputId_ : std::string();
    }
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
    pruneArms();  // the input it opened may hold fewer channels
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
    options.inputMeter = [this](const std::string& trackId) { return inputMeter(trackId); };
    publisher_.emplace(engine_->dispatcher(), *channel_, *events_, std::move(options));
    publisher_->graphPublished(engine_->driver().liveEpoch(), engine_->meterSlots());
    publisher_->setInputs(armedTracks());
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
        if (recording_) {
            finishRecording(realtime::EndedBy::device);  // what was captured is committed
        }
        running_ = false;
        engine_->transport().stop();
        report({"device_lost", "the audio device stopped"});
        scheduleReopen();
    }
    if (recording_) {
        pollRecording();
    }
    // Every new head of main: a removed track, or an input cleared or changed
    // past the open input, is disarmed (not while recording: its end does it).
    const std::string& head = session_->history().head().envelope.id;
    if (head != armHead_ && !recording_) {
        armHead_ = head;
        pruneArms();
    }
    if (reopenAt_ && now() >= *reopenAt_) {
        reopenDevice();
    }
    if (publisher_) {
        publisher_->setInputs(armedTracks());
        if (publisher_->epoch() != engine_->driver().liveEpoch()) {
            publisher_->graphPublished(engine_->driver().liveEpoch(), engine_->meterSlots());
        }
        publisher_->tick();
    }
}

void EngineHost::shutdown() {
    abandonRecording();  // its takes stay pending for record.recover_take
    running_ = false;
    reopenAt_.reset();
    if (engine_) {
        engine_->stop();
    }
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

// The installs that may load now: the refusal reads the bound session's bundle,
// so after session.open an install inside the new bundle is not listed (the
// launch-time filter in fillRegistry read the launch bundle only).
std::vector<protocol::PluginRegistryEntry> EngineHost::registry() const {
    std::vector<protocol::PluginRegistryEntry> out;
    for (const host::PluginInstall& install : registry_.installs()) {
        if (installRefusal(install.path)) {
            continue;
        }
        out.push_back(entryOf(install));
    }
    return out;
}

protocol::PluginRegistryEntry EngineHost::approve(const std::string& format, const std::string& path, bool approved,
                                                  const std::optional<std::string>& uid) {
    const host::PluginInstall* install = registry_.find(format, path);
    if (install == nullptr) {
        throw protocol::PluginPortError("plugin_not_registered", "unregistered_path: no " + format +
                                                                     " plugin is registered at " + path);
    }
    if (const auto refused = installRefusal(install->path)) {
        throw protocol::PluginPortError("plugin_not_registered", install->path + " is refused (" + *refused + ")");
    }
    const host::PluginInstall before = *install;
    // A uid other than the one recorded is another plugin of the library: probe
    // again, so the approval goes to code the library does hold.
    if (approved && (!install->uid || (uid && *uid != *install->uid))) {
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
        // A library holding several plugins is approved as the one `uid` names,
        // never as whichever its probe lists first (follow-up of PR #70).
        std::string held;
        for (const host::PluginDescriptor& one : probed) {
            held += (held.empty() ? "" : ", ") + one.uid;
        }
        const host::PluginDescriptor* chosen = nullptr;
        if (uid) {
            const auto named = std::find_if(probed.begin(), probed.end(),
                                            [&](const host::PluginDescriptor& one) { return one.uid == *uid; });
            if (named == probed.end()) {
                throw protocol::PluginPortError("plugin_not_found", "no plugin " + *uid + " in " + install->path +
                                                                        "; it holds " + held);
            }
            chosen = &*named;
        } else if (probed.size() > 1) {
            throw protocol::PluginPortError("invalid_params", install->path + " holds " +
                                                                  std::to_string(probed.size()) + " plugins (" + held +
                                                                  "): plugin.approve needs a uid naming one");
        } else {
            chosen = &probed.front();
        }
        registry_.setProbed(format, install->path, chosen->uid, chosen->name);
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
    return model::pluginPathRefusal(path, session_->bundlePath());
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
    return std::make_shared<playback::RenderInstanceSet>(document, pluginHosts_->byFormat(),
                                                         engine_->options().pluginRegistry, session_->bundlePath(),
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
    if (recording_) {
        finishRecording(realtime::EndedBy::stop);  // one revision, then stopped
    }
    engine_->transport().stop();
    return transportState();
}

protocol::TransportState EngineHost::locate(std::int64_t frames) {
    requireDevice();
    engine_->transport().locate(frames);
    return transportState();
}

protocol::TransportState EngineHost::setCycle(bool enabled) {
    requireDevice();
    session_->setCycle(enabled);  // written with the session's next checkpoint
    engine_->setCycle(enabled);
    return transportState();
}

protocol::TransportState EngineHost::setClick(bool enabled, std::optional<std::int32_t> gainMilliDb) {
    requireDevice();
    protocol::ClickState next{enabled, gainMilliDb.value_or(click_.gainMilliDb)};
    engine_->setClick(next.enabled, next.gainMilliDb);
    click_ = next;
    return transportState();
}

protocol::TransportState EngineHost::transportState() const {
    const realtime::Transport& transport = engine_->transport();
    protocol::TransportState out{transport.playing(), transport.position(), session_->cycle(), click_};
    out.recording = recording_;
    out.armed = armedTracks();
    return out;
}

protocol::EngineStatus EngineHost::status() const {
    protocol::EngineStatus out;
    if (running_) {
        const host::AudioDeviceStatus& device = engine_->driver().deviceStatus();
        out.device = protocol::DeviceInfo{deviceId_.empty() ? "default" : deviceId_, device.sampleRate,
                                          device.bufferFrames, device.inputLatencyFrames, device.outputLatencyFrames};
        if (openInputChannels() > 0) {  // an input that opened no channels is none
            out.device->input = protocol::InputInfo{*inputId_, openInputChannels(), device.inputLatencyFrames};
        }
    } else {
        out.deviceError = problem_;
    }
    out.cycle = session_->cycle();
    out.click = click_;
    out.recording = recording_;
    out.armed = armedTracks();
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
        if (one.current && running_) {
            // Counted on the device the engine has open, never by opening another
            // instance of its driver (ASIO allows one).
            const host::AudioDeviceStatus& device = engine_->driver().deviceStatus();
            if (!one.outputChannels && device.outputChannels > 0) {
                one.outputChannels = device.outputChannels;
            }
            if (!one.inputChannels && inputId_ && *inputId_ == one.id) {
                // What the device opened of up to kMaxInputChannels: all it has.
                one.inputChannels = device.inputChannels;
            }
        }
    }
    return listed;
}

protocol::DeviceInfo EngineHost::selectDevice(const std::string& id) {
    return selectDeviceWithInput(id, std::nullopt);
}

namespace {

// At most this many input channels are asked of a device that does not say how
// many it has; the backend opens the ones it has.
constexpr int kMaxInputChannels = 32;

}  // namespace

protocol::DeviceInfo EngineHost::selectDeviceWithInput(const std::string& id,
                                                       const std::optional<std::string>& inputId) {
    const std::vector<protocol::DeviceDescription> listed = devices();
    const auto entry = [&listed](const std::string& wanted) {
        const auto found = std::find_if(listed.begin(), listed.end(),
                                        [&](const protocol::DeviceDescription& one) { return one.id == wanted; });
        return found == listed.end() ? nullptr : &*found;
    };
    const protocol::DeviceDescription* output = entry(id);
    if (output == nullptr || output->outputChannels == 0) {
        throw protocol::TransportPortError("not_found", "no audio output device " + id + "; engine.devices lists them");
    }
    int request = 0;
    if (inputId) {
        const protocol::DeviceDescription* input = entry(*inputId);
        if (input == nullptr || input->inputChannels == 0) {
            throw protocol::TransportPortError("not_found",
                                               "no audio input device " + *inputId + "; engine.devices lists them");
        }
        if (input->id != output->id && input->type != output->type) {
            throw protocol::TransportPortError("invalid_params", "the input " + *inputId + " cannot open with " + id +
                                                                     ": a backend pairs devices of its own type");
        }
        request = input->inputChannels.value_or(kMaxInputChannels);
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
    // A recording ends on the device it was made on, before that device closes.
    if (recording_) {
        finishRecording(realtime::EndedBy::stop);
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
    inputId_ = inputId;
    inputRequest_ = request;
    reopenFailures_ = 0;
    if (!loaded_) {
        // Opened once the session's graph can be built.
        throw protocol::TransportPortError(problem_ ? problem_->code : std::string("load_failed"),
                                           problem_ ? problem_->message : std::string("the session did not load"));
    }
    startDevice();
    pruneArms();  // kept where the new input still covers the channels
    if (!running_) {
        throw protocol::TransportPortError(problem_ ? problem_->code : std::string("device_open_failed"),
                                           problem_ ? problem_->message : std::string("the device did not open"));
    }
    if (problem_) {
        problem_.reset();
        say("audio device " + id + " running");
    }
    if (inputId_ && openInputChannels() == 0) {
        say("the input " + *inputId_ + " opened no channels; the record methods answer no_input");
    }
    return *status().device;
}

// ---- recording (m5b-engine-record, Protocol v0 item 27) -------------------------

namespace fs = std::filesystem;

namespace {

std::string utcNow() {
    const std::time_t t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buffer;
}

protocol::TransportPortError recordError(const std::string& code, const std::string& message) {
    return protocol::TransportPortError(code, message);
}

}  // namespace

std::string EngineHost::timestamp() const {
    return timestamp_ ? timestamp_() : utcNow();
}

// The channels the open input has: what the device says it opened (every
// device reports it), 0 without an input, without a running device or when the
// device opened none (an output-only device named as its own input).
int EngineHost::openInputChannels() const {
    if (!inputId_ || !running_) {
        return 0;
    }
    return engine_->driver().deviceStatus().inputChannels;
}

bool EngineHost::covers(const model::TrackInput& input) const {
    return input.port >= 0 && input.channels >= 1 && input.port + input.channels <= openInputChannels();
}

std::vector<std::string> EngineHost::armedTracks() const {
    std::vector<std::string> out;
    for (const auto& [trackId, slot] : armed_) {
        (void)slot;
        out.push_back(trackId);
    }
    return out;
}

void EngineHost::clearArms() {
    if (engine_) {
        if (realtime::CaptureBank* bank = engine_->driver().captureBank()) {
            for (const auto& [trackId, slot] : armed_) {
                (void)trackId;
                bank->disarm(slot);
            }
        }
    }
    armed_.clear();
}

// Every armed track whose input is gone, or past what the open input holds, is
// disarmed; one whose input changed and still fits is armed with the new map.
void EngineHost::pruneArms() {
    if (recording_ || armed_.empty() || !engine_) {
        return;
    }
    realtime::CaptureBank* bank = engine_->driver().captureBank();
    const model::Document& doc = session_->history().head().document;
    for (auto it = armed_.begin(); it != armed_.end();) {
        const model::Track* track = doc.track(it->first);
        if (track == nullptr || !track->input || !covers(*track->input)) {
            if (bank != nullptr) {
                bank->disarm(it->second);
            }
            it = armed_.erase(it);
            continue;
        }
        if (bank != nullptr) {
            bank->arm(it->second, track->input->port, track->input->channels);
        }
        ++it;
    }
}

protocol::RecordState EngineHost::arm(const std::string& trackId, bool armed) {
    if (recording_) {
        throw recordError("invalid_state", "the armed tracks cannot change while recording");
    }
    if (!armed) {
        const auto found = armed_.find(trackId);
        if (found != armed_.end()) {
            if (realtime::CaptureBank* bank = engine_->driver().captureBank()) {
                bank->disarm(found->second);
            }
            armed_.erase(found);
        }
        return recordState();
    }
    requireDevice();
    if (openInputChannels() == 0) {
        throw recordError("no_input", "no input is open; engine.select_device opens one with inputId");
    }
    const model::Track* track = session_->history().head().document.track(trackId);
    if (track == nullptr) {
        throw recordError("not_found", "no track with id " + trackId);
    }
    if (!track->input) {
        throw recordError("no_input", "track " + trackId + " has no input; track.set_input sets one");
    }
    if (!covers(*track->input)) {
        throw recordError("no_input", "the open input has " + std::to_string(openInputChannels()) +
                                          " channels, fewer than track " + trackId + "'s input needs");
    }
    realtime::CaptureBank* bank = engine_->driver().captureBank();
    if (bank == nullptr) {
        throw recordError("not_supported", "this engine records no input");
    }
    auto found = armed_.find(trackId);
    if (found == armed_.end()) {
        std::vector<bool> used(bank->size(), false);
        for (const auto& [id, slot] : armed_) {
            (void)id;
            used[slot] = true;
        }
        const auto free = std::find(used.begin(), used.end(), false);
        if (free == used.end()) {
            throw recordError("invalid_state", "at most " + std::to_string(bank->size()) + " tracks are armed at once");
        }
        found = armed_.emplace(trackId, static_cast<std::size_t>(free - used.begin())).first;
    }
    bank->arm(found->second, track->input->port, track->input->channels);
    return recordState();
}

protocol::TransportState EngineHost::record(bool enabled) {
    if (!enabled) {
        if (recording_) {
            finishRecording(realtime::EndedBy::stop);  // playback goes on
        }
        return transportState();
    }
    requireDevice();
    if (openInputChannels() == 0) {
        throw recordError("no_input", "no input is open; engine.select_device opens one with inputId");
    }
    if (armed_.empty()) {
        throw recordError("nothing_armed", "no track is armed; record.arm arms one");
    }
    if (!recording_) {
        startRecording();
    }
    return transportState();
}

std::string EngineHost::newTakeId() const {
    const fs::path bundle = session_->bundlePath();
    for (;;) {
        std::random_device rd;
        static constexpr char kHex[] = "0123456789abcdef";
        std::string id = "take_";
        for (int i = 0; i < 12; ++i) {
            id.push_back(kHex[rd() % 16]);
        }
        std::error_code ec;
        if (!fs::exists(session::takeManifestPath(bundle, id), ec) &&
            !fs::exists(bundle / "trash" / (id + ".json"), ec) &&
            session_->history().head().document.media("med_" + id) == nullptr) {
            return id;
        }
    }
}

void EngineHost::startRecording() {
    realtime::CaptureBank& bank = *engine_->driver().captureBank();
    const model::Document& doc = session_->history().head().document;
    const std::int64_t rate = doc.root().sampleRate;
    const std::int64_t offset = engine_->driver().latency().recordOffsetFrames;
    const fs::path bundle = session_->bundlePath();
    std::vector<Take> takes;
    try {
        for (const auto& [trackId, slot] : armed_) {
            const model::TrackInput input = *doc.track(trackId)->input;
            session::TakeManifest manifest;
            manifest.takeId = newTakeId();
            manifest.trackId = trackId;
            manifest.channels = input.channels;
            manifest.sampleRate = rate;
            manifest.recordOffset = offset;
            const fs::path audio = session::beginTake(*session_, manifest);
            Take take;
            take.slot = slot;
            take.recordOffset = offset;
            take.state.takeId = manifest.takeId;
            take.state.trackId = trackId;
            takes.push_back(take);
            const std::string takeId = manifest.takeId;
            // On the writer thread, before the first frame is written: the take's
            // position is durable before any of its audio.
            bank.recorder(slot).start(
                audio, rate, [bundle, takeId](std::int64_t start) { session::markTakeStart(bundle, takeId, start); },
                {}, input.channels);
        }
    } catch (...) {
        for (const Take& take : takes) {
            realtime::Recorder& recorder = bank.recorder(take.slot);
            if (recorder.recording()) {
                recorder.stop();
            }
            try {
                session::discardTake(*session_, take.state.takeId);
            } catch (...) {
            }
        }
        throw;
    }
    takes_ = std::move(takes);
    lastTakes_.clear();
    recording_ = true;
    engine_->driver().setCaptureActive(true);  // the cycle records straight through
    engine_->transport().play();
}

void EngineHost::pollRecording() {
    realtime::CaptureBank& bank = *engine_->driver().captureBank();
    bool ended = false;
    for (Take& take : takes_) {
        realtime::Recorder& recorder = bank.recorder(take.slot);
        if (!playbackOptions_.capture.recorder.writerThread) {
            recorder.drain();  // no writer thread: the tick writes (tests)
        }
        const std::int64_t start = recorder.startPosition();
        if (start != realtime::Recorder::kNoStart) {
            take.state.startFrame = start - take.recordOffset;
        }
        take.state.durableFrames = recorder.durableFrames();
        ended = ended || recorder.overflowed() || recorder.diskFailed();
    }
    if (ended) {
        finishRecording(std::nullopt);  // each take says how it ended
    }
}

void EngineHost::finishRecording(std::optional<realtime::EndedBy> forced) {
    if (!recording_) {
        return;
    }
    recording_ = false;
    engine_->driver().setCaptureActive(false);
    realtime::CaptureBank& bank = *engine_->driver().captureBank();
    const fs::path bundle = session_->bundlePath();
    std::vector<std::string> commit;
    std::vector<protocol::RecordTakeState> ended;
    for (Take& take : takes_) {
        const realtime::Recorder::Result result = bank.recorder(take.slot).stop();
        const realtime::EndedBy endedBy = forced.value_or(result.endedBy) == realtime::EndedBy::device
                                              ? realtime::EndedBy::device
                                              : result.endedBy;
        protocol::RecordTakeState state = take.state;
        state.endedBy = std::string(realtime::endedByName(endedBy));
        state.overflows = result.overflows;
        state.durableFrames = result.frames;
        if (result.frames > 0) {
            state.startFrame = result.startPosition - take.recordOffset;
        }
        try {
            session::markTakeEnd(bundle, state.takeId, *state.endedBy, result.overflows);
        } catch (const std::exception& error) {
            say("cannot note how take " + state.takeId + " ended: " + error.what());
        }
        if (result.frames > 0) {
            commit.push_back(state.takeId);
        } else {
            try {
                session::discardTake(*session_, state.takeId);  // nothing captured: to trash/
            } catch (const std::exception& error) {
                say("cannot move the empty take " + state.takeId + " to trash: " + error.what());
            }
        }
        ended.push_back(std::move(state));
    }
    takes_.clear();
    lastTakes_ = std::move(ended);
    if (!commit.empty()) {
        try {
            session::commitTakes(*session_, commit, actor_, timestamp());
            audition_.mainCommitted();  // the engine plays the new clips
        } catch (const std::exception& error) {
            // The takes stay pending: record.recover_take commits them later.
            say("cannot commit the recording: " + std::string(error.what()));
        }
    }
    armHead_ = session_->history().head().envelope.id;
    pruneArms();
}

void EngineHost::abandonRecording() {
    if (!recording_ || !engine_) {
        return;
    }
    recording_ = false;
    engine_->driver().setCaptureActive(false);
    realtime::CaptureBank& bank = *engine_->driver().captureBank();
    for (const Take& take : takes_) {
        bank.recorder(take.slot).stop();  // the file is closed and stays pending
    }
    takes_.clear();
}

protocol::RecordState EngineHost::recordState() const {
    protocol::RecordState out;
    out.recording = recording_;
    out.armed = armedTracks();
    if (recording_) {
        for (const Take& take : takes_) {
            out.takes.push_back(take.state);
        }
    } else {
        out.takes = lastTakes_;
    }
    return out;
}

std::vector<protocol::PendingTake> EngineHost::pendingTakes() const {
    std::vector<protocol::PendingTake> out;
    for (const session::TakeManifest& manifest : session::pendingTakes(session_->bundlePath())) {
        const bool beingRecorded = std::any_of(takes_.begin(), takes_.end(), [&](const Take& take) {
            return take.state.takeId == manifest.takeId;
        });
        if (beingRecorded) {
            continue;
        }
        protocol::PendingTake take;
        take.takeId = manifest.takeId;
        take.trackId = manifest.trackId;
        take.channels = manifest.channels;
        take.sampleRate = manifest.sampleRate;
        if (manifest.startPosition) {
            take.startFrame = *manifest.startPosition - manifest.recordOffset;
        }
        take.endedBy = manifest.endedBy;
        take.overflows = manifest.overflows;
        out.push_back(std::move(take));
    }
    return out;
}

protocol::RecoverResult EngineHost::recoverTake(const std::string& takeId, bool accept, std::string actor,
                                                std::string time) {
    const bool beingRecorded =
        std::any_of(takes_.begin(), takes_.end(), [&](const Take& take) { return take.state.takeId == takeId; });
    if (beingRecorded) {
        throw recordError("invalid_state", "take " + takeId + " is being recorded");
    }
    if (!accept) {
        session::discardTake(*session_, takeId);
        return {nullptr, true};
    }
    const std::string before = session_->history().head().envelope.id;
    const command::Revision* revision = &session::commitTake(*session_, takeId, std::move(actor), std::move(time));
    if (session_->history().head().envelope.id != before) {
        audition_.mainCommitted();
    }
    return {revision, false};
}

std::optional<graph::MeterReading> EngineHost::inputMeter(const std::string& trackId) const {
    const auto found = armed_.find(trackId);
    if (found == armed_.end() || !engine_) {
        return std::nullopt;
    }
    const realtime::CaptureBank* bank = engine_->driver().captureBank();
    if (bank == nullptr) {
        return std::nullopt;
    }
    const realtime::InputMeterReading reading = bank->meter(found->second);
    if (reading.blocks == 0) {
        return std::nullopt;
    }
    graph::MeterReading out;
    out.channels = std::min(reading.channels, graph::kMaxMeterChannels);
    for (int c = 0; c < out.channels; ++c) {
        out.peak[static_cast<std::size_t>(c)] = reading.peak[static_cast<std::size_t>(c)];
        out.rms[static_cast<std::size_t>(c)] = reading.rms[static_cast<std::size_t>(c)];
    }
    return out;
}

// ---- fader gestures (Protocol v0 item 24) ---------------------------------------

namespace {

// Frames each gesture.update ramps over: short enough to follow a drag, long
// enough not to click.
constexpr int kGestureRampFrames = 64;

std::uint32_t faderParam(const std::string& param) {
    if (param == "pan") {
        return graph::TrackFaderNode::kPan;
    }
    if (param == "mute") {
        return graph::TrackFaderNode::kMute;
    }
    return graph::TrackFaderNode::kGainMilliDb;
}

double faderValue(const model::Track& track, const std::string& param) {
    if (param == "pan") {
        return static_cast<double>(track.pan);
    }
    if (param == "mute") {
        return track.mute ? 1.0 : 0.0;
    }
    return static_cast<double>(track.gain.milliDb);
}

std::string gestureKey(const protocol::GestureTarget& target) {
    return target.trackId + "/" + target.param;
}

// The track as the side a gesture commits on holds it: the heard proposal, or main.
const model::Track* heardTrack(playback::PlaybackEngine& engine, session::Session& session,
                                      const std::string& trackId) {
    const command::History& history = session.history();
    const auto& branch = engine.gestureBranch();
    const model::Document& document =
        branch && history.isOpen(*branch) ? history.branchHead(*branch).document : history.head().document;
    return document.track(trackId);
}

}  // namespace

double EngineHost::begin(const protocol::GestureTarget& target) {
    const model::Track* track = heardTrack(*engine_, *session_, target.trackId);
    if (track == nullptr) {
        throw protocol::GesturePortError("not_found", "no track with id " + target.trackId);
    }
    const double start = faderValue(*track, target.param);
    engine_->beginGesture(target.trackId, faderParam(target.param));
    gestureStarts_[gestureKey(target)] = start;
    return start;
}

void EngineHost::update(const protocol::GestureTarget& target, double value) {
    engine_->updateGesture(target.trackId, faderParam(target.param), value, kGestureRampFrames);
}

protocol::GestureEnd EngineHost::end(const protocol::GestureTarget& target, std::string actor, std::string time) {
    const auto started = gestureStarts_.find(gestureKey(target));
    const double start = started != gestureStarts_.end() ? started->second : 0.0;
    if (started != gestureStarts_.end()) {
        gestureStarts_.erase(started);
    }
    const command::Revision* revision = nullptr;
    try {
        revision = engine_->endGesture(target.trackId, faderParam(target.param), std::move(actor), std::move(time));
    } catch (const playback::AuditionError& error) {
        throw protocol::GesturePortError(error.code(), error.what());
    }
    if (revision == nullptr) {
        return {start, start, nullptr};
    }
    const model::Track* committed = revision->document.track(target.trackId);
    return {start, committed != nullptr ? faderValue(*committed, target.param) : start, revision};
}

void EngineHost::cancel(const protocol::GestureTarget& target) {
    gestureStarts_.erase(gestureKey(target));
    const realtime::ParamKey key{playback::trackSlotKey(target.trackId), faderParam(target.param)};
    engine_->dispatcher().endGesture(key);  // the value is dropped
    if (const model::Track* track = heardTrack(*engine_, *session_, target.trackId)) {
        engine_->dispatcher().setParameter(key, faderValue(*track, target.param), 0);
    }
}

}  // namespace siann::engine_app
