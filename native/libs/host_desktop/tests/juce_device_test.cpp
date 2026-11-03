// Tests against the machine's real audio hardware. They output silence only,
// and skip when the machine has no output device (CI runners usually do not).

#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/host/juce_audio_device.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/rt/realtime_thread.hpp"

using namespace siann;

namespace {

class SilenceNode final : public graph::Node {
public:
    int outputChannels() const override { return 2; }
    void process(const graph::ProcessContext& context, std::span<const graph::AudioBufferView>,
                 const graph::AudioBufferView& output) noexcept override {
        for (int c = 0; c < 2; ++c) {
            for (int i = 0; i < context.frames; ++i) {
                output.channel(c)[i] = 0.0f;
            }
        }
    }
};

// A configuration the default output runs at exactly, preferring 48 kHz.
host::AudioDeviceConfig workingConfig() {
    host::AudioDeviceConfig config;
    config.outputChannels = 2;
    config.bufferFrames = 256;
    for (const std::int64_t rate : {48'000, 44'100, 96'000}) {
        config.sampleRate = rate;
        try {
            host::JuceAudioDevice probe;
            if (probe.open(config).sampleRate == rate) {
                return config;
            }
        } catch (const host::DeviceError&) {
        }
    }
    config.sampleRate = 0;
    return config;
}

bool waitFor(const std::function<bool()>& condition) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!condition() && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    return condition();
}

}  // namespace

TEST_CASE("Output devices can be listed", "[juce][hardware]") {
    const auto devices = host::JuceAudioDevice::listOutputDevices();
    for (const auto& d : devices) {
        CHECK_FALSE(d.type.empty());
        CHECK_FALSE(d.name.empty());
    }
    if (devices.empty()) {
        SKIP("no audio output device on this machine");
    }
}

TEST_CASE("The default device calls back on a realtime-marked thread and stops cleanly", "[juce][hardware]") {
    if (host::JuceAudioDevice::listOutputDevices().empty()) {
        SKIP("no audio output device on this machine");
    }
    const auto config = workingConfig();
    if (config.sampleRate == 0) {
        SKIP("the default device opens at none of 48, 44.1 or 96 kHz");
    }
    host::JuceAudioDevice device;
    const auto status = device.open(config);
    CHECK(status.sampleRate == config.sampleRate);
    CHECK(status.bufferFrames > 0);

    std::atomic<int> callbacks{0};
    std::atomic<bool> realtime{true};
    device.start([&](const host::AudioBufferView&, const host::AudioBufferView& out) {
        out.clear();
        realtime.store(realtime.load() && rt::isRealtimeThread());
        callbacks.fetch_add(1);
    });
    REQUIRE(waitFor([&] { return callbacks.load() >= 20; }));
    device.stop();
    const int after = callbacks.load();
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    CHECK(callbacks.load() == after);  // nothing after stop() returns
    CHECK(realtime.load());
    device.close();
}

