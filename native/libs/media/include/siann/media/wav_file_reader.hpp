#pragma once

// Streaming WAV reader for the butler thread (architecture spec, "Sample rate
// and media": media is never fully decoded into RAM). It seeks and reads
// frames on demand into planar buffers. Non-realtime; not thread-safe.

#include <cstdint>
#include <filesystem>
#include <memory>

#include "siann/host/interfaces.hpp"

namespace siann::media {

class WavFileReader final : public host::MediaReader {
public:
    // Throws MediaError (unsupported_media, decode_failed) or io::IoError-like
    // MediaError("unsupported_media") when the file cannot be opened.
    explicit WavFileReader(const std::filesystem::path& path, int chunkFrames = 4'096);
    ~WavFileReader() override;
    WavFileReader(const WavFileReader&) = delete;
    WavFileReader& operator=(const WavFileReader&) = delete;

    host::MediaInfo info() const override;

    // Reads frames from `position` into destination (planar). Channels beyond
    // the file's are zeroed; frames past the end are zeroed. Returns the
    // number of frames read from the file.
    std::int64_t read(std::int64_t position, const host::AudioBufferView& destination) override;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::media
