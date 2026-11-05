#include "siann/command/history.hpp"

#include <algorithm>
#include <charconv>
#include <set>
#include <utility>

#include "siann/command/plan.hpp"

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

bool containsId(const std::vector<std::string>& ids, const std::string& id) {
    return std::find(ids.begin(), ids.end(), id) != ids.end();
}

// ids without the entries of excluded, order kept.
std::vector<std::string> without(const std::vector<std::string>& ids, const std::vector<std::string>& excluded) {
    std::vector<std::string> out;
    for (const std::string& id : ids) {
        if (!containsId(excluded, id)) {
            out.push_back(id);
        }
    }
    return out;
}

// The number in "<prefix><n>" (n >= 1), or nothing.
std::optional<std::uint64_t> numberAfter(std::string_view id, char prefix) noexcept {
    if (id.size() < 2 || id.front() != prefix || id[1] == '0') {
        return std::nullopt;
    }
    std::uint64_t n = 0;
    const char* first = id.data() + 1;
    const char* last = id.data() + id.size();
    const auto [ptr, ec] = std::from_chars(first, last, n);
    if (ec != std::errc() || ptr != last) {
        return std::nullopt;
    }
    return n;
}

std::string joined(const std::vector<std::string>& items) {
    std::string out;
    for (const std::string& item : items) {
        out += out.empty() ? item : ", " + item;
    }
    return out;
}

// What a plan changed in root, field by field. Root is shared session state
// (name, sample rate, tempo, track order): the plan owns only the fields it
// changed and the order slots of the tracks it added or removed.
struct RootChange {
    bool name = false;
    bool sampleRate = false;
    bool tempo = false;
    bool order = false;               // the plan reordered tracks it neither added nor removed
    std::vector<std::string> added;   // in the plan's order, not before it
    std::vector<std::string> removed; // in the order before the plan, not after it
};

RootChange rootChange(const model::Root& before, const model::Root& after) {
    RootChange change;
    change.name = before.name != after.name;
    change.sampleRate = before.sampleRate != after.sampleRate;
    change.tempo = before.tempo != after.tempo;
    for (const std::string& id : after.trackOrder) {
        if (!containsId(before.trackOrder, id)) {
            change.added.push_back(id);
        }
    }
    for (const std::string& id : before.trackOrder) {
        if (!containsId(after.trackOrder, id)) {
            change.removed.push_back(id);
        }
    }
    change.order = without(before.trackOrder, change.removed) != without(after.trackOrder, change.added);
    return change;
}

// A root field the plan changed that is no longer as the plan left it.
// Membership of added and removed tracks is checked on the track entities.
bool rootConflicts(const RootChange& change, const model::Root& planned, const model::Root& current) {
    return (change.name && current.name != planned.name) ||
           (change.sampleRate && current.sampleRate != planned.sampleRate) ||
           (change.tempo && current.tempo != planned.tempo) ||
           (change.order && current.trackOrder != planned.trackOrder);
}

// The current root with the plan's fields set back to before. Plan-added
// tracks leave the order; a plan-removed track goes back right after its
// nearest earlier neighbour in the old order that is still present, or first.
model::Root restoreRoot(const RootChange& change, const model::Root& before, model::Root current) {
    if (change.name) {
        current.name = before.name;
    }
    if (change.sampleRate) {
        current.sampleRate = before.sampleRate;
    }
    if (change.tempo) {
        current.tempo = before.tempo;
    }
    if (change.order) {
        current.trackOrder = before.trackOrder;
        return current;
    }
    current.trackOrder = without(current.trackOrder, change.added);
    for (std::size_t i = 0; i < before.trackOrder.size(); ++i) {
        const std::string& id = before.trackOrder[i];
        if (!containsId(change.removed, id)) {
            continue;
        }
        auto at = current.trackOrder.begin();
        for (std::size_t j = i; j-- > 0;) {
            auto found = std::find(current.trackOrder.begin(), current.trackOrder.end(), before.trackOrder[j]);
            if (found != current.trackOrder.end()) {
                at = found + 1;
                break;
            }
        }
        current.trackOrder.insert(at, id);
    }
    return current;
}

