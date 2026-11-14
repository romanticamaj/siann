#pragma once

// Signal measurements shared by the realtime tests: a least-squares sine fit
// at a known frequency and the peak of |x|. Test-only, non-realtime.

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <numbers>
#include <span>

namespace siann::test {

struct SineFit {
    double amplitude = 0.0;   // linear
    double residualDb = 0.0;  // residual RMS relative to the fitted tone's RMS
};

// Fits a * sin + b * cos at `frequency` over `samples` (best over a whole
// number of cycles) and measures what is left.
inline SineFit fitSine(std::span<const float> samples, double frequency, double sampleRate) {
    const double w = 2.0 * std::numbers::pi * frequency / sampleRate;
    double ss = 0.0, cc = 0.0, sc = 0.0, xs = 0.0, xc = 0.0;
    for (std::size_t i = 0; i < samples.size(); ++i) {
        const double s = std::sin(w * static_cast<double>(i));
        const double c = std::cos(w * static_cast<double>(i));
        const double x = samples[i];
        ss += s * s;
        cc += c * c;
        sc += s * c;
        xs += x * s;
        xc += x * c;
    }
    const double det = ss * cc - sc * sc;
    // Too few samples to fit (none, or one): no tone. Also keeps MSVC's Release
    // optimizer from warning (C4723) on a call it inlines with an empty span.
    if (det == 0.0) return SineFit{};
    const double a = (xs * cc - xc * sc) / det;
    const double b = (xc * ss - xs * sc) / det;
    double residual = 0.0;
    for (std::size_t i = 0; i < samples.size(); ++i) {
        const double fit = a * std::sin(w * static_cast<double>(i)) + b * std::cos(w * static_cast<double>(i));
        const double e = samples[i] - fit;
        residual += e * e;
    }
    SineFit result;
    result.amplitude = std::sqrt(a * a + b * b);
    const double residualRms = std::sqrt(residual / static_cast<double>(samples.size()));
    const double toneRms = result.amplitude / std::numbers::sqrt2;
    result.residualDb = 20.0 * std::log10(std::max(residualRms, 1e-30) / toneRms);
    return result;
}

inline double toDb(double ratio) {
    return 20.0 * std::log10(ratio);
}

// Index of the sample with the largest magnitude (the first one on ties).
inline std::int64_t peakIndex(std::span<const float> samples) {
    std::int64_t best = -1;
    float peak = 0.0f;
    for (std::size_t i = 0; i < samples.size(); ++i) {
        if (std::fabs(samples[i]) > peak) {
            peak = std::fabs(samples[i]);
            best = static_cast<std::int64_t>(i);
        }
    }
    return best;
}

}  // namespace siann::test
