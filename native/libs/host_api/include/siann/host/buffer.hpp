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

enum class BlockEventKind : std::uint32_t {
    none = 0,
    parameterValue = 1,  // data0 is the parameter's index, value its normalized value
};

// Timestamped events inside one block (MIDI, parameter changes). The shape is fixed
// so node and host signatures stay stable; a kind adds what its fields mean.
struct BlockEvent {
    int sampleOffset = 0;
    BlockEventKind kind = BlockEventKind::none;
    std::uint32_t data0 = 0;
    std::uint32_t data1 = 0;
    double value = 0.0;
};

using EventList = std::span<const BlockEvent>;

}  // namespace siann::host
