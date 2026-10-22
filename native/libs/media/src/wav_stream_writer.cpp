#include "siann/media/wav_stream_writer.hpp"

#include <cstdio>
#include <cstring>
#include <filesystem>
#include <limits>
#include <string>
#include <vector>

#include "siann/media/audio.hpp"

#if defined(_WIN32)
#include <io.h>
#include <share.h>
#else
#include <unistd.h>
#endif

namespace siann::media {

namespace {

constexpr std::uint32_t kHeaderBytes = 12 + (8 + 16) + (8 + 4) + 8;  // RIFF, fmt, fact, data header

std::FILE* openFile(const std::filesystem::path& path, bool truncate) {
#if defined(_WIN32)
    // Other processes and threads may read the take while it is recorded.
    return _wfsopen(path.c_str(), truncate ? L"wb+" : L"rb+", _SH_DENYWR);
#else
    return std::fopen(path.c_str(), truncate ? "wb+" : "rb+");
#endif
}

void syncFile(std::FILE* file) {
    std::fflush(file);
#if defined(_WIN32)
    _commit(_fileno(file));
#else
    ::fsync(fileno(file));
#endif
}

void put16(std::string& out, std::uint16_t v) {
    out.push_back(static_cast<char>(v & 0xFF));
    out.push_back(static_cast<char>(v >> 8));
}

void put32(std::string& out, std::uint32_t v) {
    for (int i = 0; i < 4; ++i) {
        out.push_back(static_cast<char>((v >> (8 * i)) & 0xFF));
    }
}

std::string header(int channels, std::int64_t sampleRate, std::int64_t frames) {
    const std::uint64_t dataBytes = static_cast<std::uint64_t>(frames) * static_cast<std::uint64_t>(channels) * 4u;
    std::string h = "RIFF";
    put32(h, static_cast<std::uint32_t>(kHeaderBytes - 8 + dataBytes));
    h += "WAVEfmt ";
    put32(h, 16);
    put16(h, 3);
    put16(h, static_cast<std::uint16_t>(channels));
    put32(h, static_cast<std::uint32_t>(sampleRate));
    put32(h, static_cast<std::uint32_t>(sampleRate * channels * 4));
    put16(h, static_cast<std::uint16_t>(channels * 4));
    put16(h, 32);
    h += "fact";
    put32(h, 4);
    put32(h, static_cast<std::uint32_t>(frames));
    h += "data";
    put32(h, static_cast<std::uint32_t>(dataBytes));
    return h;
}

}  // namespace

struct WavStreamWriter::Impl {
    std::FILE* file = nullptr;
    int channels = 0;
    std::int64_t sampleRate = 0;
    std::int64_t frames = 0;
    std::vector<float> interleaved;

