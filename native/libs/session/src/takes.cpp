#include "siann/session/takes.hpp"

#include <algorithm>

#include "siann/hash/jcs.hpp"
#include "siann/hash/merkle.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/media/wav_stream_writer.hpp"
#include "siann/model/field_reader.hpp"
#include "siann/session/media_import.hpp"

namespace siann::session {

namespace fs = std::filesystem;
using json::Object;
using json::Value;

namespace {

constexpr std::string_view kManifestSchema = "siann.take_manifest.v1";

fs::path recordingDir(const fs::path& bundle) {
    return bundle / "media" / "recording";
}

void checkTakeId(const std::string& takeId) {
    if (!hash::isValidEntityId(takeId) || takeId.size() > 60) {
        throw SessionError("invalid_take", "take IDs follow entity ID rules and have at most 60 characters");
    }
}

void writeManifest(const fs::path& bundle, const TakeManifest& m) {
    Object o{
        {"schema", Value(std::string(kManifestSchema))},
        {"takeId", Value(m.takeId)},
        {"trackId", Value(m.trackId)},
        {"channels", Value(static_cast<double>(m.channels))},
        {"sampleRate", Value(static_cast<double>(m.sampleRate))},
        {"recordOffset", Value(std::to_string(m.recordOffset))},
    };
    if (m.startPosition) {
        o.emplace_back("startPosition", Value(std::to_string(*m.startPosition)));
    }
    io::writeFileAtomic(takeManifestPath(bundle, m.takeId), jcs::canonicalize(Value(std::move(o))) + "\n");
}

}  // namespace

fs::path takeAudioPath(const fs::path& bundle, const std::string& takeId) {
    return recordingDir(bundle) / (takeId + ".wav");
}

fs::path takeManifestPath(const fs::path& bundle, const std::string& takeId) {
    return recordingDir(bundle) / (takeId + ".json");
}

TakeManifest readTakeManifest(const fs::path& file) {
    try {
        const Value value = json::parse(io::readFile(file));
        model::detail::FieldReader r(value, "take");
        r.expectSchema(kManifestSchema);
        TakeManifest m;
        m.takeId = r.string("takeId");
        m.trackId = r.string("trackId");
        m.channels = static_cast<int>(r.integer("channels", 1, 64));
        m.sampleRate = r.integer("sampleRate", 1, 768'000);
        m.recordOffset = r.int64String("recordOffset");
        if (r.optional("startPosition") != nullptr) {
            m.startPosition = r.int64String("startPosition");
        }
        r.finish();
        return m;
    } catch (const model::ModelError& error) {
        throw SessionError("invalid_take", std::string("take manifest is invalid: ") + error.what());
    } catch (const json::ParseError& error) {
        throw SessionError("invalid_take", std::string("take manifest is not JSON: ") + error.what());
    }
}

fs::path beginTake(const Session& session, const TakeManifest& manifest) {
    checkTakeId(manifest.takeId);
    const auto& doc = session.history().head().document;
    if (doc.track(manifest.trackId) == nullptr) {
        throw SessionError("invalid_take", "no track with id " + manifest.trackId);
    }
    if (manifest.sampleRate != doc.root().sampleRate) {
        throw SessionError("invalid_take", "a take must be recorded at the session sample rate");
    }
    if (fs::exists(takeManifestPath(session.bundlePath(), manifest.takeId))) {
        throw SessionError("invalid_take", "take " + manifest.takeId + " already exists");
    }
    io::createDirectoriesDurable(recordingDir(session.bundlePath()));
    TakeManifest m = manifest;
    m.startPosition.reset();  // known only once the first frame is captured
    writeManifest(session.bundlePath(), m);
    return takeAudioPath(session.bundlePath(), manifest.takeId);
}

void markTakeStart(const fs::path& bundle, const std::string& takeId, std::int64_t startPosition) {
    TakeManifest m = readTakeManifest(takeManifestPath(bundle, takeId));
    m.startPosition = startPosition;
    writeManifest(bundle, m);
}

std::vector<TakeManifest> pendingTakes(const fs::path& bundle) {
    std::vector<TakeManifest> out;
    const fs::path dir = recordingDir(bundle);
    if (!fs::exists(dir)) {
        return out;
    }
    for (const auto& entry : fs::directory_iterator(dir)) {
        if (entry.path().extension() == ".json") {
            out.push_back(readTakeManifest(entry.path()));
        }
    }
    std::sort(out.begin(), out.end(), [](const TakeManifest& a, const TakeManifest& b) { return a.takeId < b.takeId; });
    return out;
}

const command::Revision& commitTake(Session& session, const std::string& takeId, std::string actor,
                                    std::string time) {
    checkTakeId(takeId);
    const fs::path bundle = session.bundlePath();
    const fs::path manifestFile = takeManifestPath(bundle, takeId);
    if (!fs::exists(manifestFile)) {
        throw SessionError("take_not_found", "no pending take " + takeId);
    }
    const TakeManifest m = readTakeManifest(manifestFile);
    const fs::path audio = takeAudioPath(bundle, takeId);
    if (!m.startPosition || !fs::exists(audio)) {
        throw SessionError("take_has_no_audio", "take " + takeId + " has no recorded audio");
    }
    // Idempotent for a finished file; recovers a file whose writer died.
    const media::RepairResult repaired = media::repairWav(audio);
    if (repaired.frames == 0) {
        throw SessionError("take_has_no_audio", "take " + takeId + " has no complete frames");
    }

    const std::string bytes = io::readFile(audio);
    const hash::Digest contentHash = hash::sha256(bytes);
    const fs::path target = mediaPath(bundle, contentHash);
    const bool moved = !fs::exists(target);
    if (moved) {
        fs::rename(audio, target);  // durable before the journal record (commit order)
        io::flushDirectory(target.parent_path());
        io::flushDirectory(audio.parent_path());
    }

    const std::string mediaId = "med_" + takeId;
    const std::string clipId = "clp_" + takeId;
    const Value mediaAdd(Object{
        {"op", Value(std::string("media.add"))},
        {"mediaId", Value(mediaId)},
        {"contentHash", Value(hash::formatHash(contentHash))},
        {"format", Value(std::string("wav"))},
        {"channels", Value(static_cast<double>(m.channels))},
        {"sampleRate", Value(static_cast<double>(m.sampleRate))},
        {"frames", Value(std::to_string(repaired.frames))},
    });
    const Value clipPlace(Object{
        {"op", Value(std::string("clip.place"))},
        {"clipId", Value(clipId)},
        {"trackId", Value(m.trackId)},
        {"mediaId", Value(mediaId)},
        {"position", Value(Object{{"domain", Value(std::string("audio"))},
                                  {"value", Value(std::to_string(*m.startPosition - m.recordOffset))}})},
        {"sourceStart", Value(std::string("0"))},
        {"length", Value(std::to_string(repaired.frames))},
    });
    try {
        const command::Revision& revision =
            session.commit({command::Command::fromJson(mediaAdd), command::Command::fromJson(clipPlace)},
                           std::move(actor), std::move(time));
        if (!moved) {
            fs::remove(audio);  // identical content was already in media/
        }
        fs::remove(manifestFile);
        return revision;
    } catch (...) {
        if (moved) {
            fs::rename(target, audio);  // the take stays pending and can be retried
        }
        throw;
    }
}

void discardTake(const Session& session, const std::string& takeId) {
    checkTakeId(takeId);
    const fs::path bundle = session.bundlePath();
    const fs::path trash = bundle / "trash";
    io::createDirectoriesDurable(trash);
    for (const fs::path& file : {takeAudioPath(bundle, takeId), takeManifestPath(bundle, takeId)}) {
        if (fs::exists(file)) {
            fs::rename(file, trash / file.filename());
        }
    }
    io::flushDirectory(trash);
}

}  // namespace siann::session
