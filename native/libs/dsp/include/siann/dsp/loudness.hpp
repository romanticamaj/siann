#pragma once

// A loudness meter per ITU-R BS.1770-4, gated as in EBU R128 (architecture
// spec, "siann-dsp"; m5b-engine-load-loudness). Original code, standard library
// only.
//
// - K-weighting: a high-shelf pre-filter and the RLB high-pass, two biquads
//   whose coefficients are derived per rate from the analogue prototype; at
//   48 kHz they equal the table of BS.1770-4 Annex 1.
// - The signal is summed per 100 ms sub-block (round(rate / 10) frames) as the
//   sum over channels (weight 1 each) of the K-weighted squares. Momentary is the
//   mean over the last 4 sub-blocks (400 ms), short-term over the last 30 (3 s).
// - Integrated: every 100 ms a 400 ms gating block (75 % overlap) whose
//   loudness is above the absolute gate (-70 LUFS) enters a histogram of
//   0.01 LU bins from -70 to +10 LUFS holding per bin a block count and the
//   exact sum of the blocks' energies; the relative gate (-10 LU below the
//   absolutely gated mean) is applied over the bins, so memory is bounded and
//   allocated once by the constructor.
// - Loudness is -0.691 + 10 log10(energy); zero energy is minus infinity. A
//   filter state that has decayed below 1e-15 is set to zero at a sub-block
//   boundary, so digital silence after a signal reads minus infinity once the
//   filter tail has passed.
//
// process(), processSilence(), reset() and the readings never allocate, lock or
// throw; one thread calls them all. The readings change at sub-block boundaries
// only, so the result does not depend on how the signal is split into calls.

#include <array>
#include <cstdint>
#include <vector>

namespace siann::dsp {

struct Biquad {
    double b0 = 1.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a1 = 0.0;
    double a2 = 0.0;
};

struct KWeighting {
    Biquad shelf;     // stage 1, the pre-filter
    Biquad highPass;  // stage 2, the RLB weighting
};

// The K-weighting at `sampleRate` (> 0).
KWeighting kWeighting(double sampleRate);

class LoudnessMeter {
public:
    static constexpr int kMaxChannels = 8;
    static constexpr int kMomentarySubBlocks = 4;
    static constexpr int kShortTermSubBlocks = 30;
    static constexpr double kAbsoluteGate = -70.0;  // LUFS
    static constexpr double kRelativeGate = -10.0;  // LU
    static constexpr double kHistogramTop = 10.0;   // LUFS
    static constexpr double kBinWidth = 0.01;       // LU

    // Allocates everything it will use. Throws std::invalid_argument for a rate
    // that gives no sub-block or a channel count outside [1, kMaxChannels].
    LoudnessMeter(double sampleRate, int channels);

    double sampleRate() const noexcept { return sampleRate_; }
    int channels() const noexcept { return channels_; }
    int subBlockFrames() const noexcept { return subBlockFrames_; }

    // `channelCount` (at most channels()) pointers to `frames` samples each; the
    // meter's other channels count as silent.
    void process(const float* const* channels, int channelCount, int frames) noexcept;
    // `frames` of digital silence without reading samples: zero energy, and the
    // filters start from rest afterwards.
    void processSilence(int frames) noexcept;
    // Restarts the integrated value; momentary and short-term go on. The
    // sub-block in progress is not part of the next gating block.
    void reset() noexcept;

    // LUFS, minus infinity for silence.
    double momentary() const noexcept { return momentary_; }
    double shortTerm() const noexcept { return shortTerm_; }
    double integrated() const noexcept { return integrated_; }

private:
    struct State {
        double z1 = 0.0;
        double z2 = 0.0;
    };

    void endSubBlock() noexcept;
    void updateIntegrated() noexcept;
    double windowEnergy(int subBlocks) const noexcept;

    double sampleRate_;
    int channels_;
    int subBlockFrames_;
    KWeighting k_;
    std::array<State, kMaxChannels> shelfState_{};
    std::array<State, kMaxChannels> highPassState_{};

    // The sub-block in progress: per channel, the K-weighted squares summed in
    // sample order, so a different split into calls gives the same sums.
    std::array<double, kMaxChannels> channelSum_{};
    int subBlockFill_ = 0;
    std::array<double, kShortTermSubBlocks> ring_{};  // completed sub-block sums
    int ringHead_ = 0;                                 // where the next one goes
    int sinceReset_ = 0;  // completed sub-blocks that count for gating, at most 4

    std::vector<std::uint64_t> binCounts_;
    std::vector<double> binEnergy_;  // sum of the blocks' mean-square energies
    std::uint64_t gatedCount_ = 0;
    double gatedEnergy_ = 0.0;

    double momentary_;
    double shortTerm_;
    double integrated_;
};

}  // namespace siann::dsp
