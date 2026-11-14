#include "siann/session/takes.hpp"

#include <algorithm>
#include <set>

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

fs::path trashDir(const fs::path& bundle) {
    return bundle / "trash";
}

void checkTakeId(const std::string& takeId) {
    if (!hash::isValidEntityId(takeId) || takeId.size() > 60) {
        throw SessionError("invalid_take", "take IDs follow entity ID rules and have at most 60 characters");
    }
}

std::string mediaIdOf(const std::string& takeId) {
    return "med_" + takeId;
}

std::string clipIdOf(const std::string& takeId) {
    return "clp_" + takeId;
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
    if (m.endedBy) {
        o.emplace_back("endedBy", Value(*m.endedBy));
    }
    if (m.overflows) {
        o.emplace_back("overflows", Value(std::to_string(*m.overflows)));
    }
    io::writeFileAtomic(takeManifestPath(bundle, m.takeId), jcs::canonicalize(Value(std::move(o))) + "\n");
}

// The revision that committed a take: the first to hold its media entity.
const command::Revision* committedBy(const Session& session, const std::string& takeId) {
    const std::string mediaId = mediaIdOf(takeId);
    for (const command::Revision& revision : session.history().revisions()) {
        if (revision.document.media(mediaId) != nullptr) {
            return &revision;
        }
    }
    return nullptr;
}

// A take's files moved into content-addressed media, ready to commit.
struct Staged {
    std::string takeId;
    fs::path manifest;
    fs::path audio;
    fs::path target;
    bool moved = false;
};

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
        if (r.optional("endedBy") != nullptr) {
            m.endedBy = r.string("endedBy");
        }
        if (r.optional("overflows") != nullptr) {
            const std::int64_t overflows = r.int64String("overflows");
            if (overflows < 0) {
                r.fail("overflows", "must not be negative");
            }
            m.overflows = static_cast<std::uint64_t>(overflows);
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
    m.endedBy.reset();
    m.overflows.reset();
    writeManifest(session.bundlePath(), m);
    return takeAudioPath(session.bundlePath(), manifest.takeId);
}

void markTakeStart(const fs::path& bundle, const std::string& takeId, std::int64_t startPosition) {
    TakeManifest m = readTakeManifest(takeManifestPath(bundle, takeId));
    m.startPosition = startPosition;
    writeManifest(bundle, m);
}

