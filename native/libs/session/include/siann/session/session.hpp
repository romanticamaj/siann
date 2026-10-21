#pragma once

// A session bundle on disk (architecture spec, "Session bundle"):
//
//   MySong.siann/
//     session.json      latest checkpoint (siann.checkpoint.v1)
//     journal.ndjson    every revision, append-only (never truncated in M1)
//     media/  blobs/    content-addressed files (written before their records)
//
// Every revision is made durable in the journal before it is published. On
// open, the whole journal is replayed (M1 keeps all history), every replayed
// revision is checked against its recorded envelope, and the checkpoint is
// checked against the replayed revision it covers. A damaged journal tail is
// moved aside, never discarded.

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "siann/command/history.hpp"
#include "siann/model/document.hpp"
#include "siann/session/journal.hpp"

namespace siann::session {

struct OpenReport {
    std::int64_t recordsReplayed = 0;
    bool checkpointVerified = false;
    // Set when a damaged journal tail was moved aside.
    std::optional<std::filesystem::path> quarantinedTail;
    std::optional<std::string> tailError;
    // Temporary files left by an interrupted atomic write, now removed.
    std::vector<std::filesystem::path> removedTempFiles;
};

class Session {
public:
    // Revisions between automatic checkpoints.
    static constexpr std::int64_t kCheckpointInterval = 50;

    // Creates a new bundle; the directory must not exist or must be empty.
    static Session create(const std::filesystem::path& bundle, model::Document initial, std::string actor,
                          std::string time);

    static Session open(const std::filesystem::path& bundle, OpenReport* report = nullptr);

    Session(Session&&) noexcept;
    Session& operator=(Session&&) noexcept;
    ~Session();

    const std::filesystem::path& bundlePath() const noexcept;
    const command::History& history() const noexcept;
    std::int64_t lastSeq() const noexcept;

    const command::Revision& commit(std::vector<command::Command> commands, std::string actor, std::string time,
                                    command::Cause cause = command::Cause::command);
    const command::Revision& undo(std::string actor, std::string time);
    const command::Revision& redo(std::string actor, std::string time);

    // Writes session.json for the current head.
    void checkpoint();

private:
    struct State;
    explicit Session(std::unique_ptr<State> state);
    std::unique_ptr<State> state_;
};

}  // namespace siann::session
