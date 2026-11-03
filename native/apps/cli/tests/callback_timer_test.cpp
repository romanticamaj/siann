#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

#include "../src/callback_timer.hpp"
#include "../src/cli_internal.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/rt/realtime_thread.hpp"

using siann::cli::CallbackTimer;
using siann::cli::TimedDevice;

namespace {

// Spins (no sleep) until at least `nanos` have passed on the steady clock, so
// the callback is slower than its period on any machine.
void busyWait(std::int64_t nanos) {
    const auto until = std::chrono::steady_clock::now() + std::chrono::nanoseconds(nanos);
    while (std::chrono::steady_clock::now() < until) {
    }
}

// 256 frames at 48 kHz.
constexpr std::int64_t kPeriodNanos = 256LL * 1'000'000'000 / 48'000;

}  // namespace

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

TEST_CASE("CallbackTimer counts callbacks without a known device rate as unmeasured, not as on time", "[cli][bench]") {
    CallbackTimer timer;
    timer.record(256, 0, 1'000'000'000);  // one second: whatever the period, it cannot be called on time
    timer.record(256, -1, 1);
    CHECK(timer.callbacks() == 2);
    CHECK(timer.unmeasured() == 2);
    CHECK(timer.misses() == 0);
    timer.record(256, 48'000, 1);
    CHECK(timer.unmeasured() == 2);
    timer.reset();
    CHECK(timer.unmeasured() == 0);
}

TEST_CASE("TimedDevice counts a callback slower than the buffer period as a deadline miss", "[cli][bench]") {
    siann::host::ManualAudioDevice inner;
    CallbackTimer timer;
    TimedDevice device(inner, timer);
    REQUIRE(device.open(siann::host::AudioDeviceConfig{"", 48'000, 256, 0, 1}).sampleRate == 48'000);

    bool slow = true;
    device.start([&slow](const siann::host::AudioBufferView&, const siann::host::AudioBufferView& output) {
        output.clear();
        if (slow) {
            busyWait(2 * kPeriodNanos);
        }
    });
    inner.pump(1);
    CHECK(timer.callbacks() == 1);
    CHECK(timer.misses() == 1);
    CHECK(timer.unmeasured() == 0);
    CHECK(timer.maxCallbackNanos() > kPeriodNanos);

    slow = false;
    inner.pump(3);
    CHECK(timer.callbacks() == 4);
    CHECK(timer.misses() == 1);
    device.stop();
    device.close();
}

TEST_CASE("TimedDevice reports callbacks of a device with no rate as unmeasured", "[cli][bench]") {
    siann::host::ManualAudioDevice inner;  // reports the rate it is asked for: here none
    CallbackTimer timer;
    TimedDevice device(inner, timer);
    REQUIRE(device.open(siann::host::AudioDeviceConfig{"", 0, 256, 0, 1}).sampleRate == 0);
    device.start([](const siann::host::AudioBufferView&, const siann::host::AudioBufferView& output) {
        output.clear();
        busyWait(2 * kPeriodNanos);
    });
    inner.pump(2);
    CHECK(timer.callbacks() == 2);
    CHECK(timer.unmeasured() == 2);
    CHECK(timer.misses() == 0);
    device.stop();
    device.close();
}

TEST_CASE("bench timing reports the timer's deadline misses as xruns", "[cli][bench]") {
    CallbackTimer timer;
    timer.record(256, 48'000, 1'000);
    timer.record(256, 48'000, 6'000'000);
    timer.record(256, 48'000, 7'500'000);
    const siann::json::Value timing(siann::cli::detail::benchTiming(timer));
    CHECK(timing.find("callbacks")->asString() == "3");
    CHECK(timing.find("xruns")->asString() == "2");
    CHECK(timing.find("maxCallbackMicros")->asNumber() == 7'500.0);
}

TEST_CASE("bench timing refuses callbacks measured without a device rate", "[cli][bench]") {
    CallbackTimer timer;
    timer.record(256, 48'000, 1'000);
    timer.record(256, 0, 1'000);
    std::string code;
    try {
        (void)siann::cli::detail::benchTiming(timer);
    } catch (const siann::cli::detail::CliError& e) {
        code = e.code();
    }
    CHECK(code == "bench_rate_unknown");

    CallbackTimer none;  // no callback at all: nothing was measured either
    code.clear();
    try {
        (void)siann::cli::detail::benchTiming(none);
    } catch (const siann::cli::detail::CliError& e) {
        code = e.code();
    }
    CHECK(code == "bench_no_callbacks");
}
