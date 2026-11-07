#pragma once

// The protocol server's way to the transport and the device (architecture spec,
// "siann-protocol", Protocol v0 item 18). siann-protocol does not link the
// playback engine; the engine host implements this interface and hands it to
// the server in ServerOptions. Every call runs on the command thread.

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace siann::protocol {

struct TransportState {
    bool playing = false;
    std::int64_t position = 0;  // session frames
};

// The running device, as it reported itself.
struct DeviceInfo {
    std::string id;  // "fake", "<type>/<name>" or "default"
    std::int64_t sampleRate = 0;
    int bufferFrames = 0;
    int inputLatencyFrames = 0;
    int outputLatencyFrames = 0;
};

// Why there is no running device.
struct DeviceProblem {
    std::string code;
    std::string message;
};

// Counters run from the device's start. xruns are callbacks the driver timed
// over their period, unmeasuredCallbacks those it could not check (no device
// rate), underruns the disk streams' and srcUnderruns the SRC path's.
struct EngineStatus {
    std::optional<DeviceInfo> device;
    std::optional<DeviceProblem> deviceError;  // set when device is not
    bool playing = false;
    std::uint64_t xruns = 0;
    double maxCallbackMicros = 0.0;
    std::uint64_t unmeasuredCallbacks = 0;
    std::uint64_t underruns = 0;
    std::uint64_t srcUnderruns = 0;
};

// Thrown by a port. Code: no_device.
class TransportPortError : public std::runtime_error {
public:
    TransportPortError(std::string code, const std::string& message)
        : std::runtime_error(message), code_(std::move(code)) {}

    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

class TransportPort {
public:
    virtual ~TransportPort() = default;

    // Each returns the transport's state after the call and throws
    // TransportPortError when no device is running. A start or a locate is
    // reported at once; it reaches the audio thread when the butler is ready.
    virtual TransportState play() = 0;
    virtual TransportState stop() = 0;
    virtual TransportState locate(std::int64_t frames) = 0;
    virtual EngineStatus status() const = 0;
};

}  // namespace siann::protocol