TEST_CASE("The graph driver plays through the real device", "[juce][hardware]") {
    if (host::JuceAudioDevice::listOutputDevices().empty()) {
        SKIP("no audio output device on this machine");
    }
    const auto config = workingConfig();
    if (config.sampleRate == 0) {
        SKIP("the default device opens at none of 48, 44.1 or 96 kHz");
    }
    realtime::GraphDriver driver({});
    graph::GraphBuilder b;
    b.setOutput(b.add(std::make_unique<SilenceNode>(), "silence"));
    driver.publish(std::move(b).compile(1'024));
    host::JuceAudioDevice device;
    driver.play();
    driver.start(device, config);
    REQUIRE(waitFor([&] {
        driver.poll();
        return driver.playhead() >= config.sampleRate / 4;  // a quarter second of audio
    }));
    driver.stop();
    CHECK(driver.state() == realtime::DriverState::stopped);
}

TEST_CASE("An unsupported device is reported clearly", "[juce]") {
    host::JuceAudioDevice device;
    host::AudioDeviceConfig config;
    config.deviceId = "No Such Type/No Such Device";
    try {
        device.open(config);
        FAIL("expected no_device");
    } catch (const host::DeviceError& error) {
        CHECK(error.code() == "no_device");
    }
}

TEST_CASE("Opening at a rate the device cannot run reports the rate it runs at", "[juce][hardware]") {
    if (host::JuceAudioDevice::listOutputDevices().empty()) {
        SKIP("no audio output device on this machine");
    }
    host::AudioDeviceConfig config;
    config.outputChannels = 2;
    config.bufferFrames = 256;
    // A listed device can still be unusable (an ASIO driver that fails to
    // initialise, a device held by another program). Rate 0 asks for the
    // device's own rate, the fallback every refused rate ends in, so a device
    // that does not open even there says nothing about rate fallback.
    config.sampleRate = 0;
    try {
        host::JuceAudioDevice probe;
        probe.open(config);
    } catch (const host::DeviceError& error) {
        SKIP("the default device does not open at its own rate: " << error.what());
    }
    // Device-side SRC (spec, "Sample rate and media"): a device that cannot
    // run at the session rate opens at its own rate instead of failing.
    for (const std::int64_t rate : {11'025, 22'050, 32'000, 44'100, 48'000, 88'200, 96'000}) {
        config.sampleRate = rate;
        host::JuceAudioDevice device;
        host::AudioDeviceStatus status;
        try {
            status = device.open(config);
        } catch (const host::DeviceError& error) {
            // A device that refuses the rate is reopened at its own rate, so
            // the default device must open for every session rate.
            FAIL("the default device did not open for a " << rate << " Hz session: " << error.what());
        }
        device.close();
        if (status.sampleRate != rate) {
            CHECK(status.sampleRate > 0);
            return;
        }
    }
    SKIP("the default device accepts every tested rate");
}

TEST_CASE("A device that refuses the session rate is reopened at its own rate", "[juce]") {
    // WASAPI exclusive mode and CoreAudio fail to open at a rate they cannot
    // run at instead of falling back like ASIO; the session then plays through
    // device-side SRC at whatever rate the device runs at (rate 0 in JUCE).
    std::vector<double> asked;
    host::JuceAudioDevice::openWithRateFallback("Windows Audio (Exclusive Mode)", 44'100, [&](double rate) {
        asked.push_back(rate);
        return rate == 0.0 ? std::string() : std::string("Couldn't open the output device!");
    });
    CHECK(asked == std::vector<double>{44'100.0, 0.0});
}

TEST_CASE("A device that accepts the session rate is opened once", "[juce]") {
    std::vector<double> asked;
    host::JuceAudioDevice::openWithRateFallback("CoreAudio", 48'000, [&](double rate) {
        asked.push_back(rate);
        return std::string();
    });
    CHECK(asked == std::vector<double>{48'000.0});
}

TEST_CASE("A backend that converts rates itself is asked only for its own rate", "[juce]") {
    std::vector<double> asked;
    host::JuceAudioDevice::openWithRateFallback("Windows Audio", 44'100, [&](double rate) {
        asked.push_back(rate);
        return std::string();
    });
    CHECK(asked == std::vector<double>{0.0});
}

TEST_CASE("A device that opens at neither rate reports both failures", "[juce]") {
    std::vector<double> asked;
    try {
        host::JuceAudioDevice::openWithRateFallback("CoreAudio", 44'100, [&](double rate) {
            asked.push_back(rate);
            return rate == 0.0 ? std::string("device busy") : std::string("Failed to set sample rate");
        });
        FAIL("expected device_open_failed");
    } catch (const host::DeviceError& error) {
        CHECK(error.code() == "device_open_failed");
        const std::string message = error.what();
        CHECK(message.find("Failed to set sample rate") != std::string::npos);
        CHECK(message.find("device busy") != std::string::npos);
    }
    CHECK(asked == std::vector<double>{44'100.0, 0.0});
}

TEST_CASE("Backends that convert any rate themselves are known by type", "[juce]") {
    // JUCE's WASAPI shared mode accepts any rate and converts it with the OS
    // converter (AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM); the other modes and
    // backends run the device at the rate asked or refuse it.
    CHECK(host::JuceAudioDevice::convertsSampleRateItself("Windows Audio"));
    CHECK_FALSE(host::JuceAudioDevice::convertsSampleRateItself("Windows Audio (Low Latency Mode)"));
    CHECK_FALSE(host::JuceAudioDevice::convertsSampleRateItself("Windows Audio (Exclusive Mode)"));
    CHECK_FALSE(host::JuceAudioDevice::convertsSampleRateItself("ASIO"));
    CHECK_FALSE(host::JuceAudioDevice::convertsSampleRateItself("CoreAudio"));
    CHECK_FALSE(host::JuceAudioDevice::convertsSampleRateItself("ALSA"));
}

TEST_CASE("A device that would convert the session rate itself opens at its own rate", "[juce][hardware]") {
    std::string deviceId;
    for (const auto& d : host::JuceAudioDevice::listOutputDevices()) {
        if (host::JuceAudioDevice::convertsSampleRateItself(d.type) && (deviceId.empty() || d.isDefault)) {
            deviceId = d.type + "/" + d.name;
        }
    }
    if (deviceId.empty()) {
        SKIP("no output device whose backend converts rates itself");
    }
    // Spec, "Sample rate and media": the session is never silently converted.
    // Whatever rate is asked for, the device opens at its mix rate, so a
    // session at another rate plays through the engine's own SRC.
    INFO("device " << deviceId);
    host::AudioDeviceConfig config;
    config.deviceId = deviceId;
    config.outputChannels = 2;
    config.bufferFrames = 256;
    std::int64_t mixRate = 0;
    for (const std::int64_t rate : {44'100, 48'000, 96'000}) {
        INFO("asked for " << rate << " Hz");
        config.sampleRate = rate;
        host::JuceAudioDevice device;
        const auto status = device.open(config);
        device.close();
        CHECK(status.sampleRate > 0);
        if (mixRate == 0) {
            mixRate = status.sampleRate;
        }
        CHECK(status.sampleRate == mixRate);
    }
}
