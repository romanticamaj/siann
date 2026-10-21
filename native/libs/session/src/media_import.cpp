#include "siann/session/media_import.hpp"

#include <optional>

#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"

namespace siann::session {

namespace fs = std::filesystem;
using json::Object;
using json::Value;

fs::path mediaPath(const fs::path& bundle, const hash::Digest& contentHash) {
    return bundle / "media" / (hash::toHex(contentHash) + ".wav");
}

ImportResult importMedia(Session& session, const fs::path& source, const std::string& mediaId, std::string actor,
                         std::string time) {
    const std::string original = io::readFile(source);
    const media::AudioInfo info = media::probeWav(original);
    const std::int64_t sessionRate = session.history().head().document.root().sampleRate;

    std::string stored;
    std::optional<hash::Digest> originalHash;
    media::AudioInfo storedInfo = info;
    if (info.sampleRate == sessionRate) {
        stored = original;
    } else {
        const media::AudioBuffer converted = media::resample(media::decodeWav(original), sessionRate);
        stored = media::encodeWavFloat32(converted);
        storedInfo = converted.info;
        originalHash = hash::sha256(original);
    }

    const hash::Digest contentHash = hash::sha256(stored);
    const fs::path target = mediaPath(session.bundlePath(), contentHash);
    if (!fs::exists(target)) {
        io::writeFileAtomic(target, stored);
    }

    Object params{
        {"op", Value(std::string("media.add"))},
        {"mediaId", Value(mediaId)},
        {"contentHash", Value(hash::formatHash(contentHash))},
        {"format", Value(std::string("wav"))},
        {"channels", Value(static_cast<double>(storedInfo.channels))},
        {"sampleRate", Value(static_cast<double>(storedInfo.sampleRate))},
        {"frames", Value(std::to_string(storedInfo.frames))},
    };
    if (originalHash) {
        params.emplace_back("originalHash", Value(hash::formatHash(*originalHash)));
    }
    const command::Revision& revision =
        session.commit({command::Command::fromJson(Value(std::move(params)))}, std::move(actor), std::move(time));
    return ImportResult{&revision, target, originalHash.has_value()};
}

}  // namespace siann::session
