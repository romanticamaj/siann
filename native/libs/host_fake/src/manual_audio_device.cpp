#include "siann/host/manual_audio_device.hpp"

#include <stdexcept>

#include "siann/rt/realtime_thread.hpp"

namespace siann::host {

AudioDeviceStatus ManualAudioDevice::open(const AudioDeviceConfig& config) {
    if (config.bufferFrames <= 0 || config.outputChannels <= 0 || config.inputChannels < 0) {
        throw std::invalid_argument("invalid manual device configuration");
    }
    config_ = config;
    if (options_.fixedSampleRate > 0) {
        config_.sampleRate = options_.fixedSampleRate;
    }
    const auto frames = static_cast<std::size_t>(config.bufferFrames);
    input_.assign(static_cast<std::size_t>(config.inputChannels), std::vector<float>(frames, 0.0f));
    output_.assign(static_cast<std::size_t>(config.outputChannels), std::vector<float>(frames, 0.0f));
    inputPointers_.clear();
    outputPointers_.clear();
    for (auto& c : input_) {
        inputPointers_.push_back(c.data());
    }
    for (auto& c : output_) {
        outputPointers_.push_back(c.data());
    }
    return AudioDeviceStatus{config_.sampleRate, config.bufferFrames, 0, 0};
}

void ManualAudioDevice::pump(int blocks, std::vector<float>* capture, int channel) {
    if (!callback_) {
        throw std::logic_error("the manual device is not started");
    }
    const AudioBufferView in{inputPointers_.data(), static_cast<int>(inputPointers_.size()), config_.bufferFrames};
    const AudioBufferView out{outputPointers_.data(), static_cast<int>(outputPointers_.size()), config_.bufferFrames};
    for (int b = 0; b < blocks; ++b) {
        if (generator_) {
            for (std::size_t c = 0; c < input_.size(); ++c) {
                for (int i = 0; i < config_.bufferFrames; ++i) {
                    input_[c][static_cast<std::size_t>(i)] = generator_(static_cast<int>(c), inputFrame_ + i);
                }
            }
        }
        inputFrame_ += config_.bufferFrames;
        {
            const rt::ScopedRealtimeThread realtime;
            callback_(in, out);
        }
        if (capture != nullptr) {
            const auto& samples = output_[static_cast<std::size_t>(channel)];
            capture->insert(capture->end(), samples.begin(), samples.end());
        }
    }
}

void ManualAudioDevice::pumpAll(int blocks, std::vector<std::vector<float>>& captures) {
    captures.resize(output_.size());
    for (int b = 0; b < blocks; ++b) {
        pump(1);
        for (std::size_t c = 0; c < output_.size(); ++c) {
            captures[c].insert(captures[c].end(), output_[c].begin(), output_[c].end());
        }
    }
}

}  // namespace siann::host
