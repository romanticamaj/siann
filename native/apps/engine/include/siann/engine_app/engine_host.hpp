#pragma once

// What siann-engine plays with (architecture spec, "Process model"; Protocol v0
// items 18 and 19): the session's graph in a PlaybackEngine on a device, the
// Auditioner that keeps it on the heard side, the meter publisher and the plugin
// hosts (ClapPluginHost always, JucePluginHost for vst3 and au in a
// SIANN_WITH_JUCE build). The protocol server reaches it through TransportPort,
// PluginPort and auditionPort().
//
// The tick services the CLAP host (runMainThreadCallbacks), then the engine,
// whose tick drains pluginEventAny and polls each instance (pollStale). The
// instance table hears setBlocksComing from the engine's start and stop and
// from a device that stopped on its own.
//
// Everything here runs on one thread, the process's main thread, which is the
// command thread and the graph driver's control thread: device open, start and
// stop, the ports and tick(). The audio thread only runs the driver's callback.
//
// A device that cannot run never ends the engine (Process model, device policy):
// the host says why once through `diagnostic`, serves, reports the reason in
// status(), and the transport methods answer no_device, and tick() opens the device
// again under `backoff`. A session whose media cannot be loaded, for whatever reason,
// is served the same way, with no graph at all and no retry.

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "siann/engine_app/auditioner_port.hpp"
#include "siann/host/interfaces.hpp"
#include "siann/host/plugin_registry.hpp"
#include "siann/playback/audition.hpp"
#include "siann/playback/playback_engine.hpp"
#include "siann/protocol/event_stream.hpp"
#include "siann/protocol/plugin_port.hpp"
#include "siann/protocol/realtime_channel.hpp"
#include "siann/protocol/transport_port.hpp"
#include "siann/session/session.hpp"

