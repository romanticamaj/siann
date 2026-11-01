#pragma once

// A MediaReader over audio decoded into memory. It stands in for streaming
// readers of formats that have none yet (FLAC in M2): the butler reads it like
// any other reader. Non-realtime; reads are const, so one reader may be shared
// by several clips on the butler thread.

#include <cstdint>
#include <vector>

#include "siann/host/interfaces.hpp"
#include "siann/media/audio.hpp"

namespace siann::media {

class MemoryMediaReader final : public host::MediaReader {
public:
    // Copies the interleaved buffer into planar storage.
    explicit MemoryMediaReader(const AudioBuffer& buffer);

    host::MediaInfo info() const override;

    // Reads frames from `position` into destination (planar). Channels beyond
    // the media's and frames outside it are zeroed. Returns the number of
    // frames read from the media.
    std::int64_t read(std::int64_t position, const host::AudioBufferView& destination) override;

private:
    host::MediaInfo info_;
    std::vector<std::vector<float>> data_;  // channels x frames
};

}  // namespace siann::media
