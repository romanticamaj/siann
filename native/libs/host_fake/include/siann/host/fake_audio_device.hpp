#pragma once

// A software audio device for tests (architecture spec, "Build, test and CI":
// "fake device driving callbacks"). Each callback runs with its thread marked
// realtime (the pacing and stall sleeps between callbacks do not), it honours
// the AudioDevice contract that stop() returns only after the callback has
// exited, and it can loop output back to input with a fixed latency and
// simulate unplugging, and run at a fixed rate of its own. Paced, it can run
// faster than real time; its input can be a counter for sample-exact checks.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

#include "siann/host/interfaces.hpp"

namespace siann::host {

class FakeAudioDevice final : public AudioDevice {
public:
    // What the device puts in its input buffers (a POD choice, so the device
    // thread never calls out or allocates for it).
    enum class InputSignal : std::uint8_t {
        none,     // zeros, or loopback when enabled
        counter,  // every channel: (frame mod 2^24) * 2^-24, frame counted from start()
    };

    struct Options {
        bool paced = false;             // sleep for each buffer's duration
        int inputLatencyFrames = 0;     // reported, and applied in loopback
        int outputLatencyFrames = 0;    // reported, and applied in loopback
        bool loopback = false;          // input[t] = output[t - input - output latency]
        std::int64_t stopAfterCallbacks = -1;  // the device stops itself; -1 runs until stop()
        bool stall = false;             // the thread runs but never calls back (a hung driver)
        // Non-zero: the device runs at this rate whatever open() asks for, like
        // WASAPI shared mode at the OS mix rate. Latencies are in its frames.
        std::int64_t fixedSampleRate = 0;
        // Paced runs: this many times faster than real time (the reported rate
        // is unchanged). Must be positive.
        double speed = 1.0;
        // open() reports a sample rate of 0 (a device that does not say), while
        // the blocks still run and are paced at the configured rate: the driver
        // then has no period to check callbacks against.
        bool reportNoSampleRate = false;
        // counter excludes loopback; the latencies are still reported.
        InputSignal inputSignal = InputSignal::none;
    };

    explicit FakeAudioDevice(Options options);
    ~FakeAudioDevice() override;

    AudioDeviceStatus open(const AudioDeviceConfig& config) override;
    void start(AudioCallback callback) override;
    void stop() override;
    void close() override;

    // Called from the device thread after its last callback, when the device
    // stops on its own (unplug or stopAfterCallbacks).
    void setOnStopped(std::function<void(bool lost)> handler) override;

    // Makes the next callback the last one, then reports the device as lost.
    void simulateUnplug() noexcept { unplug_.store(true, std::memory_order_release); }

    const Options& options() const noexcept { return options_; }

    // The wall time a paced run sleeps per buffer, after open():
    // bufferFrames / (sampleRate * speed).
    std::chrono::nanoseconds pacePeriod() const noexcept { return pacePeriod_; }

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
    std::chrono::nanoseconds pacePeriod_{0};
    std::int64_t counterFrame_ = 0;  // device thread, reset by start()

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