namespace siann::engine_app {

// How a device that cannot run is tried again: the delay doubles from `initial` up
// to `max`, and the count resets once a device has run for `resetAfter`. The shell's
// restart constants (app/src/main/supervisor.ts), which it passes with
// --device-backoff. At namespace scope so GCC sees the default member initializers
// when traits are checked inside EngineHostOptions.
struct DeviceBackoff {
    std::chrono::milliseconds initial{250};
    std::chrono::milliseconds max{10'000};
    std::chrono::milliseconds resetAfter{30'000};
};

struct EngineHostOptions {
    // Opened and started by the constructor; nullptr: no device.
    std::unique_ptr<host::AudioDevice> device;
    // What opens it and what status() calls it: empty is the default device.
    std::string deviceId;
    // Why there is no device, when `device` is nullptr.
    std::optional<protocol::DeviceProblem> deviceError;
    int bufferFrames = 256;
    DeviceBackoff backoff{};
    // What the backoff reads; empty is the steady clock. Tests.
    std::function<std::chrono::steady_clock::time_point()> clock;
    // playOnStart is ignored: only a client starts the transport.
    playback::PlaybackOptions playback{};
    // One line per problem, for the log.
    std::function<void(const std::string& line)> diagnostic;
    // The window plugin editors belong to (--owner-window; 0 for none).
    std::uintptr_t ownerWindow = 0;
    // Directories (UTF-8) scanned for plugins beside the standard ones
    // (--plugin-dir; m5-plugin-registry, Protocol v0 item 21).
    std::vector<std::string> pluginDirs;
    // The JSON file the approvals are kept in (--plugin-registry); empty: kept for
    // the life of the host only.
    std::filesystem::path pluginRegistryFile;
};

// The --plugin-registry file ({"schema": "siann.plugin_registry.v0", "plugins":
// [{format, path, uid, name, approved}]}). Reads nothing from a file that is not
// there; a file that does not parse or has another shape throws
// std::runtime_error saying why.
std::vector<host::PluginInstall> readPluginRegistry(const std::filesystem::path& file);
void writePluginRegistry(const std::filesystem::path& file, const std::vector<host::PluginInstall>& installs);

struct PluginHostSet;

class EngineHost final : public protocol::TransportPort, public protocol::PluginPort {
public:
    // The session must outlive the host.
    EngineHost(session::Session& session, EngineHostOptions options);
    ~EngineHost() override;
    EngineHost(const EngineHost&) = delete;
    EngineHost& operator=(const EngineHost&) = delete;

    // nullptr when the session could not be loaded. Lives as long as the host.
    protocol::AuditionPort* auditionPort() noexcept;

    // From here on tick() publishes the meter legend and the frames. Both must
    // outlive every later tick().
    void attachPublisher(protocol::RealtimeChannel& channel, protocol::EventStream& events);

    // The engine's tick, device loss and a reopen that is due, then the publisher.
    void tick();

    // Stops the device and the butler. Once the protocol server has stopped;
    // the destructor does it otherwise.
    void shutdown();

    protocol::TransportState play() override;
    protocol::TransportState stop() override;
    protocol::TransportState locate(std::int64_t frames) override;
    protocol::EngineStatus status() const override;

    // protocol::PluginPort, on the command thread.
    protocol::PluginInstantiateResult instantiate(const protocol::PluginInstantiateRequest& request) override;
    void settle(const model::PluginSlot& slot, bool inserted) override;
    protocol::PluginEditorState openEditor(const std::string& slotId) override;
    protocol::PluginEditorState closeEditor(const std::string& slotId) override;
    // A CLAP slot through the control dispatcher (pluginSlotKey, the parameter's
    // index), as an event of its node's next block; a VST3 or AU slot through
    // PluginControl::setParameter here, on the main thread.
    void setParameter(const std::string& slotId, const std::string& paramId, double value) override;
    std::vector<protocol::PluginStatus> plugins() const override;
    std::vector<std::string> formats() const override;
    std::shared_ptr<engine::PluginNodeSource> instantiateForRender(const model::Document& document) override;
    void destroyRenderInstances(std::shared_ptr<engine::PluginNodeSource> instances) override;
    // plugin.registry and plugin.approve (Protocol v0 item 21). An approval probes
    // an unprobed install with scanPath and is written to the registry file.
    std::vector<protocol::PluginRegistryEntry> registry() const override;
    protocol::PluginRegistryEntry approve(const std::string& format, const std::string& path, bool approved) override;

    protocol::TransportState transportState() const;
    playback::PlaybackEngine& playback() noexcept { return engine_; }

private:
    std::chrono::steady_clock::time_point now() const;
    void startDevice();
    void scheduleReopen();
    void reopenDevice();
    void say(const std::string& line) const;
    void report(protocol::DeviceProblem problem);
    void requireDevice() const;
    host::PluginInstance& requireInstance(const std::string& slotId) const;
    void fillRegistry(const std::vector<std::string>& pluginDirs);
    void keepRegistry() const;

    // The plugin hosts, before the engine whose instances they made.
    std::unique_ptr<PluginHostSet> pluginHosts_;
    // The installs every load resolves through; before the engine that points at it.
    host::PluginRegistry registry_;
    std::filesystem::path registryFile_;
    // Entries of the file for paths no scan listed this time: written back as they were.
    std::vector<host::PluginInstall> unscannedKept_;
    std::uintptr_t ownerWindow_ = 0;
    session::Session& session_;
    // plugin.instantiate's instance until its plugin.insert committed.
    std::map<std::string, std::unique_ptr<host::PluginInstance>> pendingInstances_;
    // Declared before the engine, which stops the device when destroyed.
    std::unique_ptr<host::AudioDevice> device_;
    std::string deviceId_;
    std::function<void(const std::string&)> diagnostic_;
    std::optional<protocol::DeviceProblem> problem_;
    int bufferFrames_ = 0;
    DeviceBackoff backoff_;
    std::function<std::chrono::steady_clock::time_point()> clock_;
    int reopenFailures_ = 0;
    std::optional<std::chrono::steady_clock::time_point> reopenAt_;
    std::optional<std::chrono::steady_clock::time_point> startedAt_;
    bool running_ = false;
    bool loaded_ = false;
    playback::PlaybackEngine engine_;
    std::optional<playback::Auditioner> auditioner_;
    std::optional<AuditionerPort> audition_;
    std::optional<protocol::MeterPublisher> publisher_;
};

}  // namespace siann::engine_app
