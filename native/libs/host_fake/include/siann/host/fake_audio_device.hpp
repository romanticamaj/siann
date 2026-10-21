#pragma once

// A software audio device for tests (architecture spec, "Build, test and CI":
// "fake device driving callbacks"). Its thread is marked realtime, it honours
// the AudioDevice contract that stop() returns only after the callback has
// exited, and it can loop output back to input with a fixed latency and
// simulate unplugging.

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

#include "siann/host/interfaces.hpp"

namespace siann::host {

class FakeAudioDevice final : public AudioDevice {
public:
    struct Options {
        bool paced = false;             // sleep for each buffer's duration
        int inputLatencyFrames = 0;     // reported, and applied in loopback
        int outputLatencyFrames = 0;    // reported, and applied in loopback
        bool loopback = false;          // input[t] = output[t - input - output latency]
        std::int64_t stopAfterCallbacks = -1;  // the device stops itself; -1 runs until stop()
    };

    explicit FakeAudioDevice(Options options);
    ~FakeAudioDevice() override;

    AudioDeviceStatus open(const AudioDeviceConfig& config) override;
    void start(AudioCallback callback) override;
    void stop() override;
    void close() override;

    // Called from the device thread after its last callback, when the device
    // stops on its own (unplug or stopAfterCallbacks).
    void setOnStopped(std::function<void(bool lost)> handler);

    // Makes the next callback the last one, then reports the device as lost.
    void simulateUnplug() noexcept { unplug_.store(true, std::memory_order_release); }

    std::int64_t callbacks() const noexcept { return callbacks_.load(std::memory_order_acquire); }
    bool running() const noexcept { return running_.load(std::memory_order_acquire); }
    bool lost() const noexcept { return lost_.load(std::memory_order_acquire); }

    // True if a callback ever ran concurrently with a returned stop().
    bool contractViolated() const noexcept { return violated_.load(std::memory_order_acquire); }

private:
    void run();

    Options options_;
    AudioDeviceConfig config_;
    AudioCallback callback_;
    std::function<void(bool)> onStopped_;
    std::thread thread_;
    std::mutex controlMutex_;

    std::vector<std::vector<float>> input_;
    std::vector<std::vector<float>> output_;
    std::vector<float*> inputPointers_;
    std::vector<float*> outputPointers_;
    std::vector<std::vector<float>> loop_;  // per output channel ring
    std::size_t loopPosition_ = 0;

    std::atomic<bool> running_{false};
    std::atomic<bool> stopRequested_{false};
    std::atomic<bool> unplug_{false};
    std::atomic<bool> lost_{false};
    std::atomic<bool> inCallback_{false};
    std::atomic<bool> stopReturned_{false};
    std::atomic<bool> violated_{false};
    std::atomic<std::int64_t> callbacks_{0};
};

}  // namespace siann::host
