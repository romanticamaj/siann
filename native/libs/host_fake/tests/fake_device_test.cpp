#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

#include "siann/host/fake_audio_device.hpp"
#include "siann/rt/realtime_thread.hpp"

using siann::host::AudioBufferView;
using siann::host::AudioDeviceConfig;
using siann::host::FakeAudioDevice;

namespace {

AudioDeviceConfig config(int frames = 64, int inputs = 0) {
    AudioDeviceConfig c;
    c.sampleRate = 48'000;
    c.bufferFrames = frames;
    c.inputChannels = inputs;
    c.outputChannels = 2;
    return c;
}

void waitFor(const std::function<bool()>& condition) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!condition() && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

}  // namespace

TEST_CASE("The fake device calls back on a realtime thread until stopped", "[fake_device]") {
    FakeAudioDevice device({});
    const auto status = device.open(config());
    CHECK(status.bufferFrames == 64);
    std::atomic<bool> realtime{false};
    device.start([&](const AudioBufferView&, const AudioBufferView& out) {
        realtime.store(siann::rt::isRealtimeThread());
        out.clear();
    });
    waitFor([&] { return device.callbacks() > 100; });
    device.stop();
    const auto after = device.callbacks();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    CHECK(device.callbacks() == after);  // nothing runs after stop() returns
    CHECK(realtime.load());
    CHECK_FALSE(device.running());
    CHECK_FALSE(device.contractViolated());
}

TEST_CASE("stop() returns only after a slow callback has finished", "[fake_device]") {
    FakeAudioDevice device({});
    device.open(config());
    std::atomic<bool> inside{false};
    std::atomic<bool> finished{false};
    device.start([&](const AudioBufferView&, const AudioBufferView&) {
        inside.store(true);
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
        finished.store(true);
    });
    waitFor([&] { return inside.load(); });
    device.stop();
    CHECK(finished.load());
}

TEST_CASE("Unplugging stops the device and reports it as lost", "[fake_device]") {
    FakeAudioDevice device({});
    device.open(config());
    std::mutex m;
    std::condition_variable cv;
    bool reported = false;
    bool lostFlag = false;
    device.setOnStopped([&](bool lost) {
        std::lock_guard lock(m);
        reported = true;
        lostFlag = lost;
        cv.notify_all();
    });
    device.start([](const AudioBufferView&, const AudioBufferView&) {});
    waitFor([&] { return device.callbacks() > 10; });
    device.simulateUnplug();
    {
        std::unique_lock lock(m);
        cv.wait_for(lock, std::chrono::seconds(10), [&] { return reported; });
    }
    CHECK(reported);
    CHECK(lostFlag);
    CHECK(device.lost());
    const auto after = device.callbacks();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    CHECK(device.callbacks() == after);
    device.stop();  // still safe after the device stopped itself
}

TEST_CASE("Loopback delays output into input by the total device latency", "[fake_device]") {
    FakeAudioDevice::Options options;
    options.loopback = true;
    options.inputLatencyFrames = 48;
    options.outputLatencyFrames = 80;
    options.stopAfterCallbacks = 20;
    FakeAudioDevice device(options);
    device.open(config(64, 1));

    std::int64_t frame = 0;
    std::vector<float> captured;
    device.start([&](const AudioBufferView& in, const AudioBufferView& out) {
        for (int i = 0; i < out.frames; ++i) {
            const float v = frame + i == 300 ? 1.0f : 0.0f;  // an impulse at output frame 300
            out.channel(0)[i] = v;
            out.channel(1)[i] = v;
            captured.push_back(in.channel(0)[i]);
        }
        frame += out.frames;
    });
    waitFor([&] { return !device.running(); });
    device.stop();
    REQUIRE(captured.size() == 20u * 64u);
    std::size_t at = 0;
    for (std::size_t i = 0; i < captured.size(); ++i) {
        if (captured[i] != 0.0f) {
            at = i;
        }
    }
    CHECK(at == 300u + 48u + 80u);
}

TEST_CASE("Loopback latency shorter than a buffer is rejected", "[fake_device]") {
    FakeAudioDevice::Options options;
    options.loopback = true;
    options.inputLatencyFrames = 10;
    FakeAudioDevice device(options);
    CHECK_THROWS(device.open(config(64, 1)));
}

TEST_CASE("The device loop itself does not allocate", "[fake_device][alloc]") {
    FakeAudioDevice::Options options;
    options.stopAfterCallbacks = 500;
    FakeAudioDevice device(options);
    device.open(config());
    const auto before = siann::rt::allocationViolations();
    device.start([](const AudioBufferView&, const AudioBufferView& out) { out.clear(); });
    waitFor([&] { return !device.running(); });
    device.stop();
    CHECK(siann::rt::allocationViolations() == before);
}