// The document with one entity set to its state in source (removed when
// source lacks it). Root is restored field by field (restoreRoot).
model::Document restoreEntity(const model::Document& document, const model::Document& source,
                              const EntityRef& ref, const RootChange& change) {
    switch (ref.type) {
        case EntityType::root:
            return document.withRoot(restoreRoot(change, source.root(), document.root()));
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

void requireCommitCause(Cause cause) {
    if (cause != Cause::command && cause != Cause::plan) {
        throw CommandError("invalid_params", "commit cause must be command or plan");
    }
}

Revision newRevision(Cause cause, std::string actor, std::string time, model::Document document) {
    RevisionEnvelope envelope;
    envelope.cause = cause;
    envelope.actor = std::move(actor);
    envelope.time = std::move(time);
    return Revision{std::move(envelope), {}, std::nullopt, {}, std::move(document), std::nullopt};
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
        case Cause::branchMerge: return "branch-merge";
    }
    return "unknown";
}

History::History(model::Document initial, std::string actor, std::string time) {
    Revision revision = newRevision(Cause::create, std::move(actor), std::move(time), std::move(initial));
    append(std::move(revision), {});
    mainHead_ = 0;
}

const Revision* History::find(std::string_view id) const noexcept {
    const auto n = numberAfter(id, 'r');
    if (!n || *n > revisions_.size()) {
        return nullptr;
    }
    const Revision& revision = revisions_[static_cast<std::size_t>(*n - 1)];
    return revision.envelope.id == id ? &revision : nullptr;
}

std::size_t History::indexOf(std::string_view id) const {
    const Revision* revision = find(id);
    if (revision == nullptr) {
        throw CommandError("not_found", "no revision with id " + std::string(id));
    }
    return static_cast<std::size_t>(revision - revisions_.data());
}

const Revision& History::append(Revision revision, std::vector<std::size_t> parents) {
    revision.envelope.id = "r" + std::to_string(revisions_.size() + 1);
    revision.envelope.parents.clear();
    for (const std::size_t parent : parents) {
        revision.envelope.parents.push_back(revisions_[parent].envelope.id);
    }
    if (!parents.empty()) {
        revision.diff = model::diff(revisions_[parents.front()].document, revision.document);
    }
    revision.envelope.documentHash = revision.document.documentHash();
    if (beforePublish_) {
        beforePublish_(revision);
    }
    revisions_.push_back(std::move(revision));
    return revisions_.back();
}

const Revision& History::commit(std::vector<Command> commands, std::string actor, std::string time, Cause cause) {
    requireCommitCause(cause);
    Prepared prepared = prepareTransaction(head().document, commands);
    Revision revision = newRevision(cause, std::move(actor), std::move(time), std::move(prepared.result));
    revision.commands = std::move(commands);
    const Revision& appended = append(std::move(revision), {mainHead_});
    mainHead_ = revisions_.size() - 1;
    undoStack_.push_back(mainHead_);
    redoStack_.clear();
    return appended;
}

const Revision& History::undo(std::string actor, std::string time) {
    if (undoStack_.empty()) {
        throw CommandError("nothing_to_undo", "there is nothing to undo");
    }
    const std::size_t target = undoStack_.back();
    // A merge's first parent is main before the merge.
    const std::size_t parent = indexOf(revisions_[target].envelope.parents.front());

    Revision revision = newRevision(Cause::undo, std::move(actor), std::move(time), revisions_[parent].document);
    revision.target = revisions_[target].envelope.id;
    const Revision& appended = append(std::move(revision), {mainHead_});
    mainHead_ = revisions_.size() - 1;
    undoStack_.pop_back();
    redoStack_.push_back(target);
    return appended;
}

const Revision& History::redo(std::string actor, std::string time) {
    if (redoStack_.empty()) {
        throw CommandError("nothing_to_redo", "there is nothing to redo");
    }
    const std::size_t target = redoStack_.back();

    Revision revision = newRevision(Cause::redo, std::move(actor), std::move(time), revisions_[target].document);
    revision.target = revisions_[target].envelope.id;
    const Revision& appended = append(std::move(revision), {mainHead_});
    mainHead_ = revisions_.size() - 1;
    redoStack_.pop_back();
    undoStack_.push_back(target);
    return appended;
}

bool History::reachable(std::string_view id) const {
    const Revision* revision = find(id);
    if (revision == nullptr) {
        return false;
    }
    const auto wanted = static_cast<std::size_t>(revision - revisions_.data());
    if (wanted > mainHead_) {
        return false;
    }
    // Parents always precede their children, so one backward sweep marks
    // every ancestor of main's head.
    std::vector<bool> marked(mainHead_ + 1, false);
    marked[mainHead_] = true;
    for (std::size_t i = mainHead_ + 1; i-- > wanted;) {
        if (!marked[i]) {
            continue;
        }
        if (i == wanted) {
            return true;
        }
        for (const std::string& parent : revisions_[i].envelope.parents) {
            marked[indexOf(parent)] = true;
        }
    }
    return false;
}

History::OpenBranch& History::requireBranch(const BranchId& branchId) {
    const auto found = std::find_if(branches_.begin(), branches_.end(),
                                    [&](const OpenBranch& open) { return open.id == branchId; });
    if (found == branches_.end()) {
        throw CommandError("not_found", "no open proposal branch " + branchId);
    }
    return *found;
}

const History::OpenBranch& History::requireBranch(const BranchId& branchId) const {
    return const_cast<History*>(this)->requireBranch(branchId);
}

BranchId History::branch(std::string_view baseId) {
    const std::size_t base = indexOf(baseId);
    if (!reachable(baseId)) {
        throw CommandError("invalid_params", "a proposal branch must start at a revision on main; " +
                                                 std::string(baseId) + " is not reachable from main's head");
    }
    BranchId id = "p" + std::to_string(nextBranch_++);
    branches_.push_back(OpenBranch{id, base, base, {}});
    return id;
}

bool History::isOpen(const BranchId& branchId) const noexcept {
    return std::any_of(branches_.begin(), branches_.end(),
                       [&](const OpenBranch& open) { return open.id == branchId; });
}

std::vector<BranchId> History::branches() const {
    std::vector<BranchId> out;
    for (const OpenBranch& open : branches_) {
        out.push_back(open.id);
    }
    return out;
}

const Revision& History::branchHead(const BranchId& branchId) const {
    return revisions_[requireBranch(branchId).tip];
}

const Revision& History::appendBranchCommit(std::size_t parent, const BranchId& branchId,
                                            std::vector<Command> commands, std::string actor, std::string time,
                                            Cause cause) {
    requireCommitCause(cause);
    Prepared prepared = prepareTransaction(revisions_[parent].document, commands);
    Revision revision = newRevision(cause, std::move(actor), std::move(time), std::move(prepared.result));
    revision.commands = std::move(commands);
    revision.branch = branchId;
    return append(std::move(revision), {parent});
}

const Revision& History::commitOn(const BranchId& branchId, std::vector<Command> commands, std::string actor,
                                  std::string time, Cause cause) {
    OpenBranch& open = requireBranch(branchId);
    const Revision& appended =
        appendBranchCommit(open.tip, branchId, std::move(commands), std::move(actor), std::move(time), cause);
    open.tip = revisions_.size() - 1;
    open.commits.push_back(open.tip);
    return appended;
}

const Revision& History::appendMerge(std::size_t branchTip, std::vector<Command> commands, model::Document merged,
                                     std::string actor, std::string time, std::optional<BranchId> branchId) {
    Revision revision = newRevision(Cause::branchMerge, std::move(actor), std::move(time), std::move(merged));
    revision.commands = std::move(commands);
    revision.branch = std::move(branchId);
    const Revision& appended = append(std::move(revision), {mainHead_, branchTip});
    mainHead_ = revisions_.size() - 1;
    undoStack_.push_back(mainHead_);
    redoStack_.clear();
    return appended;
}

const Revision& History::merge(const BranchId& branchId, std::string actor, std::string time,
                               const std::vector<model::EntityRef>& guarded) {
    const OpenBranch& open = requireBranch(branchId);
    if (open.commits.empty()) {
        throw CommandError("empty_transaction", "proposal branch " + branchId + " has no commits to merge");
    }
    const model::Document& base = revisions_[open.base].document;
    const model::Document& tip = revisions_[open.tip].document;
    const model::Document& mainDoc = head().document;

    std::set<model::EntityRef> written;
    std::vector<Command> commands;
    for (const std::size_t index : open.commits) {
        for (const model::DiffEntry& entry : revisions_[index].diff) {
            written.insert(entry.entity);
        }
        commands.insert(commands.end(), revisions_[index].commands.begin(), revisions_[index].commands.end());
    }

    std::set<model::EntityRef> checked = written;
    checked.insert(guarded.begin(), guarded.end());
    std::vector<std::string> conflicts;
    for (const model::EntityRef& ref : checked) {
        if (base.findEntityHash(ref) != mainDoc.findEntityHash(ref)) {
            conflicts.push_back(entityKey(ref));
        }
    }
    if (!conflicts.empty()) {
        throw CommandError("branch_conflict", "main changed entities proposal branch " + branchId +
                                                  " wrote or guards since " + revisions_[open.base].envelope.id + ": " +
                                                  joined(conflicts));
    }

    std::optional<Prepared> prepared;
    try {
        prepared = prepareTransaction(mainDoc, commands);
    } catch (const CommandError& error) {
        throw CommandError("branch_conflict",
                           "proposal branch " + branchId + " does not apply to main's head: " + error.what(),
                           error.step());
    }
    // The entities the branch wrote must come out as they are on the branch.
    for (const model::EntityRef& ref : written) {
        if (prepared->result.findEntityHash(ref) != tip.findEntityHash(ref)) {
            conflicts.push_back(entityKey(ref));
        }
    }
    // On main's head the commands may reach further than on the branch (a
    // track.remove also removes clips main placed on the track since the
    // base). The merge may change only entities the branch wrote.
    for (const model::DiffEntry& entry : model::diff(mainDoc, prepared->result)) {
        if (written.count(entry.entity) == 0) {
            conflicts.push_back(entityKey(entry.entity));
        }
    }
    if (!conflicts.empty()) {
        throw CommandError("branch_conflict", "proposal branch " + branchId +
                                                  " gives a different result on main's head for: " +
                                                  joined(conflicts));
    }

    const std::size_t tipIndex = open.tip;
    const Revision& appended =
        appendMerge(tipIndex, std::move(commands), std::move(prepared->result), std::move(actor), std::move(time),
                    branchId);
    branches_.erase(std::find_if(branches_.begin(), branches_.end(),
                                 [&](const OpenBranch& entry) { return entry.id == branchId; }));
    return appended;
}

void History::discard(const BranchId& branchId) {
    (void)requireBranch(branchId);
    branches_.erase(std::find_if(branches_.begin(), branches_.end(),
                                 [&](const OpenBranch& entry) { return entry.id == branchId; }));
}

void History::noteBranchId(const BranchId& branchId) {
    const auto n = numberAfter(branchId, 'p');
    if (!n) {
        throw CommandError("invalid_params", "invalid proposal branch id " + branchId);
    }
    nextBranch_ = std::max(nextBranch_, *n + 1);
}

const Revision& History::commitOnParent(const BranchId& branchId, std::string_view parentId,
                                        std::vector<Command> commands, std::string actor, std::string time,
                                        Cause cause) {
    const std::size_t parent = indexOf(parentId);
    noteBranchId(branchId);
    return appendBranchCommit(parent, branchId, std::move(commands), std::move(actor), std::move(time), cause);
}

const Revision& History::mergeReplay(const std::vector<std::string>& parents, std::vector<Command> commands,
                                     std::string actor, std::string time, std::optional<BranchId> branchId) {
    if (parents.size() != 2 || parents.front() != head().envelope.id) {
        throw CommandError("invalid_params", "a merge has two parents, main's head first");
    }
    const std::size_t tip = indexOf(parents.back());
    if (branchId) {
        noteBranchId(*branchId);
    }
    Prepared prepared = prepareTransaction(head().document, commands);
    return appendMerge(tip, std::move(commands), std::move(prepared.result), std::move(actor), std::move(time),
                       std::move(branchId));
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

    // Every affected entity must be as the plan left it; root only in the
    // fields the plan changed.
    const RootChange change = rootChange(before.root(), plan.document.root());
    std::vector<EntityRef> conflicts;
    for (const DiffEntry& entry : affectedEntities(plan)) {
        const bool changed = entry.entity.type == EntityType::root
                                 ? rootConflicts(change, plan.document.root(), current.root())
                                 : plan.document.findEntityHash(entry.entity) != current.findEntityHash(entry.entity);
        if (changed) {
            conflicts.push_back(entry.entity);
        }
    }
    if (!conflicts.empty()) {
        throw RollbackError(std::move(conflicts));
    }

    model::Document inverse = current;
    for (const DiffEntry& entry : affectedEntities(plan)) {
        inverse = restoreEntity(inverse, before, entry.entity, change);
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
    Revision revision = newRevision(Cause::rollback, std::move(actor), std::move(time), std::move(inverse));
    revision.target = planId;
    const Revision& appended = append(std::move(revision), {mainHead_});
    mainHead_ = revisions_.size() - 1;
    undoStack_.push_back(mainHead_);
    redoStack_.clear();
    return appended;
}

}  // namespace siann::command
