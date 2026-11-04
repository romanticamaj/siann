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
// checked against the replayed revision its head names. A damaged journal tail is
// moved aside, never discarded.

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "siann/command/history.hpp"
#include "siann/command/plan.hpp"
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
    // Recorded takes never committed or discarded (see takes.hpp).
    std::vector<std::string> pendingTakes;
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
    // Rolls back a plan revision (History::rollback); journaled like a commit.
    // Only the document changes: media, blobs and renders stay in the bundle.
    const command::Revision& rollback(std::string_view planRevisionId, std::string actor, std::string time);

    // Writes session.json for the current head.
    void checkpoint();

    // Proposal branches (command/history.hpp). Every branch commit and merge
    // is one journal record, durable before it is published. Opening and
    // discarding a branch are not revisions and are not journaled, so a
    // reopened session has no open branch; its branch revisions are replayed
    // and stay findable (unreachable unless merged).
    command::BranchId branch(std::string_view baseId);
    const command::Revision& commitOn(const command::BranchId& branchId, std::vector<command::Command> commands,
                                      std::string actor, std::string time,
                                      command::Cause cause = command::Cause::command);
    const command::Revision& merge(const command::BranchId& branchId, std::string actor, std::string time);
    void discard(const command::BranchId& branchId);

    // Plans against this session's history (command/plan.hpp). Plans are
    // in-memory engine state in M3: they are not written to the bundle and a
    // reopened session starts with an empty store. applyPlan commits through
    // commit(), so the plan revision is journaled before it is published.
    const command::PlanStore& plans() const noexcept;
    const command::Plan& submitPlan(std::vector<command::Command> steps, std::vector<model::EntityRef> readSet,
                                    const std::string& baseRevision);
    const command::Plan& approvePlan(std::string_view planHashText, std::string approvedBy, std::string time);
    const command::Plan& approvePlanPartial(std::string_view planHashText, const std::vector<std::size_t>& stepIndexes,
                                            std::string approvedBy, std::string time);
    const command::Plan& rejectPlan(std::string_view planHashText, std::string rejectedBy, std::string time,
                                    std::string note);
    const command::Revision& applyPlan(std::string_view planHashText, std::string actor, std::string time);
    // Rolls back an applied plan through rollback(), so the inverse revision
    // is journaled before it is published (PlanStore::rollback).
    const command::Revision& rollbackPlan(std::string_view planHashText, std::string actor, std::string time);

private:
    struct State;
    explicit Session(std::unique_ptr<State> state);
    std::unique_ptr<State> state_;
};

}  // namespace siann::session
