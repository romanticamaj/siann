#pragma once

// Callback timing for siann-cli bench (architecture spec, "Production-level
// criteria": an xrun is a deadline miss). CallbackTimer counts device
// callbacks and those that took longer than their buffer period; TimedDevice
// wraps any AudioDevice and times each callback around the inner one, so the
// graph driver needs no change. Both are realtime-safe: the audio thread only
// writes atomics, the control side only reads them.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <limits>
#include <utility>

#include "siann/host/interfaces.hpp"

namespace siann::cli {

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

// An AudioDevice decorator: times every callback into a CallbackTimer and
// counts the device frames passed to the inner callback. Once the frame limit
// is reached it stops calling the inner callback and outputs silence, so a run
// of N device frames is exact whatever the control thread's timing.
class TimedDevice final : public host::AudioDevice {
public:
    static constexpr std::int64_t kNoLimit = std::numeric_limits<std::int64_t>::max();

    TimedDevice(host::AudioDevice& inner, CallbackTimer& timer) : inner_(inner), timer_(timer) {}

    host::AudioDeviceStatus open(const host::AudioDeviceConfig& config) override {
        status_ = inner_.open(config);
        rate_.store(status_.sampleRate, std::memory_order_release);
        return status_;
    }

    void start(host::AudioCallback callback) override {
        callback_ = std::move(callback);
        frames_.store(0, std::memory_order_release);
        reached_.store(false, std::memory_order_release);
        inner_.start([this](const host::AudioBufferView& input, const host::AudioBufferView& output) {
            onCallback(input, output);
        });
    }

    void setOnStopped(std::function<void(bool lost)> handler) override { inner_.setOnStopped(std::move(handler)); }
    void stop() override { inner_.stop(); }
    void close() override { inner_.close(); }

    // What the inner device reported when it was opened.
    const host::AudioDeviceStatus& status() const noexcept { return status_; }

    // Device frames passed to the inner callback since start().
    std::int64_t frames() const noexcept { return frames_.load(std::memory_order_acquire); }

    // Any thread. The inner callback runs until `frames()` reaches `limit`,
    // in whole device buffers.
    void setFrameLimit(std::int64_t limit) noexcept { limit_.store(limit, std::memory_order_release); }
    bool limitReached() const noexcept { return reached_.load(std::memory_order_acquire); }

private:
    void onCallback(const host::AudioBufferView& input, const host::AudioBufferView& output) noexcept {
        const std::int64_t done = frames_.load(std::memory_order_relaxed);
        if (done >= limit_.load(std::memory_order_acquire)) {
            output.clear();
            reached_.store(true, std::memory_order_release);
            return;
        }
        const auto begin = std::chrono::steady_clock::now();
        callback_(input, output);
        const auto end = std::chrono::steady_clock::now();
        timer_.record(output.frames, rate_.load(std::memory_order_relaxed),
                      std::chrono::duration_cast<std::chrono::nanoseconds>(end - begin).count());
        const std::int64_t total = done + output.frames;
        frames_.store(total, std::memory_order_release);
        if (total >= limit_.load(std::memory_order_acquire)) {
            reached_.store(true, std::memory_order_release);
        }
    }

    host::AudioDevice& inner_;
    CallbackTimer& timer_;
    host::AudioCallback callback_;
    host::AudioDeviceStatus status_{};
    std::atomic<std::int64_t> rate_{0};
    std::atomic<std::int64_t> frames_{0};
    std::atomic<std::int64_t> limit_{kNoLimit};
    std::atomic<bool> reached_{false};
};

}  // namespace siann::cli
