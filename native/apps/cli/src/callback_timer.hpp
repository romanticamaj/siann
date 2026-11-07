#pragma once

// Callback timing for siann-cli bench (architecture spec, "Production-level
// criteria": an xrun is a deadline miss). The counter itself is
// siann::rt::CallbackTimer, shared with the graph driver, which times every
// callback into its own; TimedDevice wraps any AudioDevice, times each
// callback around the inner one into the bench's timer and bounds the run in
// device frames. Realtime-safe: the audio thread only writes atomics, the
// control side only reads them.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <limits>
#include <utility>

#include "siann/host/interfaces.hpp"
#include "siann/rt/callback_timer.hpp"

namespace siann::cli {

using CallbackTimer = rt::CallbackTimer;

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

    // Control side, before start(): the run's length in device frames, given
    // the rate the inner device reported at open(). start() applies it as the
    // frame limit before the inner device starts, so callbacks that run before
    // start() returns count toward it. Without one, start() sets no limit.
    void setRunLength(std::function<std::int64_t(std::int64_t deviceRate)> length) { runLength_ = std::move(length); }

    void start(host::AudioCallback callback) override {
        callback_ = std::move(callback);
        frames_.store(0, std::memory_order_release);
        reached_.store(false, std::memory_order_release);
        limit_.store(runLength_ ? runLength_(status_.sampleRate) : kNoLimit, std::memory_order_release);
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
    std::function<std::int64_t(std::int64_t)> runLength_;
    host::AudioDeviceStatus status_{};
    std::atomic<std::int64_t> rate_{0};
    std::atomic<std::int64_t> frames_{0};
    std::atomic<std::int64_t> limit_{kNoLimit};
    std::atomic<bool> reached_{false};
};

}  // namespace siann::cli
