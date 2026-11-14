#include "siann/host/manual_audio_device.hpp"

#include <algorithm>
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
    const auto loopLength = static_cast<std::size_t>(std::max(options_.inputLatencyFrames, 0)) +
                            static_cast<std::size_t>(std::max(options_.outputLatencyFrames, 0));
    if (options_.loopback && loopLength < frames) {
        // Input for a block may only depend on output of earlier blocks.
        throw std::invalid_argument("loopback latency must be at least one buffer");
    }
    loop_.assign(options_.loopback ? output_.size() : 0, std::vector<float>(loopLength, 0.0f));
    loopPosition_ = 0;
    return AudioDeviceStatus{config_.sampleRate,         config.bufferFrames,   options_.inputLatencyFrames,
                             options_.outputLatencyFrames, config.inputChannels, config.outputChannels};
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
        } else if (!loop_.empty()) {
            const std::size_t length = loop_.front().size();
            for (std::size_t c = 0; c < input_.size(); ++c) {
                const auto& ring = loop_[std::min(c, loop_.size() - 1)];
                for (int i = 0; i < config_.bufferFrames; ++i) {
                    input_[c][static_cast<std::size_t>(i)] = ring[(loopPosition_ + static_cast<std::size_t>(i)) % length];
                }
            }
        }
        inputFrame_ += config_.bufferFrames;
        {
            const rt::ScopedRealtimeThread realtime;
            callback_(in, out);
        }
        if (!loop_.empty()) {
            const std::size_t length = loop_.front().size();
            for (std::size_t c = 0; c < loop_.size(); ++c) {
                for (int i = 0; i < config_.bufferFrames; ++i) {
                    loop_[c][(loopPosition_ + static_cast<std::size_t>(i)) % length] =
                        output_[c][static_cast<std::size_t>(i)];
                }
            }
            loopPosition_ = (loopPosition_ + static_cast<std::size_t>(config_.bufferFrames)) % length;
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
