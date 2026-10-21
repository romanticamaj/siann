#include "siann/media/audio.hpp"

#include <cstring>
#include <limits>
#include <memory>
#include <utility>

#define DR_WAV_IMPLEMENTATION
#define DR_WAV_NO_STDIO
#if defined(_MSC_VER)
#pragma warning(push, 0)
#elif defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wall"
#pragma GCC diagnostic ignored "-Wextra"
#pragma GCC diagnostic ignored "-Wpedantic"
#pragma GCC diagnostic ignored "-Wshadow"
#endif
#include "dr_wav.h"
#if defined(_MSC_VER)
#pragma warning(pop)
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

#if defined(_MSC_VER)
#pragma warning(push, 0)
#endif
#include "CDSPResampler.h"
#if defined(_MSC_VER)
#pragma warning(pop)
#endif

namespace siann::media {

MediaError::MediaError(std::string code, const std::string& message)
    : std::runtime_error(message), code_(std::move(code)) {}

namespace {

class Wav {
public:
    explicit Wav(std::string_view bytes) {
        if (bytes.size() < 12 || (std::memcmp(bytes.data(), "RIFF", 4) != 0 && std::memcmp(bytes.data(), "RF64", 4) != 0) ||
            std::memcmp(bytes.data() + 8, "WAVE", 4) != 0) {
            throw MediaError("unsupported_media", "not a WAV file");
        }
        if (!drwav_init_memory(&wav_, bytes.data(), bytes.size(), nullptr)) {
            throw MediaError("decode_failed", "the WAV header could not be read");
        }
        open_ = true;
        if (wav_.channels == 0 || wav_.sampleRate == 0) {
            throw MediaError("decode_failed", "the WAV header has no channels or sample rate");
        }
    }
    ~Wav() {
        if (open_) {
            drwav_uninit(&wav_);
        }
    }
    Wav(const Wav&) = delete;
    Wav& operator=(const Wav&) = delete;

    drwav& get() noexcept { return wav_; }

