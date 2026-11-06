#pragma once

// Callback timing (architecture spec, "Production-level criteria": an xrun is
// a deadline miss, separate from disk underruns and SRC underfill; "Realtime
// rules and enforcement": the wait a hosted plugin's processBlock can cause
// must be visible). CallbackTimer counts device callbacks and those that took
// longer than their buffer period, and keeps the longest. Realtime-safe: the
// audio thread only writes atomics, the control side only reads them. The
// graph driver times every callback into one; siann-cli bench times its
// TimedDevice into another.

#include <atomic>
#include <cstdint>

namespace siann::rt {

class CallbackTimer {
public:
    // Audio thread. A callback of `frames` device frames at `deviceRate` that
    // took longer than frames * 1e9 / deviceRate nanoseconds missed its
    // deadline; exactly the period is not a miss. Without a device rate
    // (deviceRate <= 0) there is no period: the callback is counted as
    // unmeasured, never as on time.
    void record(int frames, std::int64_t deviceRate, std::int64_t durationNanos) noexcept {
        callbacks_.fetch_add(1, std::memory_order_relaxed);
        if (deviceRate <= 0) {
            unmeasured_.fetch_add(1, std::memory_order_relaxed);
        } else if (durationNanos * deviceRate > static_cast<std::int64_t>(frames) * kNanosPerSecond) {
            // Integer comparison: durationNanos / 1e9 > frames / deviceRate.
            misses_.fetch_add(1, std::memory_order_relaxed);
        }
        std::int64_t longest = maxNanos_.load(std::memory_order_relaxed);
        while (durationNanos > longest &&
               !maxNanos_.compare_exchange_weak(longest, durationNanos, std::memory_order_relaxed)) {
        }
    }

    std::uint64_t callbacks() const noexcept { return callbacks_.load(std::memory_order_relaxed); }
    // Deadline misses: the spec's xruns.
    std::uint64_t misses() const noexcept { return misses_.load(std::memory_order_relaxed); }
    // Callbacks recorded without a device rate, so not checked against a deadline.
    std::uint64_t unmeasured() const noexcept { return unmeasured_.load(std::memory_order_relaxed); }
    std::int64_t maxCallbackNanos() const noexcept { return maxNanos_.load(std::memory_order_relaxed); }

    // Control side, while no callback runs.
    void reset() noexcept {
        callbacks_.store(0, std::memory_order_relaxed);
        misses_.store(0, std::memory_order_relaxed);
        unmeasured_.store(0, std::memory_order_relaxed);
        maxNanos_.store(0, std::memory_order_relaxed);
    }

private:
    static constexpr std::int64_t kNanosPerSecond = 1'000'000'000;

    std::atomic<std::uint64_t> callbacks_{0};
    std::atomic<std::uint64_t> misses_{0};
    std::atomic<std::uint64_t> unmeasured_{0};
    std::atomic<std::int64_t> maxNanos_{0};
};

}  // namespace siann::rt
