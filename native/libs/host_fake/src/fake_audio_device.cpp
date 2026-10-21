#include "siann/host/fake_audio_device.hpp"

#include <algorithm>
#include <chrono>
#include <stdexcept>

#include "siann/rt/realtime_thread.hpp"

namespace siann::host {

FakeAudioDevice::FakeAudioDevice(Options options) : options_(options) {}

FakeAudioDevice::~FakeAudioDevice() {
    stop();
}

AudioDeviceStatus FakeAudioDevice::open(const AudioDeviceConfig& config) {
    std::lock_guard lock(controlMutex_);
    if (config.bufferFrames <= 0 || config.sampleRate <= 0 || config.outputChannels <= 0 ||
        config.inputChannels < 0) {
        throw std::invalid_argument("invalid fake device configuration");
    }
    config_ = config;
    const auto frames = static_cast<std::size_t>(config.bufferFrames);
    input_.assign(static_cast<std::size_t>(config.inputChannels), std::vector<float>(frames, 0.0f));
    output_.assign(static_cast<std::size_t>(config.outputChannels), std::vector<float>(frames, 0.0f));
    inputPointers_.clear();
    outputPointers_.clear();
    for (auto& channel : input_) {
        inputPointers_.push_back(channel.data());
    }
    for (auto& channel : output_) {
        outputPointers_.push_back(channel.data());
    }
    const auto loopLength =
        static_cast<std::size_t>(options_.inputLatencyFrames) + static_cast<std::size_t>(options_.outputLatencyFrames);
    if (options_.loopback && loopLength < frames) {
        // Input for a block may only depend on output of earlier blocks.
        throw std::invalid_argument("loopback latency must be at least one buffer");
    }
    loop_.assign(options_.loopback ? output_.size() : 0, std::vector<float>(loopLength, 0.0f));
    loopPosition_ = 0;
    return AudioDeviceStatus{config.sampleRate, config.bufferFrames, options_.inputLatencyFrames,
                             options_.outputLatencyFrames};
}

void FakeAudioDevice::setOnStopped(std::function<void(bool lost)> handler) {
    std::lock_guard lock(controlMutex_);
    onStopped_ = std::move(handler);
}

void FakeAudioDevice::start(AudioCallback callback) {
    std::lock_guard lock(controlMutex_);
    if (running_.load()) {
        throw std::logic_error("the fake device is already running");
    }
    if (thread_.joinable()) {
        thread_.join();  // a previous run ended on its own
    }
    callback_ = std::move(callback);
    stopRequested_.store(false);
    unplug_.store(false);
    lost_.store(false);
    stopReturned_.store(false);
    running_.store(true, std::memory_order_release);
    thread_ = std::thread([this] { run(); });
}

void FakeAudioDevice::stop() {
    std::lock_guard lock(controlMutex_);
    stopRequested_.store(true, std::memory_order_release);
    if (thread_.joinable()) {
        thread_.join();
    }
    running_.store(false, std::memory_order_release);
    stopReturned_.store(true, std::memory_order_release);
}

void FakeAudioDevice::close() {
    stop();
}

void FakeAudioDevice::run() {
    bool lost = false;
    {
        const rt::ScopedRealtimeThread realtime;
        const auto frames = config_.bufferFrames;
        const AudioBufferView in{inputPointers_.data(), static_cast<int>(inputPointers_.size()), frames};
        const AudioBufferView out{outputPointers_.data(), static_cast<int>(outputPointers_.size()), frames};
        const auto period = std::chrono::nanoseconds(static_cast<std::int64_t>(1e9 * frames / config_.sampleRate));
        auto next = std::chrono::steady_clock::now();

        while (!stopRequested_.load(std::memory_order_acquire)) {
            if (options_.stopAfterCallbacks >= 0 && callbacks_.load() >= options_.stopAfterCallbacks) {
                break;
            }
            // Loopback input: what the device played inputLatency + outputLatency frames ago.
            if (options_.loopback) {
                const std::size_t length = loop_.front().size();
                for (std::size_t c = 0; c < input_.size(); ++c) {
                    const auto& ring = loop_[std::min(c, loop_.size() - 1)];
                    for (int i = 0; i < frames; ++i) {
                        input_[c][static_cast<std::size_t>(i)] = ring[(loopPosition_ + static_cast<std::size_t>(i)) % length];
                    }
                }
            }

            inCallback_.store(true, std::memory_order_release);
            if (stopReturned_.load(std::memory_order_acquire)) {
                violated_.store(true, std::memory_order_release);
            }
            callback_(in, out);
            inCallback_.store(false, std::memory_order_release);
            callbacks_.fetch_add(1, std::memory_order_acq_rel);

            if (options_.loopback) {
                const std::size_t length = loop_.front().size();
                for (std::size_t c = 0; c < loop_.size(); ++c) {
                    for (int i = 0; i < frames; ++i) {
                        loop_[c][(loopPosition_ + static_cast<std::size_t>(i)) % length] =
                            output_[c][static_cast<std::size_t>(i)];
                    }
                }
                loopPosition_ = (loopPosition_ + static_cast<std::size_t>(frames)) % length;
            }

            if (unplug_.load(std::memory_order_acquire)) {
                lost = true;
                break;
            }
            if (options_.paced) {
                next += period;
                std::this_thread::sleep_until(next);
            }
        }
    }
    const bool selfStopped = !stopRequested_.load(std::memory_order_acquire);
    lost_.store(lost, std::memory_order_release);
    running_.store(false, std::memory_order_release);
    if (selfStopped && onStopped_) {
        onStopped_(lost);
    }
}

}  // namespace siann::host
