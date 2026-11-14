#pragma once

// A decoder seam for the import tests (m5b-engine-project-media): an AudioSource
// that generates a sine, never touching the disk, and holds once inside read()
// when it reaches `holdAt` frames until the test releases it or the job
// interrupts it (cancellation). The gate is shared, so the test keeps it after
// the source moved into the job. No sleeps: every wait is on the gate's
// condition.

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <numbers>

#include "siann/media/audio_source.hpp"

namespace siann::test {

struct SourceGate {
    std::mutex mutex;
    std::condition_variable changed;
    bool reached = false;
    bool released = false;
    bool interrupted = false;

    // Waits until the source holds; false after the timeout (a broken test, not a race).
    bool waitReached(std::chrono::milliseconds timeout = std::chrono::milliseconds(60'000)) {
        std::unique_lock lock(mutex);
        return changed.wait_for(lock, timeout, [this] { return reached; });
    }
    void release() {
        {
            std::lock_guard lock(mutex);
            released = true;
        }
        changed.notify_all();
    }
    bool wasInterrupted() {
        std::lock_guard lock(mutex);
        return interrupted;
    }
};

class PacedSource final : public media::AudioSource {
public:
    PacedSource(media::AudioInfo info, std::int64_t holdAt, std::shared_ptr<SourceGate> gate)
        : info_(info), holdAt_(holdAt), gate_(std::move(gate)) {}

    media::AudioInfo info() const override { return info_; }

    std::int64_t read(float* out, std::int64_t frames) override {
        if (!passed_ && position_ >= holdAt_) {
            std::unique_lock lock(gate_->mutex);
            gate_->reached = true;
            gate_->changed.notify_all();
            gate_->changed.wait(lock, [this] { return gate_->released || gate_->interrupted; });
            passed_ = true;
        }
        const std::int64_t n = std::max<std::int64_t>(0, std::min(frames, info_.frames - position_));
        for (std::int64_t i = 0; i < n; ++i) {
            const double t = static_cast<double>(position_ + i) / static_cast<double>(info_.sampleRate);
            for (std::int32_t c = 0; c < info_.channels; ++c) {
                out[i * info_.channels + c] =
                    static_cast<float>(0.25 * std::sin(2.0 * std::numbers::pi * (440.0 + 220.0 * c) * t));
            }
        }
        position_ += n;
        return n;
    }

    void interrupt() noexcept override {
        {
            std::lock_guard lock(gate_->mutex);
            gate_->interrupted = true;
        }
        gate_->changed.notify_all();
    }

private:
    media::AudioInfo info_;
    std::int64_t holdAt_;
    std::shared_ptr<SourceGate> gate_;
    std::int64_t position_ = 0;
    bool passed_ = false;
};

}  // namespace siann::test
