#pragma once

// What siann-engine plays with (architecture spec, "Process model"; Protocol v0
// item 18): the session's graph in a PlaybackEngine on a device, the Auditioner
// that keeps it on the heard side, and the meter publisher. The protocol server
// reaches it through TransportPort and auditionPort().
//
// Everything here runs on one thread, the process's main thread, which is the
// command thread and the graph driver's control thread: device open, start and
// stop, the ports and tick(). The audio thread only runs the driver's callback.
//
// A device that cannot run never ends the engine (Process model, device policy):
// the host says why once through `diagnostic`, serves, reports the reason in
// status(), and the transport methods answer no_device. A session whose media
// cannot be loaded is served the same way, with no graph at all.

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>

#include "siann/engine_app/auditioner_port.hpp"
#include "siann/host/interfaces.hpp"
#include "siann/playback/audition.hpp"
#include "siann/playback/playback_engine.hpp"
#include "siann/protocol/event_stream.hpp"
#include "siann/protocol/realtime_channel.hpp"
#include "siann/protocol/transport_port.hpp"
#include "siann/session/session.hpp"

namespace siann::engine_app {

struct EngineHostOptions {
    // Opened and started by the constructor; nullptr: no device.
    std::unique_ptr<host::AudioDevice> device;
    // What opens it and what status() calls it: empty is the default device.
    std::string deviceId;
    // Why there is no device, when `device` is nullptr.
    std::optional<protocol::DeviceProblem> deviceError;
    int bufferFrames = 256;
    // playOnStart is ignored: only a client starts the transport.
    playback::PlaybackOptions playback{};
    // One line per problem, for the log.
    std::function<void(const std::string& line)> diagnostic;
};

class EngineHost final : public protocol::TransportPort {
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

    // The engine's tick, device loss, then the publisher.
    void tick();

    // Stops the device and the butler. Once the protocol server has stopped;
    // the destructor does it otherwise.
    void shutdown();

    protocol::TransportState play() override;
    protocol::TransportState stop() override;
    protocol::TransportState locate(std::int64_t frames) override;
    protocol::EngineStatus status() const override;

    protocol::TransportState transportState() const;
    playback::PlaybackEngine& playback() noexcept { return engine_; }

private:
    void startDevice(int bufferFrames);
    void say(const std::string& line) const;
    void report(protocol::DeviceProblem problem);
    void requireDevice() const;

    // Declared before the engine, which stops the device when destroyed.
    std::unique_ptr<host::AudioDevice> device_;
    std::string deviceId_;
    std::function<void(const std::string&)> diagnostic_;
    std::optional<protocol::DeviceProblem> problem_;
    bool running_ = false;
    bool loaded_ = false;
    playback::PlaybackEngine engine_;
    std::optional<playback::Auditioner> auditioner_;
    std::optional<AuditionerPort> audition_;
    std::optional<protocol::MeterPublisher> publisher_;
};

}  // namespace siann::engine_app
