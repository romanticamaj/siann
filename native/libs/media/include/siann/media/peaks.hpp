#pragma once

// Peak pyramids (architecture spec, Protocol v0 item 23;
// docs/schemas/protocol-peaks-v0.md). One pyramid per media file, cached at
// <bundle>/peaks/<sha256 hex>.peaks and regenerable. Level k has bins of
// 256 * 4^k frames holding {min, max} int16 per channel; the last level is the
// first with at most one bin. Non-realtime code: the protocol's jobs worker
// computes it, never the command or audio thread.

#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include "siann/host/interfaces.hpp"

namespace siann::media {

inline constexpr std::uint32_t kPeakBaseBinFrames = 256;
// The coarsest level the format allows: 256 * 4^11 frames per bin.
inline constexpr int kPeakMaxLevel = 11;
inline constexpr int kPeakMaxChannels = 255;

struct PeakLevel {
    std::uint32_t binFrames = 0;
    std::uint32_t binCount = 0;
    // binCount * channels pairs {min, max}, channel-interleaved.
    std::vector<std::int16_t> values;

    bool operator==(const PeakLevel&) const = default;
};

struct PeakPyramid {
    int channels = 0;
    std::uint64_t frames = 0;
    std::uint32_t sampleRate = 0;
    std::vector<PeakLevel> levels;

    bool operator==(const PeakPyramid&) const = default;
};

// floor(x * 32767 + 0.5) in double, clamped to [-32768, 32767]; NaN is 0.
std::int16_t peakSample(float x) noexcept;

// Reads the whole media through the reader (in chunks, never all at once) and
// builds every level. Throws MediaError("too_large") above 256 * 4^11 frames or
// 255 channels.
PeakPyramid computePeaks(host::MediaReader& reader);

// The file bytes of a pyramid.
std::string encodePeaks(const PeakPyramid& pyramid);

// Parses a file. Throws MediaError("decode_failed") for a bad magic, version
// or reserved byte, a level layout other than the one frames implies, or a
// size that does not match.
PeakPyramid decodePeaks(std::string_view bytes);

// <bundle>/peaks/<hashHex>.peaks. Throws std::invalid_argument unless hashHex
// is 64 lowercase hex digits.
std::filesystem::path peaksPath(const std::filesystem::path& bundle, std::string_view hashHex);

// Writes the pyramid there atomically (io::writeFileAtomic), creating peaks/
// durably; returns the path. Throws io::IoError.
std::filesystem::path writePeaks(const std::filesystem::path& bundle, std::string_view hashHex,
                                 const PeakPyramid& pyramid);

}  // namespace siann::media
