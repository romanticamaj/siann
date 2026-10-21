#pragma once

// Media decoding, encoding and offline sample-rate conversion (M1: WAV only).
// Non-realtime code. Samples are float, interleaved, nominal range [-1, 1].

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace siann::media {

class MediaError : public std::runtime_error {
public:
    MediaError(std::string code, const std::string& message);

    // One of: unsupported_media, decode_failed, too_large, invalid_buffer.
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

struct AudioInfo {
    std::int32_t channels = 0;
    std::int64_t sampleRate = 0;
    std::int64_t frames = 0;
};

struct AudioBuffer {
    AudioInfo info;
    std::vector<float> samples;  // frames * channels, interleaved
};

// Reads only the header. Throws unsupported_media for anything but WAV.
AudioInfo probeWav(std::string_view bytes);

// Decodes any PCM (8/16/24/32-bit) or IEEE float (32/64-bit) WAV.
AudioBuffer decodeWav(std::string_view bytes);

// 32-bit IEEE float WAV with a fact chunk. Throws too_large above 4 GiB.
std::string encodeWavFloat32(const AudioBuffer& buffer);

// Offline conversion with r8brain (24-bit quality, linear phase). The output
// has round(frames * targetRate / sourceRate) frames, ties to even, and is
// time-aligned with the input.
AudioBuffer resample(const AudioBuffer& input, std::int64_t targetRate);

}  // namespace siann::media
