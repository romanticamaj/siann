#pragma once

// Recorded takes (architecture spec, "Recording"). A take lives in
// media/recording/ as <takeId>.wav plus <takeId>.json until it is committed:
//
//   beginTake       writes the manifest durably before recording starts
//   markTakeStart   records the timeline position of the first frame, before
//                   the first audio is written (Recorder's onStart)
//   commitTake      repairs the file, moves it into content-addressed media
//                   and commits media.add + clip.place as one revision; after a
//                   crash the same call recovers a pending take
//   discardTake     moves the files to trash/; takes are never deleted
//
// The clip is placed at startPosition - recordOffset (spec, "Latency model").

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
};

std::filesystem::path takeAudioPath(const std::filesystem::path& bundle, const std::string& takeId);
std::filesystem::path takeManifestPath(const std::filesystem::path& bundle, const std::string& takeId);

TakeManifest readTakeManifest(const std::filesystem::path& file);

// Validates the take against the session (track exists, rate matches) and
// writes its manifest. Returns the WAV path the recorder should write.
std::filesystem::path beginTake(const Session& session, const TakeManifest& manifest);

// Safe from any thread: touches only the take's manifest file.
void markTakeStart(const std::filesystem::path& bundle, const std::string& takeId, std::int64_t startPosition);

// Takes in media/recording that were never committed or discarded.
std::vector<TakeManifest> pendingTakes(const std::filesystem::path& bundle);

// Throws SessionError: take_not_found, take_has_no_audio.
const command::Revision& commitTake(Session& session, const std::string& takeId, std::string actor,
                                    std::string time);

void discardTake(const Session& session, const std::string& takeId);

}  // namespace siann::session
