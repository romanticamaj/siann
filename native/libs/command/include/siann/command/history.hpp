#pragma once

// The revision DAG: one history for undo, journal, plans and proposal
// branches. Every published document is a revision. Undo and redo create new
// revisions whose document equals an earlier one. Rollback of a plan revision
// creates an inverse revision that restores only the plan's entities.
//
// Main is the line head() follows. A proposal branch (architecture spec,
// "Revision DAG — single history", decisions of 2026-11-05) starts at a base
// revision reachable from main's head; its commits are revisions with one
// parent that never move main and never enter main's undo stack. Merging
// creates one branch-merge revision on main with parents {main head, branch
// tip}; discarding closes the branch and leaves its revisions unreachable.

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "siann/command/command.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/model/document.hpp"

namespace siann::command {

enum class Cause { create, command, plan, undo, redo, rollback, branchMerge };

// "create", "command", "plan", "undo", "redo", "rollback", "branch-merge".
std::string_view causeName(Cause cause) noexcept;

// "p1", "p2", ... in creation order.
using BranchId = std::string;

// Envelope data is never part of the document or its hash.
struct RevisionEnvelope {
    std::string id;                    // "r1", "r2", ... in commit order, across main and every branch
    std::vector<std::string> parents;  // empty for the first revision, two for a merge
    hash::Digest documentHash{};
    Cause cause = Cause::create;
    std::string actor;
    std::string time;  // ISO 8601, supplied by the caller
};

struct Revision {
    RevisionEnvelope envelope;
    std::vector<Command> commands;               // command, plan and branch-merge revisions
    std::optional<std::string> target;           // undo, redo, rollback: the revision undone, redone or rolled back
    std::vector<model::DiffEntry> diff;          // against the first parent
    model::Document document;
    // Branch commits: the branch committed on. Merges: the branch merged.
    std::optional<BranchId> branch;
};

// "<type>:<id>"
std::string entityKey(const model::EntityRef& ref);

// The entities a revision changed: its recorded diff against its parent.
std::vector<model::DiffEntry> affectedEntities(const Revision& revision);

// Code rollback_conflict. conflicts() are the entities that changed since the
// plan revision (or that a later revision references), sorted by
// "<type>:<id>" like the document hash leaves.
class RollbackError : public CommandError {
public:
    explicit RollbackError(std::vector<model::EntityRef> conflicts);

    const std::vector<model::EntityRef>& conflicts() const noexcept { return conflicts_; }
    std::vector<std::string> conflictKeys() const;

private:
    std::vector<model::EntityRef> conflicts_;
};

class History {
public:
    History(model::Document initial, std::string actor, std::string time);

    // Main's head.
    const Revision& head() const noexcept { return revisions_[mainHead_]; }
    const Revision* find(std::string_view id) const noexcept;
    // Every revision in commit order, branch revisions included.
    const std::vector<Revision>& revisions() const noexcept { return revisions_; }

    // Applies commands as one revision on main (cause command for one, plan
    // for a transaction marked as a plan). Clears the redo stack.
    const Revision& commit(std::vector<Command> commands, std::string actor, std::string time,
                           Cause cause = Cause::command);

    // Called with each new revision before it is published. If the hook
    // throws, the revision is discarded and the history is unchanged. The
    // session layer uses it to make the journal record durable first.
    using BeforePublish = std::function<void(const Revision&)>;
    void setBeforePublish(BeforePublish hook) { beforePublish_ = std::move(hook); }

    bool canUndo() const noexcept { return !undoStack_.empty(); }
    bool canRedo() const noexcept { return !redoStack_.empty(); }
    const Revision& undo(std::string actor, std::string time);
    const Revision& redo(std::string actor, std::string time);

    // Rolls back a plan revision (architecture spec, "Revision DAG — single
    // history"). Every entity in the plan revision's diff must be unchanged at
    // the head (an added entity still present with the same hash, a removed
    // one still absent); the new revision is the head document with those
    // entities restored to the plan revision's parent, cause rollback, target
    // the plan revision. It is undoable like a commit and clears redo. Only
    // the document changes: no file is touched. Root is shared session state
    // and is compared and restored field by field: the plan owns the root
    // fields it changed (name, sample rate, tempo, and the whole track order
    // only if it reordered existing tracks) and the order slots of the tracks
    // it added or removed. Later unrelated root edits (another track added or
    // removed, a rename, a tempo change) are kept and are not a conflict; a
    // plan-removed track goes back right after its nearest earlier neighbour
    // still present, or first. Errors: not_found, not_a_plan, rollback_conflict
    // (RollbackError, nothing appended), or a validation code of the inverse
    // document.
    const Revision& rollback(std::string_view planRevisionId, std::string actor, std::string time);

    // Opens a proposal branch at baseId, which must be reachable from main's
    // head (not_found for an unknown revision, invalid_params otherwise).
    BranchId branch(std::string_view baseId);
    // Commits onto an open branch (not_found otherwise); cause command or plan.
    const Revision& commitOn(const BranchId& branchId, std::vector<Command> commands, std::string actor,
                             std::string time, Cause cause = Cause::command);
    // Merges an open branch into main (see the header comment). Throws
    // not_found, empty_transaction (no commits on the branch) or
    // branch_conflict listing the entities ("<type>:<id>") main changed since
    // the base that the branch also wrote; nothing changes then.
    const Revision& merge(const BranchId& branchId, std::string actor, std::string time);
    // Closes an open branch; its revisions stay. Throws not_found.
    void discard(const BranchId& branchId);
    // Open branches in creation order.
    std::vector<BranchId> branches() const;
    // The branch's newest revision (its base before its first commit). Throws not_found.
    const Revision& branchHead(const BranchId& branchId) const;
    // True when the revision is main's head or an ancestor of it through any parent.
    bool reachable(std::string_view id) const;

    // Replay (siann-session): a branch commit recorded with its branch and
    // parent, and a merge recorded with its parents and commands. Neither
    // opens a branch; later branch ids continue after the highest replayed one.
    const Revision& commitOnParent(const BranchId& branchId, std::string_view parentId, std::vector<Command> commands,
                                   std::string actor, std::string time, Cause cause);
    const Revision& mergeReplay(const std::vector<std::string>& parents, std::vector<Command> commands,
                                std::string actor, std::string time, std::optional<BranchId> branchId);

private:
    struct OpenBranch {
        BranchId id;
        std::size_t base = 0;
        std::size_t tip = 0;
        std::vector<std::size_t> commits;
    };

    const Revision& append(Revision revision, std::vector<std::size_t> parents);
    std::size_t indexOf(std::string_view id) const;
    OpenBranch& requireBranch(const BranchId& branchId);
    const OpenBranch& requireBranch(const BranchId& branchId) const;
    const Revision& appendBranchCommit(std::size_t parent, const BranchId& branchId, std::vector<Command> commands,
                                       std::string actor, std::string time, Cause cause);
    const Revision& appendMerge(std::size_t branchTip, std::vector<Command> commands, model::Document merged,
                                std::string actor, std::string time, std::optional<BranchId> branchId);
    void noteBranchId(const BranchId& branchId);

    std::vector<Revision> revisions_;
    std::size_t mainHead_ = 0;
    std::vector<std::size_t> undoStack_;  // indexes of command, plan, rollback and merge revisions on main
    std::vector<std::size_t> redoStack_;
    std::vector<OpenBranch> branches_;
    std::uint64_t nextBranch_ = 1;
    BeforePublish beforePublish_;
};

}  // namespace siann::command
