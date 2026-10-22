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

    // One of: no_device, device_open_failed, sample_rate_unsupported.
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

    // deviceId is "<type>/<name>", or empty for the default output device of
    // the first available type. The device must run at the requested sample
    // rate (sample_rate_unsupported otherwise; device-side SRC comes later).
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
