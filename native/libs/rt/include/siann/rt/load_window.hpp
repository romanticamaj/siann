#pragma once

// DSP load (m5b-engine-load-loudness, Protocol v0 item 30): the fraction of the
// device period the audio callback used. The graph driver feeds every callback's
// duration, from the same two clock reads as its CallbackTimer, into a
// LoadWindow. A tumbling window that has covered at least one second of device
// frames publishes the average (the sum of the durations over the sum of the
// periods) and the peak (the largest single callback's fraction) and starts
// over. Realtime-safe: record() touches plain members and writes two atomics;
// the control side only reads them, and resets while no callback runs.

#include <algorithm>
#include <atomic>
#include <cstdint>

#include "siann/rt/spsc_queue.hpp"  // kCacheLine

namespace siann::rt {

class LoadWindow {
public:
    // Audio thread. A callback without a device rate or frames has no period
    // and contributes nothing.
    void record(int frames, std::int64_t deviceRate, std::int64_t durationNanos) noexcept {
        if (deviceRate <= 0 || frames <= 0) {
            return;
        }
        const double period = static_cast<double>(frames) * kNanosPerSecond / static_cast<double>(deviceRate);
        const auto duration = static_cast<double>(std::max<std::int64_t>(durationNanos, 0));
        windowFrames_ += frames;
        windowNanos_ += duration;
        windowPeriods_ += period;
        windowPeak_ = std::max(windowPeak_, duration / period);
        if (windowFrames_ >= deviceRate) {
            average_.store(windowNanos_ / windowPeriods_, std::memory_order_relaxed);
            peak_.store(windowPeak_, std::memory_order_relaxed);
            restart();
        }
    }

    // The last full window's values; 0 before the first one.
    double average() const noexcept { return average_.load(std::memory_order_relaxed); }
    double peak() const noexcept { return peak_.load(std::memory_order_relaxed); }

    // Control side, while no callback runs.
    void reset() noexcept {
        restart();
        average_.store(0.0, std::memory_order_relaxed);
        peak_.store(0.0, std::memory_order_relaxed);
    }

private:
    static constexpr double kNanosPerSecond = 1e9;
    static_assert(std::atomic<double>::is_always_lock_free);

    void restart() noexcept {
        windowFrames_ = 0;
        windowNanos_ = 0.0;
        windowPeriods_ = 0.0;
        windowPeak_ = 0.0;
    }

    // Audio side.
    std::int64_t windowFrames_ = 0;
    double windowNanos_ = 0.0;
    double windowPeriods_ = 0.0;
    double windowPeak_ = 0.0;
    // Read anywhere; on their own cache line, away from the audio side's fields.
    alignas(kCacheLine) std::atomic<double> average_{0.0};
    std::atomic<double> peak_{0.0};
};

}  // namespace siann::rt
