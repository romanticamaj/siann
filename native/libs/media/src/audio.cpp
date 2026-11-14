#include "siann/media/audio.hpp"
#include "siann/media/audio_source.hpp"

#include <algorithm>
#include <cstring>
#include <limits>
#include <memory>
#include <utility>
#include <vector>

#define DR_WAV_IMPLEMENTATION
#define DR_WAV_NO_STDIO
#define DR_FLAC_IMPLEMENTATION
#define DR_FLAC_NO_STDIO
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
#include "dr_flac.h"
#if defined(_MSC_VER)
#pragma warning(pop)
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
#include "wav_frames.hpp"

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

    // The frame count, clamped to what the data chunk holds.
    AudioInfo info() const {
        const std::uint64_t frames = std::min<std::uint64_t>(wav_.totalPCMFrameCount, detail::framesTheDataHolds(wav_));
        return AudioInfo{static_cast<std::int32_t>(wav_.channels), static_cast<std::int64_t>(wav_.sampleRate),
                         static_cast<std::int64_t>(frames)};
    }

private:
    drwav wav_{};
    bool open_ = false;
};

class Flac {
public:
    explicit Flac(std::string_view bytes) {
        if (bytes.size() < 4 || std::memcmp(bytes.data(), "fLaC", 4) != 0) {
            throw MediaError("unsupported_media", "not a FLAC file");
        }
        flac_ = drflac_open_memory(bytes.data(), bytes.size(), nullptr);
        if (flac_ == nullptr) {
            throw MediaError("decode_failed", "the FLAC stream could not be opened");
        }
        if (flac_->channels == 0 || flac_->sampleRate == 0) {
            throw MediaError("decode_failed", "the FLAC stream has no channels or sample rate");
        }
    }
    ~Flac() {
        if (flac_ != nullptr) {
            drflac_close(flac_);
        }
    }
    Flac(const Flac&) = delete;
    Flac& operator=(const Flac&) = delete;

    drflac* get() noexcept { return flac_; }

    AudioInfo info() const {
        return AudioInfo{static_cast<std::int32_t>(flac_->channels), static_cast<std::int64_t>(flac_->sampleRate),
                         static_cast<std::int64_t>(flac_->totalPCMFrameCount)};
    }

private:
    drflac* flac_ = nullptr;
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

FileFormat detectFormat(std::string_view bytes) {
    if (bytes.size() >= 4 && std::memcmp(bytes.data(), "fLaC", 4) == 0) {
        return FileFormat::flac;
    }
    if (bytes.size() >= 12 && (std::memcmp(bytes.data(), "RIFF", 4) == 0 || std::memcmp(bytes.data(), "RF64", 4) == 0) &&
        std::memcmp(bytes.data() + 8, "WAVE", 4) == 0) {
        return FileFormat::wav;
    }
    throw MediaError("unsupported_media", "not a WAV or FLAC file");
}

AudioInfo probe(std::string_view bytes) {
    return detectFormat(bytes) == FileFormat::flac ? probeFlac(bytes) : probeWav(bytes);
}

AudioBuffer decode(std::string_view bytes) {
    return detectFormat(bytes) == FileFormat::flac ? decodeFlac(bytes) : decodeWav(bytes);
}

AudioInfo probeFlac(std::string_view bytes) {
    Flac flac(bytes);
    return flac.info();
}

AudioBuffer decodeFlac(std::string_view bytes) {
    Flac flac(bytes);
    AudioBuffer buffer;
    buffer.info = flac.info();
    if (buffer.info.frames <= 0) {
        throw MediaError("decode_failed", "FLAC streams without a known length are not supported");
    }
    const auto total = static_cast<std::uint64_t>(buffer.info.frames) * static_cast<std::uint64_t>(buffer.info.channels);
    if (total > std::numeric_limits<std::size_t>::max() / sizeof(float)) {
        throw MediaError("too_large", "the FLAC file is too large to decode in memory");
    }
    // STREAMINFO's total is not checked against the stream, and a frame of a
    // few bytes can hold 65535 samples a channel, so the input's size does not
    // bound it tightly either: the buffer grows only as samples decode. The
    // first reserve (a sample a byte) holds a 16-bit stream at half its size.
    const auto channels = static_cast<std::uint64_t>(buffer.info.channels);
    const auto claimed = static_cast<std::uint64_t>(buffer.info.frames);
    buffer.samples.reserve(static_cast<std::size_t>(std::min<std::uint64_t>(total, bytes.size())));
    constexpr std::uint64_t kChunkFrames = 1u << 16;
    std::uint64_t decoded = 0;
    while (decoded < claimed) {
        const std::uint64_t want = std::min(kChunkFrames, claimed - decoded);
        buffer.samples.resize(static_cast<std::size_t>((decoded + want) * channels));
        const drflac_uint64 read = drflac_read_pcm_frames_f32(flac.get(), static_cast<drflac_uint64>(want),
                                                              buffer.samples.data() + decoded * channels);
        decoded += read;
        if (read != want) {
            throw MediaError("decode_failed", "the FLAC data ended early or failed its checksum");
        }
    }
    return buffer;
}

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

// ---- Chunked decoding and conversion (audio_source.hpp) ---------------------

namespace {

// Reads the frames decode() would: info().frames of them, clamped as decode
// clamps; fewer is decode_failed, as in decodeWav and decodeFlac.
class WavSource final : public AudioSource {
public:
    explicit WavSource(std::string_view bytes) : wav_(bytes), info_(wav_.info()) {}

