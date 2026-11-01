#pragma once

// Streaming sample-rate conversion for the device boundary (architecture
// spec, "Device-side SRC (M2)").
//
// One r8brain-free-src CDSPResampler per channel in streaming mode: linear
// phase, about 136 dB stopband attenuation (the CDSPResampler16 class; the
// 24-bit filters are longer than the device path needs) and an 8 % transition
// band, which keeps the passband flat to about 20 kHz at 44.1 kHz with a
// lookahead near 10 ms (2 % would cost about 40 ms each way). The constructor allocates and touches r8brain's filter cache, so it
// runs on a control thread. process() and reset() then run through buffers
// preallocated here and inside r8brain and are realtime-safe (proven by the
// allocation-guard tests).
//
// r8brain consumes its own filter latency: process() returns no output until
// lookaheadFrames() input frames have gone in, after which output frame n
// lines up with input time n * inRate / outRate. The lookahead is therefore
// the latency this stage adds to a live stream.
//
// Fallback: libsamplerate (BSD-2) offers the same streaming shape
// (src_process with a preallocated state). It is not built; switch only if
// r8brain fails the realtime checks on a platform.

#include <memory>
#include <vector>

namespace r8b {
class CDSPResampler;
}

namespace siann::realtime {

class StreamResampler {
public:
    StreamResampler(double inputRate, double outputRate, int channels, int maxInputFrames);
    ~StreamResampler();
    StreamResampler(const StreamResampler&) = delete;
    StreamResampler& operator=(const StreamResampler&) = delete;

    int channels() const noexcept { return channels_; }
    int maxInputFrames() const noexcept { return maxInputFrames_; }
    // The most frames one process() call can produce.
    int maxOutputFrames() const noexcept { return maxOutputFrames_; }
    // Input frames needed before the first output frame appears.
    int lookaheadFrames() const noexcept { return lookaheadFrames_; }

    // Audio thread. Converts `frames` (at most maxInputFrames()) planar input
    // frames per channel and writes the frames produced, the same number on
    // every channel, to `output` (each with room for maxOutputFrames()).
    int process(const float* const* input, int frames, float* const* output) noexcept;

    // Back to the state after construction.
    void reset() noexcept;

private:
    int channels_;
    int maxInputFrames_;
    int maxOutputFrames_ = 0;
    int lookaheadFrames_ = 0;
    std::vector<std::unique_ptr<r8b::CDSPResampler>> resamplers_;
    std::vector<double> scratch_;
};

}  // namespace siann::realtime
