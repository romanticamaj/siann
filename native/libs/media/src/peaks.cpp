#include "siann/media/peaks.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <utility>

#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"

namespace siann::media {

namespace {

constexpr std::string_view kMagic = "SPKS";
constexpr std::uint8_t kVersion = 1;
constexpr std::size_t kHeaderBytes = 20;
constexpr std::size_t kLevelHeaderBytes = 8;
// Frames read per chunk: a whole number of base bins.
constexpr int kChunkFrames = 16 * static_cast<int>(kPeakBaseBinFrames);

constexpr std::uint64_t binFramesOf(int level) noexcept {
    return static_cast<std::uint64_t>(kPeakBaseBinFrames) << (2 * level);
}

constexpr std::uint64_t kMaxFrames = binFramesOf(kPeakMaxLevel);

std::uint64_t ceilDiv(std::uint64_t a, std::uint64_t b) noexcept {
    return a / b + (a % b != 0 ? 1 : 0);
}

// The layout frames implies: binCount per level, the last the first with at most one bin.
std::vector<std::uint32_t> binCounts(std::uint64_t frames) {
    std::vector<std::uint32_t> counts;
    for (int level = 0; level <= kPeakMaxLevel; ++level) {
        const std::uint64_t count = ceilDiv(frames, binFramesOf(level));
        counts.push_back(static_cast<std::uint32_t>(count));
        if (count <= 1) {
            return counts;
        }
    }
    throw MediaError("too_large", "media of " + std::to_string(frames) + " frames is longer than a peak pyramid holds");
}

void put(std::string& out, std::uint64_t value, int bytes) {
    for (int i = 0; i < bytes; ++i) {
        out.push_back(static_cast<char>((value >> (8 * i)) & 0xffu));
    }
}

std::uint64_t get(std::string_view bytes, std::size_t at, int count) {
    std::uint64_t value = 0;
    for (int i = 0; i < count; ++i) {
        value |= static_cast<std::uint64_t>(static_cast<unsigned char>(bytes[at + static_cast<std::size_t>(i)]))
                 << (8 * i);
    }
    return value;
}

[[noreturn]] void refuse(const std::string& why) {
    throw MediaError("decode_failed", "not a peak pyramid: " + why);
}

bool isLowerHex64(std::string_view text) noexcept {
    return text.size() == 64 && std::all_of(text.begin(), text.end(), [](char c) {
               return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
           });
}

}  // namespace

std::int16_t peakSample(float x) noexcept {
    if (std::isnan(x)) {
        return 0;
    }
    const double scaled = std::floor(static_cast<double>(x) * 32767.0 + 0.5);
    return static_cast<std::int16_t>(std::clamp(scaled, -32768.0, 32767.0));
}

PeakPyramid computePeaks(host::MediaReader& reader) {
    const host::MediaInfo info = reader.info();
    if (info.channels < 1 || info.channels > kPeakMaxChannels) {
        throw MediaError("too_large", "a peak pyramid holds 1 to 255 channels, not " + std::to_string(info.channels));
    }
    if (info.frames < 0 || static_cast<std::uint64_t>(info.frames) > kMaxFrames) {
        throw MediaError("too_large", "media of " + std::to_string(info.frames) +
                                          " frames is longer than a peak pyramid holds");
    }
    if (info.sampleRate < 0 || info.sampleRate > std::numeric_limits<std::uint32_t>::max()) {
        throw MediaError("too_large", "a sample rate of " + std::to_string(info.sampleRate) + " does not fit");
    }
    PeakPyramid pyramid;
    pyramid.channels = info.channels;
    pyramid.frames = static_cast<std::uint64_t>(info.frames);
    pyramid.sampleRate = static_cast<std::uint32_t>(info.sampleRate);
    const std::vector<std::uint32_t> counts = binCounts(pyramid.frames);
    const auto channels = static_cast<std::size_t>(info.channels);

    // Level 0 from the samples, one chunk at a time. The frame count is the
    // media header's word, so level 0 grows only with the chunks the reader
    // actually yields: a header claiming a billion frames costs a chunk, not
    // gigabytes, before the first short read refuses it. A pyramid is all of
    // the media or nothing: one shorter than its header claims would disagree
    // with the clip it draws, so a short (or long) read is decode_failed.
    PeakLevel base;
    base.binFrames = kPeakBaseBinFrames;
    base.binCount = counts.front();
    std::vector<std::vector<float>> planar(channels, std::vector<float>(static_cast<std::size_t>(kChunkFrames)));
    std::vector<float*> pointers;
    for (auto& channel : planar) {
        pointers.push_back(channel.data());
    }
    for (std::int64_t start = 0; start < info.frames; start += kChunkFrames) {
        const int frames = static_cast<int>(std::min<std::int64_t>(kChunkFrames, info.frames - start));
        const std::int64_t got = reader.read(start, host::AudioBufferView{pointers.data(), info.channels, frames});
        if (got != frames) {
            throw MediaError("decode_failed", "the media yielded " + std::to_string(start + std::max<std::int64_t>(got, 0)) +
                                                  " of the " + std::to_string(info.frames) +
                                                  " frames its header claims");
        }
        const auto chunkBins = static_cast<std::size_t>(ceilDiv(static_cast<std::uint64_t>(frames), kPeakBaseBinFrames));
        base.values.resize(base.values.size() + chunkBins * channels * 2);
        for (int offset = 0; offset < frames; offset += static_cast<int>(kPeakBaseBinFrames)) {
            const int end = std::min(frames, offset + static_cast<int>(kPeakBaseBinFrames));
            const auto bin = static_cast<std::size_t>((start + offset) / kPeakBaseBinFrames);
            for (std::size_t c = 0; c < channels; ++c) {
                std::int16_t low = std::numeric_limits<std::int16_t>::max();
                std::int16_t high = std::numeric_limits<std::int16_t>::min();
                for (int i = offset; i < end; ++i) {
                    const std::int16_t q = peakSample(planar[c][static_cast<std::size_t>(i)]);
                    low = std::min(low, q);
                    high = std::max(high, q);
                }
                base.values[(bin * channels + c) * 2] = low;
                base.values[(bin * channels + c) * 2 + 1] = high;
            }
        }
    }
    pyramid.levels.push_back(std::move(base));

    // Each further level merges four bins of the one below.
    for (std::size_t level = 1; level < counts.size(); ++level) {
        const PeakLevel& below = pyramid.levels.back();
        PeakLevel next;
        next.binFrames = static_cast<std::uint32_t>(binFramesOf(static_cast<int>(level)));
        next.binCount = counts[level];
        next.values.resize(static_cast<std::size_t>(next.binCount) * channels * 2);
        for (std::size_t bin = 0; bin < next.binCount; ++bin) {
            const std::size_t first = bin * 4;
            const std::size_t last = std::min<std::size_t>(first + 4, below.binCount);
            for (std::size_t c = 0; c < channels; ++c) {
                std::int16_t low = std::numeric_limits<std::int16_t>::max();
                std::int16_t high = std::numeric_limits<std::int16_t>::min();
                for (std::size_t i = first; i < last; ++i) {
                    low = std::min(low, below.values[(i * channels + c) * 2]);
                    high = std::max(high, below.values[(i * channels + c) * 2 + 1]);
                }
                next.values[(bin * channels + c) * 2] = low;
                next.values[(bin * channels + c) * 2 + 1] = high;
            }
        }
        pyramid.levels.push_back(std::move(next));
    }
    return pyramid;
}

std::string encodePeaks(const PeakPyramid& pyramid) {
    std::size_t size = kHeaderBytes;
    for (const PeakLevel& level : pyramid.levels) {
        size += kLevelHeaderBytes + level.values.size() * 2;
    }
    std::string out;
    out.reserve(size);
    out.append(kMagic);
    put(out, kVersion, 1);
    put(out, static_cast<std::uint64_t>(pyramid.channels), 1);
    put(out, pyramid.levels.size(), 1);
    put(out, 0, 1);
    put(out, pyramid.frames, 8);
    put(out, pyramid.sampleRate, 4);
    for (const PeakLevel& level : pyramid.levels) {
        put(out, level.binFrames, 4);
        put(out, level.binCount, 4);
        for (const std::int16_t value : level.values) {
            put(out, static_cast<std::uint16_t>(value), 2);
        }
    }
    return out;
}

PeakPyramid decodePeaks(std::string_view bytes) {
    if (bytes.size() < kHeaderBytes) {
        refuse("shorter than its header");
    }
    if (bytes.substr(0, 4) != kMagic) {
        refuse("bad magic");
    }
    if (get(bytes, 4, 1) != kVersion) {
        refuse("version " + std::to_string(get(bytes, 4, 1)));
    }
    if (get(bytes, 7, 1) != 0) {
        refuse("reserved byte set");
    }
    PeakPyramid pyramid;
    pyramid.channels = static_cast<int>(get(bytes, 5, 1));
    const auto levels = static_cast<std::size_t>(get(bytes, 6, 1));
    pyramid.frames = get(bytes, 8, 8);
    pyramid.sampleRate = static_cast<std::uint32_t>(get(bytes, 16, 4));
    if (pyramid.channels < 1) {
        refuse("no channels");
    }
    if (pyramid.frames > kMaxFrames) {
        refuse("more frames than the format holds");
    }
    const std::vector<std::uint32_t> counts = binCounts(pyramid.frames);
    if (levels != counts.size()) {
        refuse(std::to_string(levels) + " levels where the frames imply " + std::to_string(counts.size()));
    }
    const auto channels = static_cast<std::size_t>(pyramid.channels);
    std::size_t at = kHeaderBytes;
    for (std::size_t level = 0; level < levels; ++level) {
        if (bytes.size() - at < kLevelHeaderBytes) {
            refuse("cut off in level " + std::to_string(level));
        }
        PeakLevel out;
        out.binFrames = static_cast<std::uint32_t>(get(bytes, at, 4));
        out.binCount = static_cast<std::uint32_t>(get(bytes, at + 4, 4));
        at += kLevelHeaderBytes;
        if (out.binFrames != binFramesOf(static_cast<int>(level)) || out.binCount != counts[level]) {
            refuse("level " + std::to_string(level) + " is not laid out as its frames imply");
        }
        const std::size_t values = static_cast<std::size_t>(out.binCount) * channels * 2;
        if ((bytes.size() - at) / 2 < values) {
            refuse("cut off in level " + std::to_string(level));
        }
        out.values.resize(values);
        for (std::size_t i = 0; i < values; ++i) {
            out.values[i] = static_cast<std::int16_t>(static_cast<std::uint16_t>(get(bytes, at + i * 2, 2)));
        }
        at += values * 2;
        pyramid.levels.push_back(std::move(out));
    }
    if (at != bytes.size()) {
        refuse("bytes after the last level");
    }
    return pyramid;
}

std::filesystem::path peaksPath(const std::filesystem::path& bundle, std::string_view hashHex) {
    if (!isLowerHex64(hashHex)) {
        throw std::invalid_argument("a peaks file is named by 64 lowercase hex digits");
    }
    return bundle / "peaks" / (std::string(hashHex) + ".peaks");
}

std::filesystem::path writePeaks(const std::filesystem::path& bundle, std::string_view hashHex,
                                 const PeakPyramid& pyramid) {
    const std::filesystem::path file = peaksPath(bundle, hashHex);
    io::createDirectoriesDurable(file.parent_path());
    io::writeFileAtomic(file, encodePeaks(pyramid));
    return file;
}

}  // namespace siann::media
