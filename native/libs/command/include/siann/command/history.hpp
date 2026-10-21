#pragma once

// The revision DAG: one history for undo, journal, plans and (later) proposal
// branches. Every published document is a revision. Undo and redo create new
// revisions whose document equals an earlier one.

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "siann/command/command.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/model/document.hpp"

namespace siann::command {

enum class Cause { create, command, plan, undo, redo };

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
    std::optional<std::string> target;           // undo and redo: the revision undone or redone
    std::vector<model::DiffEntry> diff;          // against the parent revision
    model::Document document;
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

    bool canUndo() const noexcept { return !undoStack_.empty(); }
    bool canRedo() const noexcept { return !redoStack_.empty(); }
    const Revision& undo(std::string actor, std::string time);
    const Revision& redo(std::string actor, std::string time);

private:
    const Revision& append(Revision revision);
    std::size_t indexOf(std::string_view id) const;

    std::vector<Revision> revisions_;
    std::vector<std::size_t> undoStack_;  // indexes of command and plan revisions
    std::vector<std::size_t> redoStack_;
};

}  // namespace siann::command
