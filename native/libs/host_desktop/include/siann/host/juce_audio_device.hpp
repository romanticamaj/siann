#pragma once

// AudioDevice backed by JUCE (architecture spec, "siann-host"; ADR-0017: JUCE 9
// under AGPLv3). WASAPI, ASIO, CoreAudio, ALSA and JACK, depending on the
// platform. JUCE stays behind this header: callers never include JUCE.

#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "siann/host/interfaces.hpp"

namespace siann::host {

struct DeviceDescription {
    std::string type;  // JUCE device type, for example "Windows Audio" or "ASIO"
    std::string name;
    bool isDefault = false;
};

class DeviceError : public std::runtime_error {
public:
    DeviceError(std::string code, const std::string& message)
        : std::runtime_error(message), code_(std::move(code)) {}

    // One of: no_device, device_open_failed.
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

class JuceAudioDevice final : public AudioDevice {
public:
    JuceAudioDevice();
    ~JuceAudioDevice() override;
    JuceAudioDevice(const JuceAudioDevice&) = delete;
    JuceAudioDevice& operator=(const JuceAudioDevice&) = delete;

    // Output devices of every available type, after a fresh scan.
    static std::vector<DeviceDescription> listOutputDevices();

    // True for device types whose backend accepts any rate and converts it
    // itself with the OS converter: JUCE's WASAPI shared mode ("Windows
    // Audio"), which opens with AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM.
    static bool convertsSampleRateItself(const std::string& deviceType);

    // The open sequence of open(), with the backend call injected. tryOpen
    // opens the device at a rate (0 = the device's own current rate) and
    // returns an error message, empty on success. A backend that converts
    // rates itself is asked for 0 only. Any other is asked for sessionRate
    // first and, if it refuses (WASAPI exclusive mode, CoreAudio), once more
    // for 0. Throws DeviceError("device_open_failed") if both attempts fail.
    static void openWithRateFallback(const std::string& deviceType, std::int64_t sessionRate,
                                     const std::function<std::string(double rate)>& tryOpen);

    // deviceId is "<type>/<name>", or empty for the default output device of
    // the first available type. The device is asked for the requested sample
    // rate. If it cannot run at it, it ends up at its own rate and the status
    // reports that rate: ASIO falls back to a supported rate by itself, and a
    // backend that refuses the rate (WASAPI exclusive mode, CoreAudio) is
    // reopened at its current rate (openWithRateFallback). A backend that
    // would convert any rate itself (convertsSampleRateItself: WASAPI shared
    // mode) is never asked for the session rate; it opens at the OS mix rate.
    // Either way the graph driver then plays through device-side SRC, so the
    // session is never silently converted.
    AudioDeviceStatus open(const AudioDeviceConfig& config) override;
    void start(AudioCallback callback) override;
    void stop() override;
    void close() override;
    void setOnStopped(std::function<void(bool lost)> handler) override;

    // The device's current sample rates, for choosing a session rate.
    std::vector<double> availableSampleRates() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::host
