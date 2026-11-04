#pragma once

// The revision DAG: one history for undo, journal, plans and (later) proposal
// branches. Every published document is a revision. Undo and redo create new
// revisions whose document equals an earlier one. Rollback of a plan revision
// creates an inverse revision that restores only the plan's entities.

#include <cstdint>
#include <functional>
#include <optional>
#include <string_view>
#include <string>
#include <vector>

#include "siann/command/command.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/model/document.hpp"

namespace siann::command {

enum class Cause { create, command, plan, undo, redo, rollback };

std::string_view causeName(Cause cause) noexcept;

// Envelope data is never part of the document or its hash.
struct RevisionEnvelope {
    std::string id;                    // "r1", "r2", ... in commit order
    std::vector<std::string> parents;  // empty for the first revision
    hash::Digest documentHash{};
    Cause cause = Cause::create;
    std::string actor;
    std::string time;  // ISO 8601, supplied by the caller
};

struct Revision {
    RevisionEnvelope envelope;
    std::vector<Command> commands;               // command and plan revisions
    std::optional<std::string> target;           // undo, redo, rollback: the revision undone, redone or rolled back
    std::vector<model::DiffEntry> diff;          // against the parent revision
    model::Document document;
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

    const Revision& head() const noexcept { return revisions_.back(); }
    const Revision* find(std::string_view id) const noexcept;
    const std::vector<Revision>& revisions() const noexcept { return revisions_; }

    // Applies commands as one revision (cause command for one, plan for a
    // transaction marked as a plan). Clears the redo stack.
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

private:
    const Revision& append(Revision revision);
    std::size_t indexOf(std::string_view id) const;

    std::vector<Revision> revisions_;
    std::vector<std::size_t> undoStack_;  // indexes of command and plan revisions
    std::vector<std::size_t> redoStack_;
    BeforePublish beforePublish_;
};

}  // namespace siann::command
