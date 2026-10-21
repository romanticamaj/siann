#include "siann/command/history.hpp"

#include <utility>

namespace siann::command {

std::string_view causeName(Cause cause) noexcept {
    switch (cause) {
        case Cause::create: return "create";
        case Cause::command: return "command";
        case Cause::plan: return "plan";
        case Cause::undo: return "undo";
        case Cause::redo: return "redo";
    }
    return "unknown";
}

History::History(model::Document initial, std::string actor, std::string time) {
    RevisionEnvelope envelope;
    envelope.cause = Cause::create;
    envelope.actor = std::move(actor);
    envelope.time = std::move(time);
    append(Revision{std::move(envelope), {}, std::nullopt, {}, std::move(initial)});
}

const Revision* History::find(std::string_view id) const noexcept {
    for (const Revision& revision : revisions_) {
        if (revision.envelope.id == id) {
            return &revision;
        }
    }
    return nullptr;
}

std::size_t History::indexOf(std::string_view id) const {
    for (std::size_t i = 0; i < revisions_.size(); ++i) {
        if (revisions_[i].envelope.id == id) {
            return i;
        }
    }
    throw CommandError("not_found", "no revision with id " + std::string(id));
}

const Revision& History::append(Revision revision) {
    revision.envelope.id = "r" + std::to_string(revisions_.size() + 1);
    if (!revisions_.empty()) {
        revision.envelope.parents = {revisions_.back().envelope.id};
        revision.diff = model::diff(revisions_.back().document, revision.document);
    }
    revision.envelope.documentHash = revision.document.documentHash();
    revisions_.push_back(std::move(revision));
    return revisions_.back();
}

const Revision& History::commit(std::vector<Command> commands, std::string actor, std::string time, Cause cause) {
    if (cause != Cause::command && cause != Cause::plan) {
        throw CommandError("invalid_params", "commit cause must be command or plan");
    }
    Prepared prepared = prepareTransaction(head().document, commands);
    RevisionEnvelope envelope;
    envelope.cause = cause;
    envelope.actor = std::move(actor);
    envelope.time = std::move(time);
    const Revision& revision =
        append(Revision{std::move(envelope), std::move(commands), std::nullopt, {}, std::move(prepared.result)});
    undoStack_.push_back(revisions_.size() - 1);
    redoStack_.clear();
    return revision;
}

const Revision& History::undo(std::string actor, std::string time) {
    if (undoStack_.empty()) {
        throw CommandError("nothing_to_undo", "there is nothing to undo");
    }
    const std::size_t target = undoStack_.back();
    const std::size_t parent = indexOf(revisions_[target].envelope.parents.front());
    model::Document restored = revisions_[parent].document;
    const std::string targetId = revisions_[target].envelope.id;

    RevisionEnvelope envelope;
    envelope.cause = Cause::undo;
    envelope.actor = std::move(actor);
    envelope.time = std::move(time);
    const Revision& revision = append(Revision{std::move(envelope), {}, targetId, {}, std::move(restored)});
    undoStack_.pop_back();
    redoStack_.push_back(target);
    return revision;
}

const Revision& History::redo(std::string actor, std::string time) {
    if (redoStack_.empty()) {
        throw CommandError("nothing_to_redo", "there is nothing to redo");
    }
    const std::size_t target = redoStack_.back();
    model::Document restored = revisions_[target].document;
    const std::string targetId = revisions_[target].envelope.id;

    RevisionEnvelope envelope;
    envelope.cause = Cause::redo;
    envelope.actor = std::move(actor);
    envelope.time = std::move(time);
    const Revision& revision = append(Revision{std::move(envelope), {}, targetId, {}, std::move(restored)});
    redoStack_.pop_back();
    undoStack_.push_back(target);
    return revision;
}

}  // namespace siann::command
