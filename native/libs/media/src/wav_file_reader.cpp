#include "siann/media/wav_file_reader.hpp"

#include <algorithm>
#include <cstdio>
#include <vector>

#include "siann/media/audio.hpp"

#define DR_WAV_NO_STDIO
#if defined(_MSC_VER)
#pragma warning(push, 0)
#elif defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wall"
#pragma GCC diagnostic ignored "-Wextra"
#endif
#include "dr_wav.h"  // declarations only; the implementation lives in audio.cpp
#if defined(_MSC_VER)
#pragma warning(pop)
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

namespace siann::media {

namespace {

std::FILE* openForReading(const std::filesystem::path& path) {
#if defined(_WIN32)
    std::FILE* file = nullptr;
    if (_wfopen_s(&file, path.c_str(), L"rb") != 0) {
        return nullptr;
    }
    return file;
#else
    return std::fopen(path.c_str(), "rb");
#endif
}

int seekFile(std::FILE* file, std::int64_t offset, int origin) {
#if defined(_WIN32)
    return _fseeki64(file, offset, origin);
#else
    return fseeko(file, static_cast<off_t>(offset), origin);
#endif
}

std::int64_t tellFile(std::FILE* file) {
#if defined(_WIN32)
    return _ftelli64(file);
#else
    return static_cast<std::int64_t>(ftello(file));
#endif
}

size_t onRead(void* user, void* buffer, size_t bytes) {
    return std::fread(buffer, 1, bytes, static_cast<std::FILE*>(user));
}

drwav_bool32 onSeek(void* user, int offset, drwav_seek_origin origin) {
    const int whence = origin == DRWAV_SEEK_SET ? SEEK_SET : origin == DRWAV_SEEK_CUR ? SEEK_CUR : SEEK_END;
    return seekFile(static_cast<std::FILE*>(user), offset, whence) == 0 ? DRWAV_TRUE : DRWAV_FALSE;
}

drwav_bool32 onTell(void* user, drwav_int64* cursor) {
    const std::int64_t position = tellFile(static_cast<std::FILE*>(user));
    if (position < 0) {
        return DRWAV_FALSE;
    }
    *cursor = position;
    return DRWAV_TRUE;
}

}  // namespace

struct WavFileReader::Impl {
    std::FILE* file = nullptr;
    drwav wav{};
    bool open = false;
    host::MediaInfo info;
    std::int64_t cursor = 0;  // next frame dr_wav will return
    int chunkFrames = 0;
    std::vector<float> interleaved;

    ~Impl() {
        if (open) {
            drwav_uninit(&wav);
        }
        if (file != nullptr) {
            std::fclose(file);
        }
    }
};

WavFileReader::WavFileReader(const std::filesystem::path& path, int chunkFrames) : impl_(std::make_unique<Impl>()) {
    if (chunkFrames <= 0) {
        throw MediaError("invalid_buffer", "chunkFrames must be positive");
    }
    impl_->file = openForReading(path);
    if (impl_->file == nullptr) {
        throw MediaError("unsupported_media", "cannot open " + path.string());
    }
    char magic[12] = {};
    const size_t got = std::fread(magic, 1, sizeof(magic), impl_->file);
    std::rewind(impl_->file);
    if (got < 12 || detectFormat(std::string_view(magic, got)) != FileFormat::wav) {
        throw MediaError("unsupported_media", "not a WAV file: " + path.string());
    }
    if (!drwav_init(&impl_->wav, onRead, onSeek, onTell, impl_->file, nullptr)) {
        throw MediaError("decode_failed", "the WAV header could not be read: " + path.string());
    }
    impl_->open = true;
    impl_->info = host::MediaInfo{static_cast<int>(impl_->wav.channels), static_cast<std::int64_t>(impl_->wav.sampleRate),
                                  static_cast<std::int64_t>(impl_->wav.totalPCMFrameCount)};
    if (impl_->info.channels <= 0 || impl_->info.sampleRate <= 0) {
        throw MediaError("decode_failed", "the WAV header has no channels or sample rate");
    }
    impl_->chunkFrames = chunkFrames;
    impl_->interleaved.resize(static_cast<std::size_t>(chunkFrames) * static_cast<std::size_t>(impl_->info.channels));
}

WavFileReader::~WavFileReader() = default;

host::MediaInfo WavFileReader::info() const {
    return impl_->info;
}

std::int64_t WavFileReader::read(std::int64_t position, const host::AudioBufferView& destination) {
    destination.clear();
    const std::int64_t total = impl_->info.frames;
    if (position < 0 || position >= total || destination.frames <= 0) {
        return 0;
    }
    if (position != impl_->cursor) {
        if (!drwav_seek_to_pcm_frame(&impl_->wav, static_cast<drwav_uint64>(position))) {
            throw MediaError("decode_failed", "seeking in the WAV file failed");
        }
        impl_->cursor = position;
    }
    const auto channels = static_cast<std::size_t>(impl_->info.channels);
    const std::int64_t wanted = std::min<std::int64_t>(destination.frames, total - position);
    std::int64_t done = 0;
    while (done < wanted) {
        const auto n = static_cast<drwav_uint64>(std::min<std::int64_t>(impl_->chunkFrames, wanted - done));
        const drwav_uint64 got = drwav_read_pcm_frames_f32(&impl_->wav, n, impl_->interleaved.data());
        if (got == 0) {
            break;
        }
        const int shared = std::min(destination.channelCount, impl_->info.channels);
        for (drwav_uint64 i = 0; i < got; ++i) {
            for (int c = 0; c < shared; ++c) {
                destination.channel(c)[done + static_cast<std::int64_t>(i)] =
                    impl_->interleaved[static_cast<std::size_t>(i) * channels + static_cast<std::size_t>(c)];
            }
        }
        done += static_cast<std::int64_t>(got);
        impl_->cursor += static_cast<std::int64_t>(got);
        if (got < n) {
            break;
        }
    }
    return done;
}

}  // namespace siann::media
