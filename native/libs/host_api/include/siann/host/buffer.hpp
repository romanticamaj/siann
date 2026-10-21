#pragma once

// SIANN-owned audio buffer views (architecture spec, "siann-host-api"). The
// core passes these to nodes and host adapters; adapters wrap them without
// copying. Views never own memory.

#include <cstddef>
#include <cstdint>
#include <span>

namespace siann::host {

struct AudioBufferView {
    float* const* channels = nullptr;  // channelCount pointers, each to frames samples
    int channelCount = 0;
    int frames = 0;

    float* channel(int index) const noexcept { return channels[index]; }

    void clear() const noexcept {
        for (int c = 0; c < channelCount; ++c) {
            for (int i = 0; i < frames; ++i) {
                channels[c][i] = 0.0f;
            }
        }
    }
};

// Timestamped events inside one block (MIDI, parameter changes). M1 carries no
// events yet; the shape is fixed now so node and host signatures stay stable.
struct BlockEvent {
    int sampleOffset = 0;
    std::uint32_t kind = 0;
    std::uint32_t data0 = 0;
    std::uint32_t data1 = 0;
    double value = 0.0;
};

using EventList = std::span<const BlockEvent>;

}  // namespace siann::host
