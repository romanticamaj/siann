#include "siann/engine_app/engine_host.hpp"

#include <exception>
#include <utility>

#include "siann/engine/offline.hpp"

namespace siann::engine_app {

namespace {

constexpr int kOutputChannels = 2;

playback::PlaybackOptions withoutAutoPlay(playback::PlaybackOptions options) {
    options.playOnStart = false;
    return options;
}

}  // namespace

EngineHost::EngineHost(session::Session& session, EngineHostOptions options)
    : device_(std::move(options.device)),
      deviceId_(std::move(options.deviceId)),
      diagnostic_(std::move(options.diagnostic)),
      engine_(session, withoutAutoPlay(std::move(options.playback))) {
    try {
        engine_.load();
    } catch (const engine::EngineError& error) {
        say("cannot load the session (" + error.code() + "): " + error.what());
        problem_ = protocol::DeviceProblem{error.code(), error.what()};
        return;
    }
    loaded_ = true;
    auditioner_.emplace(engine_, session);
    audition_.emplace(*auditioner_);
    if (device_) {
        startDevice(options.bufferFrames);
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

void EngineHost::startDevice(int bufferFrames) {
    host::AudioDeviceConfig config;
    config.deviceId = deviceId_;
    config.bufferFrames = bufferFrames;
    config.outputChannels = kOutputChannels;
    try {
        engine_.start(*device_, config);  // asks the device for the session rate
        running_ = true;
    } catch (const host::DeviceError& error) {
        engine_.driver().stop();
        report({error.code(), error.what()});
    } catch (const std::exception& error) {
        engine_.driver().stop();
        report({"device_open_failed", error.what()});
    }
}

void EngineHost::say(const std::string& line) const {
    if (diagnostic_) {
        diagnostic_(line);
    }
}

void EngineHost::report(protocol::DeviceProblem problem) {
    say("no audio device (" + problem.code + "): " + problem.message);
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
    if (!loaded_) {
        return;
    }
    try {
        engine_.tick();
    } catch (const engine::EngineError& error) {
        // A document whose media is not there: the graph that plays stays live.
        say("cannot compile the session (" + error.code() + "): " + error.what());
    }
    if (running_ && engine_.driver().state() != realtime::DriverState::realtime) {
        running_ = false;
        engine_.transport().stop();
        report({"device_lost", "the audio device stopped"});
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
    engine_.stop();
    if (device_) {
        device_->close();
    }
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
    const realtime::Transport::Status status = engine_.transport().status();
    return {status.playing, status.position};
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
