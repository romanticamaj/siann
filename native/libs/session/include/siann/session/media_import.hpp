#pragma once

// media.import job (architecture spec, "Commands and jobs", Jobs v0, import). The
// job makes its output durable first, then submits the pure command media.add
// with the content hash; replay never re-runs the job.
//
// A WAV or FLAC file already at the session rate is stored byte for byte. Any
// other rate is converted offline and stored as 32-bit float WAV, and the
// source file's hash is kept as originalHash. Files live at
// media/<sha256 hex>.wav or .flac, their peak pyramids at peaks/<hex>.peaks.
//
// Two phases (m5b-engine-project-media): prepareImport runs on the jobs worker
// and never touches the Session (decode, chunked conversion with a cancel flag
// and progress counters, media and peaks written atomically, the files it
// created recorded); commitImport runs on the command thread and commits
// media.add. discardImport removes only the files the job created, never one
// the bundle held before.

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "siann/command/history.hpp"
#include "siann/media/audio.hpp"
#include "siann/media/audio_source.hpp"
#include "siann/session/session.hpp"

namespace siann::session {

struct ImportResult {
    const command::Revision* revision = nullptr;
    std::filesystem::path storedFile;
    bool converted = false;
};

// Throws media::MediaError for unreadable or unsupported files, io::IoError
// for file system failures and command::CommandError if media.add is rejected
// (the stored file then stays, content-addressed and unreferenced).
ImportResult importMedia(Session& session, const std::filesystem::path& source, const std::string& mediaId,
                         std::string actor, std::string time);

// Path of a media file inside a bundle.
std::filesystem::path mediaPath(const std::filesystem::path& bundle, const hash::Digest& contentHash,
                                model::MediaFormat format = model::MediaFormat::wav);

// What an import reads: the original file's bytes (hashed, and stored as they are
// at the session rate) and a decoder over them, or a test's paced decoder.
struct ImportSource {
    std::string name;  // the media name: the file's base name (mediaNameFromPath)
    model::MediaFormat format = model::MediaFormat::wav;
    hash::Digest originalHash{};
    std::string original;
    std::unique_ptr<media::AudioSource> audio;
};

// Reads the file and opens its decoder. Throws media::MediaError not_found (no
// file), unsupported_media or decode_failed (the header).
ImportSource openImportSource(const std::filesystem::path& file);

// The file's base name as UTF-8, cut at a code point boundary to at most
// model::kMaxMediaNameBytes bytes ("audio" for a path without a name).
std::string mediaNameFromPath(const std::filesystem::path& file);

// Shared between the worker and whoever watches or cancels the job.
struct ImportProgress {
    std::atomic<bool> cancel{false};
    std::atomic<std::int64_t> framesDone{0};   // source frames read
    std::atomic<std::int64_t> framesTotal{0};  // source frames in all
};

struct PreparedImport {
    std::filesystem::path bundle;
    std::string name;
    hash::Digest contentHash{};
    std::optional<hash::Digest> originalHash;  // set when converted
    model::MediaFormat format = model::MediaFormat::wav;
    media::AudioInfo info;  // of the stored file
    std::filesystem::path mediaFile;
    std::filesystem::path peaksFile;
    // The files this job wrote (absent before it); discardImport removes these only.
    std::vector<std::filesystem::path> created;
};

// Worker thread. Decodes (and converts to sessionRate) the source, writes the
// media file and its peak pyramid atomically unless they exist. Throws
// media::MediaError (cancelled when progress->cancel was set, checked between
// blocks; nothing it wrote is left then) or io::IoError.
PreparedImport prepareImport(const std::filesystem::path& bundle, std::int64_t sessionRate, ImportSource& source,
                             ImportProgress* progress = nullptr);

// Command thread: commits media.add {mediaId, contentHash, originalHash?, format,
// channels, sampleRate, frames, name} as one revision.
const command::Revision& commitImport(Session& session, const PreparedImport& prepared, const std::string& mediaId,
                                      std::string actor, std::string time);

// Removes the files the job created. Never throws.
void discardImport(const PreparedImport& prepared) noexcept;

}  // namespace siann::session