void markTakeEnd(const fs::path& bundle, const std::string& takeId, const std::string& endedBy,
                 std::uint64_t overflows) {
    TakeManifest m = readTakeManifest(takeManifestPath(bundle, takeId));
    m.endedBy = endedBy;
    m.overflows = overflows;
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

namespace {

const command::Revision& commitPlaced(Session& session, const std::vector<std::string>& takeIds,
                                      const TakePlacement& placement, std::string actor, std::string time) {
    if (takeIds.empty()) {
        throw SessionError("invalid_take", "a recording commits at least one take");
    }
    if (std::set<std::string>(takeIds.begin(), takeIds.end()).size() != takeIds.size()) {
        throw SessionError("invalid_take", "a take is named twice");
    }
    const fs::path bundle = session.bundlePath();
    // Everything is checked before the first file moves.
    std::vector<TakeManifest> manifests;
    for (const std::string& takeId : takeIds) {
        checkTakeId(takeId);
        const fs::path manifestFile = takeManifestPath(bundle, takeId);
        if (!fs::exists(manifestFile)) {
            throw SessionError("take_not_found", "no pending take " + takeId);
        }
        TakeManifest m = readTakeManifest(manifestFile);
        if (!m.startPosition || !fs::exists(takeAudioPath(bundle, takeId))) {
            throw SessionError("take_has_no_audio", "take " + takeId + " has no recorded audio");
        }
        manifests.push_back(std::move(m));
    }

    if (placement.trackId && placement.newTrack) {
        throw SessionError("invalid_take", "a take goes on a named track or on a new one, not both");
    }
    if (placement.trackId && session.history().head().document.track(*placement.trackId) == nullptr) {
        throw SessionError("not_found", "no track with id " + *placement.trackId);
    }

    std::vector<Staged> staged;
    std::vector<command::Command> commands;
    const auto moveBack = [&staged] {
        for (auto it = staged.rbegin(); it != staged.rend(); ++it) {
            if (it->moved) {
                std::error_code ec;
                fs::rename(it->target, it->audio, ec);  // the take stays pending and can be retried
            }
        }
    };
    try {
        for (const TakeManifest& m : manifests) {
            Staged one{m.takeId, takeManifestPath(bundle, m.takeId), takeAudioPath(bundle, m.takeId), {}, false};
            // Idempotent for a finished file; recovers a file whose writer died.
            const media::RepairResult repaired = media::repairWav(one.audio);
            if (repaired.frames == 0) {
                throw SessionError("take_has_no_audio", "take " + m.takeId + " has no complete frames");
            }
            const hash::Digest contentHash = hash::sha256(io::readFile(one.audio));
            one.target = mediaPath(bundle, contentHash);
            one.moved = !fs::exists(one.target);
            if (one.moved) {
                fs::rename(one.audio, one.target);  // durable before the journal record (commit order)
            }
            staged.push_back(one);
            std::string trackId = placement.trackId.value_or(m.trackId);
            if (placement.newTrack) {
                trackId = "trk_" + m.takeId;
                commands.push_back(command::Command::fromJson(Value(Object{
                    {"op", Value(std::string("track.add"))},
                    {"trackId", Value(trackId)},
                    {"name", Value(m.takeId)},
                    {"channels", Value(static_cast<double>(m.channels))},
                })));
            }
            commands.push_back(command::Command::fromJson(Value(Object{
                {"op", Value(std::string("media.add"))},
                {"mediaId", Value(mediaIdOf(m.takeId))},
                {"contentHash", Value(hash::formatHash(contentHash))},
                {"format", Value(std::string("wav"))},
                {"channels", Value(static_cast<double>(m.channels))},
                {"sampleRate", Value(static_cast<double>(m.sampleRate))},
                {"frames", Value(std::to_string(repaired.frames))},
            })));
            commands.push_back(command::Command::fromJson(Value(Object{
                {"op", Value(std::string("clip.place"))},
                {"clipId", Value(clipIdOf(m.takeId))},
                {"trackId", Value(trackId)},
                {"mediaId", Value(mediaIdOf(m.takeId))},
                {"position", Value(Object{{"domain", Value(std::string("audio"))},
                                          {"value", Value(std::to_string(*m.startPosition - m.recordOffset))}})},
                {"sourceStart", Value(std::string("0"))},
                {"length", Value(std::to_string(repaired.frames))},
            })));
        }
        io::flushDirectory(bundle / "media");
        io::flushDirectory(recordingDir(bundle));
        const command::Revision& revision = session.commit(std::move(commands), std::move(actor), std::move(time));
        for (const Staged& one : staged) {
            std::error_code ec;
            if (!one.moved) {
                fs::remove(one.audio, ec);  // identical content was already in media/
            }
            fs::remove(one.manifest, ec);
        }
        return revision;
    } catch (...) {
        moveBack();
        throw;
    }
}

}  // namespace

const command::Revision& commitTakes(Session& session, const std::vector<std::string>& takeIds, std::string actor,
                                     std::string time) {
    return commitPlaced(session, takeIds, {}, std::move(actor), std::move(time));
}

const command::Revision& commitTake(Session& session, const std::string& takeId, std::string actor,
                                    std::string time, const TakePlacement& placement) {
    checkTakeId(takeId);
    if (!fs::exists(takeManifestPath(session.bundlePath(), takeId))) {
        // Committed already: the same answer, nothing committed again.
        if (const command::Revision* revision = committedBy(session, takeId)) {
            return *revision;
        }
        throw SessionError("take_not_found", "no pending take " + takeId);
    }
    return commitPlaced(session, {takeId}, placement, std::move(actor), std::move(time));
}

void discardTake(const Session& session, const std::string& takeId) {
    checkTakeId(takeId);
    const fs::path bundle = session.bundlePath();
    const fs::path trash = trashDir(bundle);
    const fs::path manifest = takeManifestPath(bundle, takeId);
    const fs::path audio = takeAudioPath(bundle, takeId);
    if (!fs::exists(manifest) && !fs::exists(audio)) {
        if (fs::exists(trash / manifest.filename()) || fs::exists(trash / audio.filename())) {
            return;  // discarded already
        }
        throw SessionError("take_not_found", "no pending take " + takeId);
    }
    io::createDirectoriesDurable(trash);
    for (const fs::path& file : {audio, manifest}) {
        if (fs::exists(file)) {
            fs::rename(file, trash / file.filename());
        }
    }
    io::flushDirectory(trash);
}

}  // namespace siann::session
