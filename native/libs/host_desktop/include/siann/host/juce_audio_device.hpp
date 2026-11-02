#pragma once

// AudioDevice backed by JUCE (architecture spec, "siann-host"; ADR-0017: JUCE 9
// under AGPLv3). WASAPI, ASIO, CoreAudio, ALSA and JACK, depending on the
// platform. JUCE stays behind this header: callers never include JUCE.

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

    // deviceId is "<type>/<name>", or empty for the default output device of
    // the first available type. The device is asked for the requested sample
    // rate; if it cannot run at it (ASIO falls back to a rate it supports), it
    // opens at its own rate and the status reports that rate. A backend that
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
