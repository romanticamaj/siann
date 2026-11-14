#include "siann/session/media_import.hpp"

#include <algorithm>
#include <exception>
#include <optional>
#include <system_error>
#include <utility>

#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/media/peaks.hpp"

namespace siann::session {

namespace fs = std::filesystem;
using json::Object;
using json::Value;

namespace {

// A MediaReader over an interleaved buffer, without copying it (the peaks of a
// converted file are computed from the buffer the conversion produced).
class InterleavedReader final : public host::MediaReader {
public:
    explicit InterleavedReader(const media::AudioBuffer& buffer) : buffer_(buffer) {}

    host::MediaInfo info() const override {
        return host::MediaInfo{buffer_.info.channels, buffer_.info.sampleRate, buffer_.info.frames};
    }

    std::int64_t read(std::int64_t position, const host::AudioBufferView& destination) override {
        const std::int64_t frames = destination.frames;
        const std::int64_t total = buffer_.info.frames;
        const std::int64_t from = std::clamp<std::int64_t>(position, 0, total);
        const std::int64_t to = std::clamp<std::int64_t>(position + frames, 0, total);
        const std::int64_t count = std::max<std::int64_t>(0, to - from);
        const std::int64_t lead = count > 0 ? from - position : frames;
        const auto channels = static_cast<std::size_t>(buffer_.info.channels);
        for (int c = 0; c < destination.channelCount; ++c) {
            float* out = destination.channel(c);
            if (c >= buffer_.info.channels || count == 0) {
                std::fill(out, out + frames, 0.0f);
                continue;
            }
            std::fill(out, out + lead, 0.0f);
            for (std::int64_t i = 0; i < count; ++i) {
                out[lead + i] = buffer_.samples[static_cast<std::size_t>(from + i) * channels + static_cast<std::size_t>(c)];
            }
            std::fill(out + lead + count, out + frames, 0.0f);
        }
        return count;
    }

private:
    const media::AudioBuffer& buffer_;
};

void removeQuietly(const fs::path& file) noexcept {
    std::error_code ec;
    fs::remove(file, ec);
}

}  // namespace

fs::path mediaPath(const fs::path& bundle, const hash::Digest& contentHash, model::MediaFormat format) {
    return bundle / "media" / (hash::toHex(contentHash) + (format == model::MediaFormat::flac ? ".flac" : ".wav"));
}

std::string mediaNameFromPath(const fs::path& file) {
    std::string name;
    try {
        const std::u8string text = file.filename().u8string();
        name.assign(text.begin(), text.end());
    } catch (const std::exception&) {
        name.clear();  // a name the platform cannot express as UTF-8
    }
    if (name.empty()) {
        return "audio";
    }
    if (name.size() > model::kMaxMediaNameBytes) {
        std::size_t cut = model::kMaxMediaNameBytes;
        // Back to the first byte of the code point that straddles the limit.
        while (cut > 0 && (static_cast<unsigned char>(name[cut]) & 0xC0) == 0x80) {
            --cut;
        }
        name.resize(cut);
    }
    return model::isValidMediaName(name) ? name : std::string("audio");
}

ImportSource openImportSource(const fs::path& file) {
    std::error_code ec;
    if (!fs::is_regular_file(file, ec)) {
        throw media::MediaError("not_found", "no file to import at this path");
    }
    ImportSource source;
    source.name = mediaNameFromPath(file);
    source.original = io::readFile(file);
    source.format = media::detectFormat(source.original) == media::FileFormat::flac ? model::MediaFormat::flac
                                                                                     : model::MediaFormat::wav;
    // The header is checked now; prepareImport opens its own decoder over the
    // bytes (source.audio stays empty, so moving the source moves nothing it views).
    (void)media::openAudioSource(source.original);
    source.originalHash = hash::sha256(source.original);
    return source;
}

PreparedImport prepareImport(const fs::path& bundle, std::int64_t sessionRate, ImportSource& source,
                             ImportProgress* progress, bool writePeaks) {
    std::unique_ptr<media::AudioSource> fileDecoder;
    media::AudioSource* audio = source.audio.get();
    if (audio == nullptr) {
        fileDecoder = media::openAudioSource(source.original);
        audio = fileDecoder.get();
    }
    const media::AudioInfo info = audio->info();
    if (progress != nullptr) {
        progress->framesTotal = info.frames;
        progress->framesDone = 0;
    }
    media::ConvertControl control;
    if (progress != nullptr) {
        control.cancelled = [progress] { return progress->cancel.load(); };
        control.progress = [progress](std::int64_t done) { progress->framesDone = done; };
    }

    PreparedImport prepared;
    prepared.bundle = bundle;
    prepared.name = source.name;
    media::AudioBuffer decoded;
    std::string converted;
    const std::string* stored = &source.original;
    if (info.sampleRate == sessionRate) {
        decoded = media::readAll(*audio, control);
        prepared.format = source.format;
        prepared.info = decoded.info;
    } else {
        decoded = media::resampleFrom(*audio, sessionRate, control);
        converted = media::encodeWavFloat32(decoded);
        stored = &converted;
        prepared.format = model::MediaFormat::wav;
        prepared.info = decoded.info;
        prepared.originalHash = source.originalHash;
    }
    fileDecoder.reset();

    prepared.contentHash = hash::sha256(*stored);
    prepared.mediaFile = mediaPath(bundle, prepared.contentHash, prepared.format);
    const std::string hex = hash::toHex(prepared.contentHash);
    prepared.peaksFile = media::peaksPath(bundle, hex);
    try {
        std::error_code ec;
        if (!fs::exists(prepared.mediaFile, ec)) {
            io::createDirectoriesDurable(prepared.mediaFile.parent_path());
            io::writeFileAtomic(prepared.mediaFile, *stored);
            prepared.created.push_back(prepared.mediaFile);
        }
        converted.clear();
        converted.shrink_to_fit();
        if (writePeaks && !fs::exists(prepared.peaksFile, ec)) {
            InterleavedReader reader(decoded);
            media::writePeaks(bundle, hex, media::computePeaks(reader));
            prepared.created.push_back(prepared.peaksFile);
        }
    } catch (...) {
        discardImport(prepared);
        throw;
    }
    return prepared;
}

const command::Revision& commitImport(Session& session, const PreparedImport& prepared, const std::string& mediaId,
                                      std::string actor, std::string time) {
    Object params{
        {"op", Value(std::string("media.add"))},
        {"mediaId", Value(mediaId)},
        {"contentHash", Value(hash::formatHash(prepared.contentHash))},
        {"format", Value(std::string(prepared.format == model::MediaFormat::flac ? "flac" : "wav"))},
        {"channels", Value(static_cast<double>(prepared.info.channels))},
        {"sampleRate", Value(static_cast<double>(prepared.info.sampleRate))},
        {"frames", Value(std::to_string(prepared.info.frames))},
    };
    if (prepared.originalHash) {
        params.emplace_back("originalHash", Value(hash::formatHash(*prepared.originalHash)));
    }
    if (model::isValidMediaName(prepared.name)) {
        params.emplace_back("name", Value(prepared.name));
    }
    return session.commit({command::Command::fromJson(Value(std::move(params)))}, std::move(actor), std::move(time));
}

void discardImport(const PreparedImport& prepared) noexcept {
    for (const fs::path& file : prepared.created) {
        removeQuietly(file);
    }
}

ImportResult importMedia(Session& session, const fs::path& source, const std::string& mediaId, std::string actor,
                         std::string time) {
    std::error_code ec;
    if (!fs::is_regular_file(source, ec)) {
        // As before the import job existed: a missing file is the file system's error.
        throw io::IoError(source, "no file to import at this path");
    }
    ImportSource input = openImportSource(source);
    const std::int64_t sessionRate = session.history().head().document.root().sampleRate;
    const PreparedImport prepared = prepareImport(session.bundlePath(), sessionRate, input, nullptr, false);
    // A pointer, not a reference: GCC's -Wdangling-reference.
    const command::Revision* revision = &commitImport(session, prepared, mediaId, std::move(actor), std::move(time));
    return ImportResult{revision, prepared.mediaFile, prepared.originalHash.has_value()};
}

}  // namespace siann::session
