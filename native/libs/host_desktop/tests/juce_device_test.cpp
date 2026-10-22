// Tests against the machine's real audio hardware. They output silence only,
// and skip when the machine has no output device (CI runners usually do not).

#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <memory>
#include <thread>

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

// Opens the default output at a rate it supports, preferring 48 kHz.
host::AudioDeviceConfig workingConfig() {
    host::AudioDeviceConfig config;
    config.outputChannels = 2;
    config.bufferFrames = 256;
    for (const std::int64_t rate : {48'000, 44'100, 96'000}) {
        config.sampleRate = rate;
        try {
            host::JuceAudioDevice probe;
            probe.open(config);
            return config;
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
