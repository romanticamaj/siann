#pragma once

// media.import job (architecture spec, "Commands and jobs"). The job makes its
// output durable first, then submits the pure command media.add with the
// content hash; replay never re-runs the job.
//
// A WAV or FLAC file already at the session rate is stored byte for byte. Any
// other rate is converted offline and stored as 32-bit float WAV, and the
// source file's hash is kept as originalHash. Files live at
// media/<sha256 hex>.wav or .flac.

#include <filesystem>
#include <string>

#include "siann/command/history.hpp"
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

}  // namespace siann::session
