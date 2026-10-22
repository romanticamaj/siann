#pragma once

// An audio device driven by the test itself: pump() runs the callback on the
// calling thread, marked realtime, one block at a time. Use it where a test
// must know exactly which block a change lands in.

#include <cstdint>
#include <functional>
#include <vector>

#include "siann/host/interfaces.hpp"

namespace siann::host {

class ManualAudioDevice final : public AudioDevice {
public:
    AudioDeviceStatus open(const AudioDeviceConfig& config) override;
    void start(AudioCallback callback) override { callback_ = std::move(callback); }
    // pump() is synchronous, so the callback has always exited when stop() runs.
    void stop() override { callback_ = nullptr; }
    void close() override { stop(); }
    void setOnStopped(std::function<void(bool lost)> handler) override { onStopped_ = std::move(handler); }

    // Fills each input sample before its block runs: generator(channel, frame),
    // where frame counts from the first pumped block.
    void setInputGenerator(std::function<float(int channel, std::int64_t frame)> generator) {
        generator_ = std::move(generator);
    }

    // Runs `blocks` callbacks and appends channel `channel` of each output.
    void pump(int blocks, std::vector<float>* capture = nullptr, int channel = 0);

    // Reports the device as lost, as a real backend would after its last callback.
    void reportLost() {
        callback_ = nullptr;
        if (onStopped_) {
            onStopped_(true);
        }
    }

private:
    AudioDeviceConfig config_;
    AudioCallback callback_;
    std::function<void(bool)> onStopped_;
    std::function<float(int, std::int64_t)> generator_;
    std::int64_t inputFrame_ = 0;
    std::vector<std::vector<float>> input_;
    std::vector<std::vector<float>> output_;
    std::vector<float*> inputPointers_;
    std::vector<float*> outputPointers_;
};

}  // namespace siann::host
