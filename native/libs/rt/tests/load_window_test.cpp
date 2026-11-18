// rt::LoadWindow (m5b-engine-load-loudness, Protocol v0 item 31): the DSP load
// engine.status reports, from the callback durations the driver already times.
// The durations here are scripted; nothing reads a clock.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>

#include "siann/rt/load_window.hpp"
#include "siann/rt/realtime_thread.hpp"

using siann::rt::LoadWindow;

namespace {

constexpr std::int64_t kRate = 48'000;
constexpr int kFrames = 480;  // a 10 ms period
constexpr std::int64_t kMs = 1'000'000;

bool near(double a, double b) {
    return std::abs(a - b) <= 1e-9;
}

}  // namespace

TEST_CASE("LoadWindow publishes the average and the peak of a full second of device frames", "[rt][load]") {
    LoadWindow window;
    // 100 callbacks of 10 ms: 99 take 2 ms, one 8 ms.
    for (int i = 0; i < 99; ++i) {
        window.record(kFrames, kRate, 2 * kMs);
    }
    window.record(kFrames, kRate, 8 * kMs);
    CHECK(near(window.average(), (99.0 * 2.0 + 8.0) / 1'000.0));
    CHECK(near(window.peak(), 0.8));

    // The next second replaces it once it is full, not before.
    for (int i = 0; i < 99; ++i) {
        window.record(kFrames, kRate, 5 * kMs);
    }
    CHECK(near(window.average(), 0.206));
    CHECK(near(window.peak(), 0.8));
    window.record(kFrames, kRate, 5 * kMs);
    CHECK(near(window.average(), 0.5));
    CHECK(near(window.peak(), 0.5));
}

TEST_CASE("LoadWindow reports nothing before the first full window", "[rt][load]") {
    LoadWindow window;
    CHECK(window.average() == 0.0);
    CHECK(window.peak() == 0.0);
    for (int i = 0; i < 99; ++i) {
        window.record(kFrames, kRate, 9 * kMs);
    }
    CHECK(window.average() == 0.0);
    CHECK(window.peak() == 0.0);
}

TEST_CASE("LoadWindow: a callback over its period reads above 1", "[rt][load]") {
    LoadWindow window;
    for (int i = 0; i < 100; ++i) {
        window.record(kFrames, kRate, 15 * kMs);
    }
    CHECK(near(window.average(), 1.5));
    CHECK(near(window.peak(), 1.5));
}

TEST_CASE("LoadWindow: unmeasured callbacks contribute nothing", "[rt][load]") {
    LoadWindow window;
    for (int i = 0; i < 100; ++i) {
        window.record(kFrames, kRate, 3 * kMs);
        window.record(kFrames, 0, 900 * kMs);   // no device rate
        window.record(kFrames, -1, 900 * kMs);  // nor this
        window.record(0, kRate, 900 * kMs);     // no frames
    }
    CHECK(near(window.average(), 0.3));
    CHECK(near(window.peak(), 0.3));
}

TEST_CASE("LoadWindow: blocks of different sizes weigh by their period", "[rt][load]") {
    LoadWindow window;
    // 24,000 frames at 256 and 24,000 at 1,024 (by frame count, about half each):
    // the average is the sum of durations over the sum of periods.
    std::int64_t frames = 0;
    double durations = 0.0;
    double peak = 0.0;
    while (frames < kRate) {
        const int n = frames < kRate / 2 ? 256 : 1'024;
        const std::int64_t duration = n == 256 ? 4 * kMs : 1 * kMs;
        window.record(n, kRate, duration);
        frames += n;
        durations += static_cast<double>(duration);
        const double fraction = static_cast<double>(duration) * static_cast<double>(kRate) / (n * 1e9);
        peak = std::max(peak, fraction);
    }
    const double periods = static_cast<double>(frames) * 1e9 / static_cast<double>(kRate);
    CHECK(near(window.average(), durations / periods));
    CHECK(near(window.peak(), peak));
}

TEST_CASE("LoadWindow: reset clears the published values and the window in progress", "[rt][load]") {
    LoadWindow window;
    for (int i = 0; i < 100; ++i) {
        window.record(kFrames, kRate, 2 * kMs);
    }
    REQUIRE(window.average() > 0.0);
    for (int i = 0; i < 50; ++i) {
        window.record(kFrames, kRate, 9 * kMs);  // half a window, discarded by the reset
    }
    window.reset();
    CHECK(window.average() == 0.0);
    CHECK(window.peak() == 0.0);
    for (int i = 0; i < 100; ++i) {
        window.record(kFrames, kRate, 1 * kMs);
    }
    CHECK(near(window.average(), 0.1));
    CHECK(near(window.peak(), 0.1));
}

TEST_CASE("LoadWindow: record does not allocate on a realtime thread", "[rt][load][alloc]") {
    LoadWindow window;
    const std::uint64_t before = siann::rt::allocationViolations();
    {
        siann::rt::ScopedRealtimeThread realtime;
        for (int i = 0; i < 1'000; ++i) {
            window.record(kFrames, kRate, 2 * kMs);
        }
        (void)window.average();
        (void)window.peak();
    }
    CHECK(siann::rt::allocationViolations() == before);
}
