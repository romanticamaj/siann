#include "siann/media/memory_reader.hpp"

#include <stdexcept>

namespace siann::media {

MemoryMediaReader::MemoryMediaReader(const AudioBuffer& buffer) {
    (void)buffer;
}

host::MediaInfo MemoryMediaReader::info() const {
    return info_;
}

std::int64_t MemoryMediaReader::read(std::int64_t position, const host::AudioBufferView& destination) {
    (void)position;
    (void)destination;
    throw std::logic_error("not implemented");
}

}  // namespace siann::media
