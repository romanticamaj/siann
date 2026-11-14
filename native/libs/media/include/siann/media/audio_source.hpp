#pragma once

// Chunked decoding and offline conversion (m5b-engine-project-media; architecture
// spec, "Commands and jobs", Jobs v0, import). The media.import job reads its file
// through an AudioSource, a seam tests replace with a paced generator, and
// converts block by block between cancel checks. readAll and resampleFrom give
// exactly what decode and resample give for the same bytes (the import's stored
// file and its hash do not depend on the path taken). Non-realtime code.

#include <cstdint>
#include <functional>
#include <memory>
#include <string_view>

#include "siann/media/audio.hpp"

namespace siann::media {

class AudioSource {
public:
    virtual ~AudioSource() = default;

    // Channels, rate and the frame count the source will deliver.
    virtual AudioInfo info() const = 0;

    // Reads up to `frames` frames, interleaved, into `out` (frames * channels
    // floats); returns how many it read, 0 at the end. Throws MediaError
    // (decode_failed for data that ends before info().frames).
    virtual std::int64_t read(float* out, std::int64_t frames) = 0;

    // Any thread: asks a read() that waits on something outside the process to
    // return soon (the job was cancelled). Decoders over memory never wait.
    virtual void interrupt() noexcept {}
};

// A decoder over the bytes of a WAV or FLAC file, which must outlive it. Throws
// MediaError as decode() does for the header (unsupported_media, decode_failed).
// Stricter than decode() in one way: a RIFF WAV whose data chunk claims more bytes
// than the file holds (cut off inside its audio) is decode_failed, where decode()
// reads what is there.
std::unique_ptr<AudioSource> openAudioSource(std::string_view bytes);

struct ConvertControl {
    // Checked before every block; true stops the work with MediaError("cancelled").
    std::function<bool()> cancelled;
    // Called after every block with the source frames read so far.
    std::function<void(std::int64_t framesDone)> progress;
};

// The source's frames, as decode() gives them.
AudioBuffer readAll(AudioSource& source, const ConvertControl& control = {});

// The source converted to targetRate, as resample(decode(...), targetRate) gives
// it, reading and converting one r8brain block (16384 frames) at a time. At the
// source's own rate this is readAll().
AudioBuffer resampleFrom(AudioSource& source, std::int64_t targetRate, const ConvertControl& control = {});

}  // namespace siann::media
