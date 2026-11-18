#include "siann/dsp/loudness.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>
#include <stdexcept>

namespace siann::dsp {

namespace {

// The analogue prototype of the K-weighting (BS.1770-4 Annex 1), from which the
// 48 kHz table follows by the bilinear transform with prewarping.
constexpr double kShelfFrequency = 1'681.974450955533;
constexpr double kShelfGainDb = 3.999843853973347;
constexpr double kShelfQ = 0.7071752369554196;
constexpr double kShelfBandwidthExponent = 0.4996667741545416;
constexpr double kHighPassFrequency = 38.13547087602444;
constexpr double kHighPassQ = 0.5003270373238773;

// Below this the filters would not hold the shelf; real sessions run far above.
constexpr double kMinSampleRate = 8'000.0;
// A filter state smaller than this is set to zero at a sub-block boundary: far
// below any float signal's contribution, and it ends the tail after a signal.
constexpr double kStateFloor = 1e-15;

constexpr double kMinusInfinity = -std::numeric_limits<double>::infinity();

double loudnessOf(double energy) noexcept {
    return energy > 0.0 ? -0.691 + 10.0 * std::log10(energy) : kMinusInfinity;
}

double step(const Biquad& f, double& z1, double& z2, double x) noexcept {
    // Transposed direct form II.
    const double y = f.b0 * x + z1;
    z1 = f.b1 * x - f.a1 * y + z2;
    z2 = f.b2 * x - f.a2 * y;
    return y;
}

void snap(double& value) noexcept {
    if (std::abs(value) < kStateFloor) {
        value = 0.0;
    }
}

constexpr int binCount() {
    // 8,000 bins of 0.01 LU from -70 to +10 LUFS.
    return 8'000;
}
static_assert(static_cast<double>(binCount()) * LoudnessMeter::kBinWidth ==
              LoudnessMeter::kHistogramTop - LoudnessMeter::kAbsoluteGate);

}  // namespace

KWeighting kWeighting(double sampleRate) {
    KWeighting out;
    {
        const double k = std::tan(std::numbers::pi * kShelfFrequency / sampleRate);
        const double vh = std::pow(10.0, kShelfGainDb / 20.0);
        const double vb = std::pow(vh, kShelfBandwidthExponent);
        const double a0 = 1.0 + k / kShelfQ + k * k;
        out.shelf.b0 = (vh + vb * k / kShelfQ + k * k) / a0;
        out.shelf.b1 = 2.0 * (k * k - vh) / a0;
        out.shelf.b2 = (vh - vb * k / kShelfQ + k * k) / a0;
        out.shelf.a1 = 2.0 * (k * k - 1.0) / a0;
        out.shelf.a2 = (1.0 - k / kShelfQ + k * k) / a0;
    }
    {
        const double k = std::tan(std::numbers::pi * kHighPassFrequency / sampleRate);
        const double a0 = 1.0 + k / kHighPassQ + k * k;
        out.highPass.b0 = 1.0;
        out.highPass.b1 = -2.0;
        out.highPass.b2 = 1.0;
        out.highPass.a1 = 2.0 * (k * k - 1.0) / a0;
        out.highPass.a2 = (1.0 - k / kHighPassQ + k * k) / a0;
    }
    return out;
}

LoudnessMeter::LoudnessMeter(double sampleRate, int channels)
    : sampleRate_(sampleRate),
      channels_(channels),
      subBlockFrames_(static_cast<int>(std::lround(sampleRate / 10.0))),
      binCounts_(static_cast<std::size_t>(binCount()), 0),
      binEnergy_(static_cast<std::size_t>(binCount()), 0.0),
      momentary_(kMinusInfinity),
      shortTerm_(kMinusInfinity),
      integrated_(kMinusInfinity) {
    if (!(sampleRate >= kMinSampleRate) || !std::isfinite(sampleRate)) {
        throw std::invalid_argument("the loudness meter needs a sample rate of at least 8000 Hz");
    }
    if (channels < 1 || channels > kMaxChannels) {
        throw std::invalid_argument("the loudness meter takes 1 to 8 channels");
    }
    k_ = kWeighting(sampleRate);
}

void LoudnessMeter::process(const float* const* channels, int channelCount, int frames) noexcept {
    const int count = std::clamp(channelCount, 0, channels_);
    // The meter's channels with no samples are silent: their filters rest.
    for (int c = count; c < channels_; ++c) {
        shelfState_[static_cast<std::size_t>(c)] = State{};
        highPassState_[static_cast<std::size_t>(c)] = State{};
    }
    int done = 0;
    while (done < frames) {
        const int n = std::min(frames - done, subBlockFrames_ - subBlockFill_);
        for (int c = 0; c < count; ++c) {
            const float* x = channels[c] + done;
            State& shelf = shelfState_[static_cast<std::size_t>(c)];
            State& highPass = highPassState_[static_cast<std::size_t>(c)];
            double sum = channelSum_[static_cast<std::size_t>(c)];  // in sample order, whatever the calls
            for (int i = 0; i < n; ++i) {
                const double weighted =
                    step(k_.highPass, highPass.z1, highPass.z2, step(k_.shelf, shelf.z1, shelf.z2, x[i]));
                sum += weighted * weighted;
            }
            channelSum_[static_cast<std::size_t>(c)] = sum;
        }
        subBlockFill_ += n;
        done += n;
        if (subBlockFill_ == subBlockFrames_) {
            endSubBlock();
        }
    }
}

void LoudnessMeter::processSilence(int frames) noexcept {
    shelfState_.fill(State{});
    highPassState_.fill(State{});
    int done = 0;
    while (done < frames) {
        const int n = std::min(frames - done, subBlockFrames_ - subBlockFill_);
        subBlockFill_ += n;
        done += n;
        if (subBlockFill_ == subBlockFrames_) {
            endSubBlock();
        }
    }
}

void LoudnessMeter::reset() noexcept {
    std::fill(binCounts_.begin(), binCounts_.end(), std::uint64_t{0});
    std::fill(binEnergy_.begin(), binEnergy_.end(), 0.0);
    gatedCount_ = 0;
    gatedEnergy_ = 0.0;
    integrated_ = kMinusInfinity;
    // The sub-block in progress began before the reset: it is not counted.
    sinceReset_ = subBlockFill_ > 0 ? -1 : 0;
}

double LoudnessMeter::windowEnergy(int subBlocks) const noexcept {
    double sum = 0.0;
    for (int j = 0; j < subBlocks; ++j) {
        sum += ring_[static_cast<std::size_t>((ringHead_ - 1 - j + kShortTermSubBlocks) % kShortTermSubBlocks)];
    }
    return sum / (static_cast<double>(subBlocks) * static_cast<double>(subBlockFrames_));
}

void LoudnessMeter::endSubBlock() noexcept {
    double energy = 0.0;
    for (int c = 0; c < channels_; ++c) {
        energy += channelSum_[static_cast<std::size_t>(c)];
        channelSum_[static_cast<std::size_t>(c)] = 0.0;
        State& shelf = shelfState_[static_cast<std::size_t>(c)];
        State& highPass = highPassState_[static_cast<std::size_t>(c)];
        snap(shelf.z1);
        snap(shelf.z2);
        snap(highPass.z1);
        snap(highPass.z2);
    }
    ring_[static_cast<std::size_t>(ringHead_)] = energy;
    ringHead_ = (ringHead_ + 1) % kShortTermSubBlocks;
    subBlockFill_ = 0;
    if (sinceReset_ < kMomentarySubBlocks) {
        ++sinceReset_;
    }

    const double block = windowEnergy(kMomentarySubBlocks);
    momentary_ = loudnessOf(block);
    shortTerm_ = loudnessOf(windowEnergy(kShortTermSubBlocks));

    // A gating block: the last 400 ms, every 100 ms, once all four sub-blocks
    // follow the last reset.
    if (sinceReset_ < kMomentarySubBlocks || !(momentary_ > kAbsoluteGate)) {
        return;
    }
    const auto bin = static_cast<std::size_t>(
        std::clamp(static_cast<int>(std::floor((momentary_ - kAbsoluteGate) / kBinWidth)), 0, binCount() - 1));
    ++binCounts_[bin];
    binEnergy_[bin] += block;
    ++gatedCount_;
    gatedEnergy_ += block;
    updateIntegrated();
}

void LoudnessMeter::updateIntegrated() noexcept {
    if (gatedCount_ == 0) {
        integrated_ = kMinusInfinity;
        return;
    }
    // The relative gate below the absolutely gated mean; a bin counts when its
    // lower edge is at or above it.
    const double gate = loudnessOf(gatedEnergy_ / static_cast<double>(gatedCount_)) + kRelativeGate;
    const int first = std::clamp(static_cast<int>(std::ceil((gate - kAbsoluteGate) / kBinWidth)), 0, binCount());
    std::uint64_t count = 0;
    double energy = 0.0;
    for (int b = first; b < binCount(); ++b) {
        count += binCounts_[static_cast<std::size_t>(b)];
        energy += binEnergy_[static_cast<std::size_t>(b)];
    }
    integrated_ = count > 0 ? loudnessOf(energy / static_cast<double>(count)) : kMinusInfinity;
}

}  // namespace siann::dsp