    AudioInfo info() const override { return info_; }

    std::int64_t read(float* out, std::int64_t frames) override {
        const std::int64_t want = std::max<std::int64_t>(0, std::min(frames, info_.frames - position_));
        if (want == 0) {
            return 0;
        }
        const drwav_uint64 got = drwav_read_pcm_frames_f32(&wav_.get(), static_cast<drwav_uint64>(want), out);
        if (got != static_cast<drwav_uint64>(want)) {
            throw MediaError("decode_failed", "the WAV data ended early");
        }
        position_ += want;
        return want;
    }

private:
    Wav wav_;
    AudioInfo info_;
    std::int64_t position_ = 0;
};

class FlacSource final : public AudioSource {
public:
    explicit FlacSource(std::string_view bytes) : flac_(bytes), info_(flac_.info()) {
        if (info_.frames <= 0) {
            throw MediaError("decode_failed", "FLAC streams without a known length are not supported");
        }
    }

    AudioInfo info() const override { return info_; }

    std::int64_t read(float* out, std::int64_t frames) override {
        const std::int64_t want = std::max<std::int64_t>(0, std::min(frames, info_.frames - position_));
        if (want == 0) {
            return 0;
        }
        const drflac_uint64 got = drflac_read_pcm_frames_f32(flac_.get(), static_cast<drflac_uint64>(want), out);
        if (got != static_cast<drflac_uint64>(want)) {
            throw MediaError("decode_failed", "the FLAC data ended early or failed its checksum");
        }
        position_ += want;
        return want;
    }

private:
    Flac flac_;
    AudioInfo info_;
    std::int64_t position_ = 0;
};

void checkCancelled(const ConvertControl& control) {
    if (control.cancelled && control.cancelled()) {
        throw MediaError("cancelled", "the conversion was cancelled");
    }
}

// Reads until `frames` frames are in `out` or the source ends; returns the count.
std::int64_t fill(AudioSource& source, float* out, std::int64_t frames, std::int32_t channels) {
    std::int64_t done = 0;
    while (done < frames) {
        const std::int64_t got = source.read(out + done * channels, frames - done);
        if (got <= 0) {
            break;
        }
        done += got;
    }
    return done;
}

void checkInfo(const AudioInfo& info) {
    if (info.channels <= 0 || info.sampleRate <= 0 || info.frames < 0) {
        throw MediaError("invalid_buffer", "the source reports no channels, rate or length");
    }
    const auto total = static_cast<std::uint64_t>(info.frames) * static_cast<std::uint64_t>(info.channels);
    if (total > std::numeric_limits<std::size_t>::max() / sizeof(float)) {
        throw MediaError("too_large", "the file is too large to decode in memory");
    }
}

}  // namespace

std::unique_ptr<AudioSource> openAudioSource(std::string_view bytes) {
    if (detectFormat(bytes) == FileFormat::flac) {
        return std::make_unique<FlacSource>(bytes);
    }
    return std::make_unique<WavSource>(bytes);
}

AudioBuffer readAll(AudioSource& source, const ConvertControl& control) {
    AudioBuffer buffer;
    buffer.info = source.info();
    checkInfo(buffer.info);
    const auto channels = static_cast<std::size_t>(buffer.info.channels);
    // Grows as frames arrive: a header's claim is not trusted with an allocation.
    constexpr std::int64_t kChunkFrames = 1 << 16;
    std::int64_t done = 0;
    while (done < buffer.info.frames) {
        checkCancelled(control);
        const std::int64_t want = std::min(kChunkFrames, buffer.info.frames - done);
        buffer.samples.resize(static_cast<std::size_t>(done + want) * channels);
        const std::int64_t got =
            fill(source, buffer.samples.data() + static_cast<std::size_t>(done) * channels, want, buffer.info.channels);
        if (got != want) {
            throw MediaError("decode_failed", "the audio data ended early");
        }
        done += got;
        if (control.progress) {
            control.progress(done);
        }
    }
    return buffer;
}

AudioBuffer resampleFrom(AudioSource& source, std::int64_t targetRate, const ConvertControl& control) {
    const AudioInfo info = source.info();
    checkInfo(info);
    if (targetRate <= 0) {
        throw MediaError("invalid_buffer", "the target rate must be positive");
    }
    if (targetRate == info.sampleRate) {
        return readAll(source, control);
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

    // What CDSPResampler::oneshot does for each channel, all channels in step:
    // blocks of kBlock input samples, then blocks of zeros until the output is
    // complete. Same blocks, same resampler state, so the same samples.
    constexpr int kBlock = 1 << 14;
    const auto channels = static_cast<std::size_t>(info.channels);
    std::vector<std::unique_ptr<r8b::CDSPResampler24>> resamplers;
    for (std::size_t ch = 0; ch < channels; ++ch) {
        resamplers.push_back(std::make_unique<r8b::CDSPResampler24>(static_cast<double>(info.sampleRate),
                                                                    static_cast<double>(targetRate), kBlock));
    }
    std::vector<float> interleaved(static_cast<std::size_t>(kBlock) * channels);
    std::vector<double> block(kBlock);
    const std::vector<double> zeros(kBlock, 0.0);
    std::int64_t read = 0;
    std::int64_t written = 0;
    while (written < outFrames) {
        checkCancelled(control);
        int count = kBlock;
        bool silent = true;
        if (read < info.frames) {
            const std::int64_t want = std::min<std::int64_t>(kBlock, info.frames - read);
            const std::int64_t got = fill(source, interleaved.data(), want, info.channels);
            if (got != want) {
                throw MediaError("decode_failed", "the audio data ended early");
            }
            read += got;
            count = static_cast<int>(got);
            silent = false;
        }
        int produced = 0;
        for (std::size_t ch = 0; ch < channels; ++ch) {
            double* input = const_cast<double*>(zeros.data());  // r8brain never writes its input
            if (!silent) {
                for (int i = 0; i < count; ++i) {
                    block[static_cast<std::size_t>(i)] = interleaved[static_cast<std::size_t>(i) * channels + ch];
                }
                input = block.data();
            }
            double* out = nullptr;
            const int available = resamplers[ch]->process(input, count, out);
            produced = static_cast<int>(std::min<std::int64_t>(available, outFrames - written));
            for (int i = 0; i < produced; ++i) {
                output.samples[static_cast<std::size_t>(written + i) * channels + ch] = static_cast<float>(out[i]);
            }
        }
        written += produced;
        if (control.progress && !silent) {
            control.progress(read);
        }
    }
    return output;
}

}  // namespace siann::media
