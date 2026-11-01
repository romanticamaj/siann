#include "siann/media/memory_reader.hpp"

#include <algorithm>

namespace siann::media {

MemoryMediaReader::MemoryMediaReader(const AudioBuffer& buffer)
    : info_{buffer.info.channels, buffer.info.sampleRate, buffer.info.frames} {
    const auto channels = static_cast<std::size_t>(std::max(0, buffer.info.channels));
    const auto frames = static_cast<std::size_t>(std::max<std::int64_t>(0, buffer.info.frames));
    if (buffer.samples.size() < channels * frames) {
        throw MediaError("invalid_buffer", "the buffer holds fewer samples than its info declares");
    }
    data_.assign(channels, std::vector<float>(frames));
    for (std::size_t i = 0; i < frames; ++i) {
        for (std::size_t c = 0; c < channels; ++c) {
            data_[c][i] = buffer.samples[i * channels + c];
        }
    }
}

host::MediaInfo MemoryMediaReader::info() const {
    return info_;
}

std::int64_t MemoryMediaReader::read(std::int64_t position, const host::AudioBufferView& destination) {
    const std::int64_t frames = destination.frames;
    // The part of [position, position + frames) inside the media.
    const std::int64_t from = std::clamp<std::int64_t>(position, 0, info_.frames);
    const std::int64_t to = std::clamp<std::int64_t>(position + frames, 0, info_.frames);
    const std::int64_t count = std::max<std::int64_t>(0, to - from);
    const std::int64_t lead = count > 0 ? from - position : frames;  // zeroed frames before the media
    for (int c = 0; c < destination.channelCount; ++c) {
        float* out = destination.channel(c);
        if (c >= info_.channels || count == 0) {
            std::fill(out, out + frames, 0.0f);
            continue;
        }
        const auto& source = data_[static_cast<std::size_t>(c)];
        std::fill(out, out + lead, 0.0f);
        std::copy(source.begin() + static_cast<std::ptrdiff_t>(from), source.begin() + static_cast<std::ptrdiff_t>(to),
                  out + lead);
        std::fill(out + lead + count, out + frames, 0.0f);
    }
    return count;
}

}  // namespace siann::media
