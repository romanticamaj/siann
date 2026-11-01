#include "siann/realtime/stream_resampler.hpp"

#include <algorithm>
#include <stdexcept>

#include "CDSPResampler.h"

namespace siann::realtime {

namespace {
constexpr double kTransitionBand = 8.0;        // percent
constexpr double kStopbandAttenuation = 136.45;  // dB, as r8b::CDSPResampler16
}  // namespace

StreamResampler::StreamResampler(double inputRate, double outputRate, int channels, int maxInputFrames)
    : channels_(channels), maxInputFrames_(maxInputFrames) {
    if (inputRate <= 0.0 || outputRate <= 0.0 || channels <= 0 || maxInputFrames <= 0) {
        throw std::invalid_argument("invalid stream resampler configuration");
    }
    for (int c = 0; c < channels; ++c) {
        resamplers_.push_back(std::make_unique<r8b::CDSPResampler>(inputRate, outputRate, maxInputFrames,
                                                                   kTransitionBand, kStopbandAttenuation,
                                                                   r8b::fprLinearPhase));
    }
    maxOutputFrames_ = resamplers_.front()->getMaxOutLen(maxInputFrames);
    lookaheadFrames_ = resamplers_.front()->getInputRequiredForOutput(1);
    scratch_.assign(static_cast<std::size_t>(maxInputFrames), 0.0);
}

StreamResampler::~StreamResampler() = default;

int StreamResampler::process(const float* const* input, int frames, float* const* output) noexcept {
    frames = std::clamp(frames, 0, maxInputFrames_);
    int produced = 0;
    for (int c = 0; c < channels_; ++c) {
        for (int i = 0; i < frames; ++i) {
            scratch_[static_cast<std::size_t>(i)] = input[c][i];
        }
        double* result = nullptr;
        produced = resamplers_[static_cast<std::size_t>(c)]->process(scratch_.data(), frames, result);
        for (int i = 0; i < produced; ++i) {
            output[c][i] = static_cast<float>(result[i]);
        }
    }
    return produced;
}

void StreamResampler::reset() noexcept {
    for (auto& r : resamplers_) {
        r->clear();
    }
}

}  // namespace siann::realtime