    void writeHeader() {
        const std::string h = header(channels, sampleRate, frames);
        std::fseek(file, 0, SEEK_SET);
        std::fwrite(h.data(), 1, h.size(), file);
        std::fseek(file, 0, SEEK_END);
    }
};

WavStreamWriter::WavStreamWriter(const std::filesystem::path& path, int channels, std::int64_t sampleRate)
    : impl_(std::make_unique<Impl>()) {
    if (channels <= 0 || sampleRate <= 0) {
        throw MediaError("invalid_buffer", "a recording needs channels and a sample rate");
    }
    impl_->file = openFile(path, true);
    if (impl_->file == nullptr) {
        throw MediaError("unsupported_media", "cannot create " + path.string());
    }
    impl_->channels = channels;
    impl_->sampleRate = sampleRate;
    impl_->writeHeader();
    syncFile(impl_->file);
}

WavStreamWriter::~WavStreamWriter() {
    if (impl_ && impl_->file != nullptr) {
        try {
            close();
        } catch (...) {
        }
    }
}

void WavStreamWriter::append(const host::AudioBufferView& source, int frames) {
    if (impl_->file == nullptr || frames <= 0) {
        return;
    }
    const auto max = std::numeric_limits<std::uint32_t>::max();
    const std::uint64_t after = static_cast<std::uint64_t>(impl_->frames + frames) *
                                static_cast<std::uint64_t>(impl_->channels) * 4u + kHeaderBytes;
    if (after > max) {
        throw MediaError("too_large", "recordings above 4 GiB need RF64, which is not written yet");
    }
    const auto channels = static_cast<std::size_t>(impl_->channels);
    impl_->interleaved.resize(static_cast<std::size_t>(frames) * channels);
    for (int i = 0; i < frames; ++i) {
        for (std::size_t c = 0; c < channels; ++c) {
            impl_->interleaved[static_cast<std::size_t>(i) * channels + c] =
                static_cast<int>(c) < source.channelCount ? source.channel(static_cast<int>(c))[i] : 0.0f;
        }
    }
    std::fwrite(impl_->interleaved.data(), sizeof(float), impl_->interleaved.size(), impl_->file);
    impl_->frames += frames;
}

void WavStreamWriter::checkpoint() {
    if (impl_->file == nullptr) {
        return;
    }
    impl_->writeHeader();
    syncFile(impl_->file);
}

void WavStreamWriter::close() {
    if (impl_->file == nullptr) {
        return;
    }
    checkpoint();
    std::fclose(impl_->file);
    impl_->file = nullptr;
}

std::int64_t WavStreamWriter::frames() const noexcept {
    return impl_->frames;
}

RepairResult repairWav(const std::filesystem::path& path) {
    std::FILE* file = openFile(path, false);
    if (file == nullptr) {
        throw MediaError("decode_failed", "cannot open " + path.string());
    }
    RepairResult result;
    char h[kHeaderBytes];
    const bool headerOk = std::fread(h, 1, sizeof(h), file) == sizeof(h) && std::memcmp(h, "RIFF", 4) == 0 &&
                          std::memcmp(h + 8, "WAVEfmt ", 8) == 0 && std::memcmp(h + 36, "fact", 4) == 0 &&
                          std::memcmp(h + 48, "data", 4) == 0 && static_cast<unsigned char>(h[20]) == 3;
    if (!headerOk) {
        std::fclose(file);
        throw MediaError("decode_failed", "not a SIANN recording: " + path.string());
    }
    const int channels = static_cast<unsigned char>(h[22]) | (static_cast<unsigned char>(h[23]) << 8);
    const std::int64_t sampleRate = static_cast<std::uint32_t>(static_cast<unsigned char>(h[24]) |
                                                               (static_cast<unsigned char>(h[25]) << 8) |
                                                               (static_cast<unsigned char>(h[26]) << 16) |
                                                               (static_cast<unsigned char>(h[27]) << 24));
    std::fclose(file);
    if (channels <= 0) {
        throw MediaError("decode_failed", "the recording header has no channels");
    }
    const auto size = static_cast<std::int64_t>(std::filesystem::file_size(path));
    const std::int64_t frameBytes = static_cast<std::int64_t>(channels) * 4;
    const std::int64_t dataBytes = size - kHeaderBytes;
    result.frames = dataBytes / frameBytes;
    result.droppedBytes = dataBytes % frameBytes;
    if (result.droppedBytes != 0) {
        std::filesystem::resize_file(path, static_cast<std::uintmax_t>(kHeaderBytes + result.frames * frameBytes));
    }
    file = openFile(path, false);
    if (file == nullptr) {
        throw MediaError("decode_failed", "cannot reopen " + path.string());
    }
    const std::string fixed = header(channels, sampleRate, result.frames);
    std::fseek(file, 0, SEEK_SET);
    std::fwrite(fixed.data(), 1, fixed.size(), file);
    syncFile(file);
    std::fclose(file);
    result.headerRewritten = true;
    return result;
}

}  // namespace siann::media