    AudioInfo info() const {
        return AudioInfo{static_cast<std::int32_t>(wav_.channels), static_cast<std::int64_t>(wav_.sampleRate),
                         static_cast<std::int64_t>(wav_.totalPCMFrameCount)};
    }

private:
    drwav wav_{};
    bool open_ = false;
};

void putU16(std::string& out, std::uint16_t v) {
    out.push_back(static_cast<char>(v & 0xFF));
    out.push_back(static_cast<char>(v >> 8));
}

void putU32(std::string& out, std::uint32_t v) {
    for (int i = 0; i < 4; ++i) {
        out.push_back(static_cast<char>((v >> (8 * i)) & 0xFF));
    }
}

std::int64_t roundedFrames(std::int64_t frames, std::int64_t from, std::int64_t to) {
    // frames * to / from, nearest, ties to even, in exact integer arithmetic.
    const std::int64_t whole = frames / from;
    const std::int64_t rest = frames % from;
    // frames * to = whole * from * to + rest * to
    std::int64_t q = whole * to + (rest * to) / from;
    const std::int64_t r = (rest * to) % from;
    if (2 * r > from || (2 * r == from && (q & 1) != 0)) {
        ++q;
    }
    return q;
}

}  // namespace

AudioInfo probeWav(std::string_view bytes) {
    Wav wav(bytes);
    return wav.info();
}

AudioBuffer decodeWav(std::string_view bytes) {
    Wav wav(bytes);
    AudioBuffer buffer;
    buffer.info = wav.info();
    const auto total = static_cast<std::uint64_t>(buffer.info.frames) * static_cast<std::uint64_t>(buffer.info.channels);
    if (total > std::numeric_limits<std::size_t>::max() / sizeof(float)) {
        throw MediaError("too_large", "the WAV file is too large to decode in memory");
    }
    buffer.samples.resize(static_cast<std::size_t>(total));
    const drwav_uint64 read =
        drwav_read_pcm_frames_f32(&wav.get(), static_cast<drwav_uint64>(buffer.info.frames), buffer.samples.data());
    if (read != static_cast<drwav_uint64>(buffer.info.frames)) {
        throw MediaError("decode_failed", "the WAV data ended early");
    }
    return buffer;
}

std::string encodeWavFloat32(const AudioBuffer& buffer) {
    const AudioInfo& info = buffer.info;
    if (info.channels <= 0 || info.sampleRate <= 0 || info.frames < 0 ||
        buffer.samples.size() != static_cast<std::size_t>(info.frames) * static_cast<std::size_t>(info.channels)) {
        throw MediaError("invalid_buffer", "the buffer does not match its info");
    }
    const std::uint64_t dataBytes = static_cast<std::uint64_t>(buffer.samples.size()) * 4u;
    const std::uint64_t riffBytes = 4 + (8 + 16) + (8 + 4) + (8 + dataBytes);
    if (riffBytes > std::numeric_limits<std::uint32_t>::max()) {
        throw MediaError("too_large", "float WAV output above 4 GiB needs RF64, which M1 does not write");
    }
    const auto channels = static_cast<std::uint16_t>(info.channels);
    const auto rate = static_cast<std::uint32_t>(info.sampleRate);

    std::string out;
    out.reserve(static_cast<std::size_t>(riffBytes + 8));
    out += "RIFF";
    putU32(out, static_cast<std::uint32_t>(riffBytes));
    out += "WAVE";
    out += "fmt ";
    putU32(out, 16);
    putU16(out, 3);  // WAVE_FORMAT_IEEE_FLOAT
    putU16(out, channels);
    putU32(out, rate);
    putU32(out, rate * channels * 4u);
    putU16(out, static_cast<std::uint16_t>(channels * 4u));
    putU16(out, 32);
    out += "fact";
    putU32(out, 4);
    putU32(out, static_cast<std::uint32_t>(info.frames));
    out += "data";
    putU32(out, static_cast<std::uint32_t>(dataBytes));
    for (const float sample : buffer.samples) {
        std::uint32_t bits = 0;
        std::memcpy(&bits, &sample, 4);
        putU32(out, bits);
    }
    return out;
}

AudioBuffer resample(const AudioBuffer& input, std::int64_t targetRate) {
    const AudioInfo& info = input.info;
    if (info.channels <= 0 || info.sampleRate <= 0 || targetRate <= 0 ||
        input.samples.size() != static_cast<std::size_t>(info.frames) * static_cast<std::size_t>(info.channels)) {
        throw MediaError("invalid_buffer", "the buffer does not match its info");
    }
    if (targetRate == info.sampleRate) {
        return input;
    }
    if (info.frames > std::numeric_limits<int>::max()) {
        throw MediaError("too_large", "files longer than 2^31 frames are not converted in M1");
    }
    const std::int64_t outFrames = roundedFrames(info.frames, info.sampleRate, targetRate);
    if (outFrames > std::numeric_limits<int>::max()) {
        throw MediaError("too_large", "converted file would exceed 2^31 frames");
    }

    AudioBuffer output;
    output.info = AudioInfo{info.channels, targetRate, outFrames};
    output.samples.resize(static_cast<std::size_t>(outFrames) * static_cast<std::size_t>(info.channels));

    const auto channels = static_cast<std::size_t>(info.channels);
    const auto inLen = static_cast<std::size_t>(info.frames);
    const auto outLen = static_cast<std::size_t>(outFrames);
    std::vector<double> in(inLen);
    std::vector<double> out(outLen);
    constexpr int kBlock = 1 << 14;
    for (std::size_t ch = 0; ch < channels; ++ch) {
        for (std::size_t i = 0; i < inLen; ++i) {
            in[i] = input.samples[i * channels + ch];
        }
        auto resampler = std::make_unique<r8b::CDSPResampler24>(static_cast<double>(info.sampleRate),
                                                                static_cast<double>(targetRate), kBlock);
        resampler->oneshot(in.data(), static_cast<int>(inLen), out.data(), static_cast<int>(outLen));
        for (std::size_t i = 0; i < outLen; ++i) {
            output.samples[i * channels + ch] = static_cast<float>(out[i]);
        }
    }
    return output;
}

}  // namespace siann::media
