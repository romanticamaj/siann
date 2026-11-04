#include "siann/command/history.hpp"

#include <algorithm>
#include <utility>

namespace siann::command {

using model::DiffEntry;
using model::EntityRef;
using model::EntityType;

namespace {

// Sorted by "<type>:<id>", the order of the document hash leaves, unique.
std::vector<EntityRef> sortedByKey(std::vector<EntityRef> refs) {
    std::sort(refs.begin(), refs.end(),
              [](const EntityRef& a, const EntityRef& b) { return entityKey(a) < entityKey(b); });
    refs.erase(std::unique(refs.begin(), refs.end()), refs.end());
    return refs;
}

std::string conflictMessage(const std::vector<EntityRef>& entities) {
    std::string message = "the plan's entities changed since it was applied:";
    for (const EntityRef& ref : sortedByKey(entities)) {
        message += " " + entityKey(ref);
    }
    return message;
}

// The document with one entity set to its state in source (removed when
// source lacks it).
model::Document restoreEntity(const model::Document& document, const model::Document& source,
                              const EntityRef& ref) {
    switch (ref.type) {
        case EntityType::root:
            return document.withRoot(source.root());
        case EntityType::media:
            if (const model::Media* media = source.media(ref.id)) {
                return document.withMedia(*media);
            }
            return document.withoutMedia(ref.id);
        case EntityType::track:
            if (const model::Track* track = source.track(ref.id)) {
                return document.withTrack(*track);
            }
            return document.withoutTrack(ref.id);
        case EntityType::clip:
            if (const model::Clip* clip = source.clip(ref.id)) {
                return document.withClip(*clip);
            }
            return document.withoutClip(ref.id);
    }
    return document;
}

}  // namespace

std::string entityKey(const EntityRef& ref) {
    return std::string(model::entityTypeName(ref.type)) + ":" + ref.id;
}

std::vector<DiffEntry> affectedEntities(const Revision& revision) {
    return revision.diff;
}

RollbackError::RollbackError(std::vector<EntityRef> entities)
    : CommandError("rollback_conflict", conflictMessage(entities)), conflicts_(sortedByKey(std::move(entities))) {}

std::vector<std::string> RollbackError::conflictKeys() const {
    std::vector<std::string> keys;
    keys.reserve(conflicts_.size());
    for (const EntityRef& ref : conflicts_) {
        keys.push_back(entityKey(ref));
    }
    return keys;
}

std::string_view causeName(Cause cause) noexcept {
    switch (cause) {
        case Cause::create: return "create";
        case Cause::command: return "command";
        case Cause::plan: return "plan";
        case Cause::undo: return "undo";
        case Cause::redo: return "redo";
        case Cause::rollback: return "rollback";
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
    if (beforePublish_) {
        beforePublish_(revision);
    }
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

const Revision& History::rollback(std::string_view planRevisionId, std::string actor, std::string time) {
    const Revision& plan = revisions_[indexOf(planRevisionId)];
    if (plan.envelope.cause != Cause::plan) {
        throw CommandError("not_a_plan", "revision " + plan.envelope.id + " has cause " +
                                             std::string(causeName(plan.envelope.cause)) +
                                             "; only plan revisions can be rolled back");
    }
    const model::Document& before = revisions_[indexOf(plan.envelope.parents.front())].document;
    const model::Document& current = head().document;

    // Every affected entity must be as the plan left it.
    std::vector<EntityRef> conflicts;
    for (const DiffEntry& entry : affectedEntities(plan)) {
        if (plan.document.findEntityHash(entry.entity) != current.findEntityHash(entry.entity)) {
            conflicts.push_back(entry.entity);
        }
    }
    if (!conflicts.empty()) {
        throw RollbackError(std::move(conflicts));
    }

    model::Document inverse = current;
    for (const DiffEntry& entry : affectedEntities(plan)) {
        inverse = restoreEntity(inverse, before, entry.entity);
    }
    // A later revision may reference an entity the plan added (a clip on a
    // plan-added track or media): that entity is the conflict.
    for (const model::ValidationIssue& issue : inverse.validate()) {
        const model::Clip* clip = issue.entity.type == EntityType::clip ? inverse.clip(issue.entity.id) : nullptr;
        if (issue.code == "unknown_track" && clip != nullptr) {
            conflicts.push_back(EntityRef{EntityType::track, clip->trackId});
        } else if (issue.code == "unknown_media" && clip != nullptr) {
            conflicts.push_back(EntityRef{EntityType::media, clip->mediaId});
        } else {
            throw CommandError(issue.code, "rolling back " + plan.envelope.id + ": " + issue.message);
        }
    }
    if (!conflicts.empty()) {
        throw RollbackError(std::move(conflicts));
    }

    const std::string planId = plan.envelope.id;
    RevisionEnvelope envelope;
    envelope.cause = Cause::rollback;
    envelope.actor = std::move(actor);
    envelope.time = std::move(time);
    const Revision& revision = append(Revision{std::move(envelope), {}, planId, {}, std::move(inverse)});
    undoStack_.push_back(revisions_.size() - 1);
    redoStack_.clear();
    return revision;
}

}  // namespace siann::command
