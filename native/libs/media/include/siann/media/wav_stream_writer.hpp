#pragma once

// Write-through recording to 32-bit float WAV (architecture spec, "Recording").
// The header's sizes are rewritten and the file flushed to stable storage on
// every checkpoint(), so a crash leaves a readable file up to the last
// checkpoint. repairWav() fixes a file whose writer never finished.
// Non-realtime; M1/M2 limit: 4 GiB (RF64 follows).

#include <cstdint>
#include <filesystem>
#include <memory>

#include "siann/host/buffer.hpp"

namespace siann::media {

class WavStreamWriter {
public:
    // Creates (or truncates) the file and writes a header for 0 frames.
    WavStreamWriter(const std::filesystem::path& path, int channels, std::int64_t sampleRate);
    ~WavStreamWriter();
    WavStreamWriter(const WavStreamWriter&) = delete;
    WavStreamWriter& operator=(const WavStreamWriter&) = delete;

    // Appends planar frames (source.channelCount must equal channels).
    void append(const host::AudioBufferView& source, int frames);

    // Rewrites the header for the frames written so far and flushes the file
    // and its data to stable storage.
    void checkpoint();

    // checkpoint() and close. Further calls are invalid.
    void close();

    std::int64_t frames() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

struct RepairResult {
    std::int64_t frames = 0;        // complete frames kept
    std::int64_t droppedBytes = 0;  // bytes of a trailing partial frame removed
    bool headerRewritten = false;
};

// Makes a float WAV written by WavStreamWriter consistent after a crash: keeps
// every complete frame in the data chunk, drops a trailing partial frame and
// rewrites the header sizes. Throws MediaError (decode_failed) if the file is
// not such a WAV.
RepairResult repairWav(const std::filesystem::path& path);

}  // namespace siann::media
