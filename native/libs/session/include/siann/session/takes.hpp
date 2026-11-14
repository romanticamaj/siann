#pragma once

// Recorded takes (architecture spec, "Recording"). A take lives in
// media/recording/ as <takeId>.wav plus <takeId>.json until it is committed:
//
//   beginTake       writes the manifest durably before recording starts
//   markTakeStart   records the timeline position of the first frame, before
//                   the first audio is written (Recorder's onStart)
//   markTakeEnd     records why the take ended (endedBy) and its overflows
//   commitTakes     repairs every file of one recording, moves them into
//                   content-addressed media and commits a media.add and a
//                   clip.place per take as ONE revision; if the commit fails,
//                   every file moves back and every take stays pending
//   commitTake      the same for one take; after a crash it recovers a pending
//                   take, and a repeat answers the revision that committed it
//   discardTake     moves the files to trash/; takes are never deleted, and a
//                   repeat finds nothing left to move
//
// The clip is placed at startPosition - recordOffset (spec, "Latency model").
// A committed take's media id is med_<takeId> and its clip id clp_<takeId>.

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "siann/command/history.hpp"
#include "siann/session/session.hpp"

namespace siann::session {

struct TakeManifest {
    std::string takeId;   // entity ID rules, at most 60 characters
    std::string trackId;
    int channels = 1;
    std::int64_t sampleRate = 48'000;
    std::int64_t recordOffset = 0;              // samples
    std::optional<std::int64_t> startPosition;  // timeline sample of the first frame
    // m5b-engine-record, optional: why the take ended ("stop", "overflow",
    // "disk" or "device") and the blocks an overflow lost. A manifest written
    // before has neither.
    std::optional<std::string> endedBy;
    std::optional<std::uint64_t> overflows;
};

std::filesystem::path takeAudioPath(const std::filesystem::path& bundle, const std::string& takeId);
std::filesystem::path takeManifestPath(const std::filesystem::path& bundle, const std::string& takeId);

TakeManifest readTakeManifest(const std::filesystem::path& file);

// Validates the take against the session (track exists, rate matches) and
// writes its manifest. Returns the WAV path the recorder should write.
std::filesystem::path beginTake(const Session& session, const TakeManifest& manifest);

// Safe from any thread: touches only the take's manifest file.
void markTakeStart(const std::filesystem::path& bundle, const std::string& takeId, std::int64_t startPosition);

// Safe from any thread: touches only the take's manifest file.
void markTakeEnd(const std::filesystem::path& bundle, const std::string& takeId, const std::string& endedBy,
                 std::uint64_t overflows);

// Takes in media/recording that were never committed or discarded.
std::vector<TakeManifest> pendingTakes(const std::filesystem::path& bundle);

// One revision for every take of a recording. Throws SessionError:
// invalid_take (no take, or one named twice), take_not_found,
// take_has_no_audio; and whatever the commit throws, after moving every file back.
const command::Revision& commitTakes(Session& session, const std::vector<std::string>& takeIds, std::string actor,
                                     std::string time);

// Throws SessionError: take_not_found (also for a take that was discarded),
// take_has_no_audio. A take already committed answers the revision that
// committed it and commits nothing.
const command::Revision& commitTake(Session& session, const std::string& takeId, std::string actor,
                                    std::string time);

// Throws SessionError take_not_found for a take that is neither pending nor in
// trash/; a take already in trash/ is left as it is.
void discardTake(const Session& session, const std::string& takeId);

}  // namespace siann::session
