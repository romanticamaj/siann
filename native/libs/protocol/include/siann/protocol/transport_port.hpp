#pragma once

// The protocol server's way to the transport and the device (architecture spec,
// "siann-protocol", Protocol v0 items 18, 22 and 26). siann-protocol does not link the
// playback engine; the engine host implements this interface and hands it to
// the server in ServerOptions. Every call runs on the command thread.

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace siann::protocol {

// The metronome (Protocol v0 item 26): on or off and its gain, an integer
// milli-dB in [kMinGainMilliDb, kMaxGainMilliDb].
struct ClickState {
    static constexpr std::int32_t kDefaultGainMilliDb = -12'000;
    static constexpr std::int32_t kMinGainMilliDb = -60'000;
    static constexpr std::int32_t kMaxGainMilliDb = 0;

    bool enabled = false;
    std::int32_t gainMilliDb = kDefaultGainMilliDb;

    friend bool operator==(const ClickState&, const ClickState&) = default;
};

struct TransportState {
    bool playing = false;
    std::int64_t position = 0;  // session frames
    bool cycle = false;         // Protocol v0 item 26
    ClickState click;
};

// The running device, as it reported itself.
struct DeviceInfo {
    std::string id;  // "fake", "<type>/<name>" or "default"
    std::int64_t sampleRate = 0;
    int bufferFrames = 0;
    int inputLatencyFrames = 0;
    int outputLatencyFrames = 0;
};

// One entry of engine.devices (Protocol v0 item 22).
struct DeviceDescription {
    std::string id;  // what --device takes: "fake" or "<type>/<name>"
    std::string type;
    std::string name;
    bool isDefault = false;
    bool current = false;  // the device the engine runs or is trying to open
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
    bool cycle = false;
    ClickState click;
    std::uint64_t xruns = 0;
    double maxCallbackMicros = 0.0;
    std::uint64_t unmeasuredCallbacks = 0;
    std::uint64_t underruns = 0;
    std::uint64_t srcUnderruns = 0;
};

// Thrown by a port. Codes: no_device; selectDevice's not_found and
// device_open_failed (or the device's own code, or a media code while the
// session's first graph could not be built).
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
    // Protocol v0 item 26: engine state, never a revision. setClick keeps the
    // current gain when `gainMilliDb` is empty; the server has checked its range.
    virtual TransportState setCycle(bool enabled) = 0;
    virtual TransportState setClick(bool enabled, std::optional<std::int32_t> gainMilliDb) = 0;
    virtual EngineStatus status() const = 0;

    // engine.devices: every device --device could name, `current` marking one.
    virtual std::vector<DeviceDescription> devices() const = 0;
    // engine.select_device: closes the running device and opens `id`, returning
    // what status().device then reports. Throws not_found for an id devices()
    // does not list (the current device keeps running) and device_open_failed
    // when the open fails (the host keeps retrying it under its backoff).
    virtual DeviceInfo selectDevice(const std::string& id) = 0;
};

}  // namespace siann::protocol
