#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "../src/callback_timer.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/rt/realtime_thread.hpp"

using siann::cli::CallbackTimer;
using siann::cli::TimedDevice;

// The buffer period is frames * 1e9 / deviceRate nanoseconds; a callback that
// takes longer is a deadline miss (an xrun in the production criteria).
TEST_CASE("CallbackTimer counts callbacks and deadline misses against the buffer period", "[cli][bench]") {
    CallbackTimer timer;
    CHECK(timer.callbacks() == 0);
    CHECK(timer.misses() == 0);
    CHECK(timer.maxCallbackNanos() == 0);

    // 480 frames at 48 kHz: exactly 10 ms.
    timer.record(480, 48'000, 9'000'000);
    timer.record(480, 48'000, 10'000'000);  // exactly the period: not a miss
    CHECK(timer.callbacks() == 2);
    CHECK(timer.misses() == 0);
    timer.record(480, 48'000, 10'000'001);
    CHECK(timer.misses() == 1);

    // 256 frames at 48 kHz: 5,333,333.3 ns.
    timer.record(256, 48'000, 5'333'333);
    CHECK(timer.misses() == 1);
    timer.record(256, 48'000, 5'333'334);
    CHECK(timer.misses() == 2);

    // 441 frames at 44.1 kHz: 10 ms as well.
    timer.record(441, 44'100, 10'000'000);
    CHECK(timer.misses() == 2);
    CHECK(timer.callbacks() == 6);
}

TEST_CASE("CallbackTimer keeps the longest callback and resets", "[cli][bench]") {
    CallbackTimer timer;
    timer.record(256, 48'000, 1'000);
    timer.record(256, 48'000, 7'000'000);
    timer.record(256, 48'000, 2'000);
    CHECK(timer.maxCallbackNanos() == 7'000'000);
    CHECK(timer.misses() == 1);

    timer.reset();
    CHECK(timer.callbacks() == 0);
    CHECK(timer.misses() == 0);
    CHECK(timer.maxCallbackNanos() == 0);
    timer.record(128, 48'000, 500);
    CHECK(timer.callbacks() == 1);
    CHECK(timer.maxCallbackNanos() == 500);
}

TEST_CASE("CallbackTimer does not allocate on the audio thread", "[cli][bench][realtime]") {
    CallbackTimer timer;
    const auto before = siann::rt::allocationViolations();
    {
        siann::rt::ScopedRealtimeThread realtime;
        for (int i = 0; i < 1'000; ++i) {
            timer.record(256, 48'000, i * 10'000);
        }
    }
    CHECK(siann::rt::allocationViolations() == before);
    CHECK(timer.callbacks() == 1'000);
}

TEST_CASE("TimedDevice times every forwarded callback and stops forwarding at its frame limit", "[cli][bench]") {
    siann::host::ManualAudioDevice inner;
    CallbackTimer timer;
    TimedDevice device(inner, timer);
    const auto status = device.open(siann::host::AudioDeviceConfig{"", 48'000, 256, 0, 1});
    CHECK(status.sampleRate == 48'000);
    CHECK(device.status().bufferFrames == 256);

    int calls = 0;
    device.start([&calls](const siann::host::AudioBufferView&, const siann::host::AudioBufferView& output) {
        ++calls;
        for (int i = 0; i < output.frames; ++i) {
            output.channel(0)[i] = 1.0f;
        }
    });
    device.setFrameLimit(600);  // reached inside the third block
    CHECK_FALSE(device.limitReached());

    std::vector<float> captured;
    captured.reserve(4 * 256);
    const auto before = siann::rt::allocationViolations();
    inner.pump(4, &captured);
    CHECK(siann::rt::allocationViolations() == before);

    CHECK(calls == 3);
    CHECK(timer.callbacks() == 3);
    CHECK(device.frames() == 768);
    CHECK(device.limitReached());
    REQUIRE(captured.size() == 4 * 256);
    CHECK(captured[3 * 256 - 1] == 1.0f);
    CHECK(captured[3 * 256] == 0.0f);  // past the limit the device outputs silence
    CHECK(captured[4 * 256 - 1] == 0.0f);
    device.stop();
    device.close();
}
