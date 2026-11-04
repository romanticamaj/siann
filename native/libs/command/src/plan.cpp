#include "siann/command/plan.hpp"

#include <algorithm>
#include <utility>

#include "siann/hash/jcs.hpp"

namespace siann::command {

using json::Array;
using json::Object;
using json::Value;
using model::DiffEntry;
using model::EntityRef;
using model::EntityType;

namespace {

constexpr std::string_view kHashedFields[] = {"schema", "baseRevision", "steps", "readSet", "writeSet",
                                              "parentPlan"};

[[noreturn]] void invalidPlan(const std::string& message) {
    throw CommandError("invalid_plan", message);
}

[[noreturn]] void invalidSet(const std::string& message) {
    throw CommandError("invalid_entity_set", message);
}

// Entity sets are ordered by (type name, id) as byte strings, as in the Node bridge.
bool setLess(const EntityRef& a, const EntityRef& b) noexcept {
    const std::string_view ta = model::entityTypeName(a.type);
    const std::string_view tb = model::entityTypeName(b.type);
    return ta != tb ? ta < tb : a.id < b.id;
}

std::optional<EntityType> entityTypeFromName(std::string_view name) noexcept {
    for (const EntityType type : {EntityType::root, EntityType::media, EntityType::track, EntityType::clip}) {
        if (model::entityTypeName(type) == name) {
            return type;
        }
    }
    return std::nullopt;
}

bool validEntityId(const std::string& id) noexcept {
    if (id.empty() || id.size() > 64) {
        return false;
    }
    return std::all_of(id.begin(), id.end(), [](char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
    });
}

std::vector<EntitySnapshot> entitySetFromJson(const Value* value, const std::string& name) {
    if (value == nullptr || value->kind() != Value::Kind::array) {
        invalidSet(name + " must be an array");
    }
    std::vector<EntitySnapshot> out;
    for (std::size_t i = 0; i < value->asArray().size(); ++i) {
        const Value& item = value->asArray()[i];
        const std::string where = name + "[" + std::to_string(i) + "]";
        if (item.kind() != Value::Kind::object) {
            invalidSet(where + " must be {type, id, hash}");
        }
        for (const auto& member : item.asObject()) {
            if (member.first != "type" && member.first != "id" && member.first != "hash") {
                invalidSet(where + " has unknown field " + member.first);
            }
        }
        const Value* type = item.find("type");
        const Value* id = item.find("id");
        const Value* digest = item.find("hash");
        const auto entityType = type != nullptr && type->kind() == Value::Kind::string
                                    ? entityTypeFromName(type->asString())
                                    : std::nullopt;
        if (!entityType) {
            invalidSet(where + " has an unknown entity type");
        }
        if (id == nullptr || id->kind() != Value::Kind::string || !validEntityId(id->asString()) ||
            (*entityType == EntityType::root && id->asString() != "root")) {
            invalidSet(where + " has an invalid id");
        }
        EntitySnapshot snapshot{EntityRef{*entityType, id->asString()}, std::nullopt};
        if (digest == nullptr || (!digest->isNull() && digest->kind() != Value::Kind::string)) {
            invalidSet(where + " hash must be \"sha256:<hex>\" or null");
        }
        if (!digest->isNull()) {
            snapshot.entityHash = hash::parseHash(digest->asString());
            if (!snapshot.entityHash) {
                invalidSet(where + " hash must be \"sha256:<hex>\" or null");
            }
        }
        if (!out.empty() && !setLess(out.back().ref, snapshot.ref)) {
            invalidSet(name + " must be sorted by (type, id) without duplicates");
        }
        out.push_back(std::move(snapshot));
    }
    return out;
}

Value entitySetToJson(const std::vector<EntitySnapshot>& set) {
    Array out;
    for (const EntitySnapshot& entry : set) {
        out.push_back(Value(Object{
            {"type", Value(std::string(model::entityTypeName(entry.ref.type)))},
            {"id", Value(entry.ref.id)},
            {"hash", entry.entityHash ? Value(hash::formatHash(*entry.entityHash)) : Value(nullptr)},
        }));
    }
    return Value(std::move(out));
}

std::optional<std::string> optionalString(const Value& plan, std::string_view key) {
    const Value* value = plan.find(key);
    if (value == nullptr) {
        return std::nullopt;
    }
    if (value->kind() != Value::Kind::string) {
        invalidPlan(std::string(key) + " must be a string");
    }
    return value->asString();
}

std::optional<PlanState> planStateFromName(std::string_view name) noexcept {
    for (const PlanState state : {PlanState::draft, PlanState::validated, PlanState::approved, PlanState::rejected,
                                  PlanState::applied, PlanState::rolled_back}) {
        if (planStateName(state) == name) {
            return state;
        }
    }
    return std::nullopt;
}

std::vector<EntitySnapshot> snapshot(const model::Document& document, std::vector<EntityRef> refs) {
    std::sort(refs.begin(), refs.end(), setLess);
    refs.erase(std::unique(refs.begin(), refs.end()), refs.end());
    std::vector<EntitySnapshot> out;
    out.reserve(refs.size());
    for (EntityRef& ref : refs) {
        const auto digest = document.findEntityHash(ref);
        out.push_back(EntitySnapshot{std::move(ref), digest});
    }
    return out;
}

std::vector<EntitySnapshot> writeSetOf(const model::Document& base, const DeclaredEffects& effects) {
    return snapshot(base, std::vector<EntityRef>(effects.begin(), effects.end()));
}

std::vector<StaleEntity> staleEntities(const model::Document& head, const Plan& plan) {
    std::vector<EntitySnapshot> recorded = plan.readSet;
    recorded.insert(recorded.end(), plan.writeSet.begin(), plan.writeSet.end());
    std::sort(recorded.begin(), recorded.end(),
              [](const EntitySnapshot& a, const EntitySnapshot& b) { return setLess(a.ref, b.ref); });
    recorded.erase(std::unique(recorded.begin(), recorded.end(),
                               [](const EntitySnapshot& a, const EntitySnapshot& b) { return a.ref == b.ref; }),
                   recorded.end());

    std::vector<StaleEntity> out;
    for (const EntitySnapshot& entry : recorded) {
        const auto current = head.findEntityHash(entry.ref);
        if (current == entry.entityHash) {
            continue;
        }
        const auto change = !entry.entityHash ? DiffEntry::Change::added
                            : !current        ? DiffEntry::Change::removed
                                              : DiffEntry::Change::modified;
        out.push_back(StaleEntity{entry.ref, change});
    }
    return out;
}

const Revision& requireRevision(const History& history, const std::string& id) {
    const Revision* revision = history.find(id);
    if (revision == nullptr) {
        throw CommandError("not_found", "no revision with id " + id);
    }
    return *revision;
}

std::string_view changeName(DiffEntry::Change change) noexcept {
    switch (change) {
        case DiffEntry::Change::added: return "added";
        case DiffEntry::Change::removed: return "removed";
        case DiffEntry::Change::modified: return "modified";
    }
    return "modified";
}

std::string staleMessage(const std::vector<StaleEntity>& changed) {
    std::string message = "the plan is stale:";
    for (const StaleEntity& entry : changed) {
        message += " " + entityKey(entry.entity) + " (" + std::string(changeName(entry.change)) + ")";
    }
    return message;
}

}  // namespace

std::string_view planStateName(PlanState state) noexcept {
    switch (state) {
        case PlanState::draft: return "draft";
        case PlanState::validated: return "validated";
        case PlanState::approved: return "approved";
        case PlanState::rejected: return "rejected";
        case PlanState::applied: return "applied";
        case PlanState::rolled_back: return "rolled_back";
    }
    return "draft";
}

const std::vector<std::string_view>& planHashExcludedFields() {
    static const std::vector<std::string_view> fields{"hash",       "state",         "approvedBy",
                                                      "approvedAt", "rejectedBy",    "rejectedAt",
                                                      "rejectionNote", "appliedRevision"};
    return fields;
}

Plan Plan::fromJson(const Value& value) {
    if (value.kind() != Value::Kind::object) {
        invalidPlan("a plan must be a JSON object");
    }
    const auto& excluded = planHashExcludedFields();
    for (const auto& member : value.asObject()) {
        const bool known = std::find(std::begin(kHashedFields), std::end(kHashedFields), member.first) !=
                               std::end(kHashedFields) ||
                           std::find(excluded.begin(), excluded.end(), member.first) != excluded.end();
        if (!known) {
            invalidPlan("unknown plan field " + member.first);
        }
    }
    const Value* schema = value.find("schema");
    if (schema == nullptr || schema->kind() != Value::Kind::string || schema->asString() != kPlanSchema) {
        invalidPlan("schema must be " + std::string(kPlanSchema));
    }
    Plan plan;
    const Value* base = value.find("baseRevision");
    if (base == nullptr || base->kind() != Value::Kind::string || base->asString().empty()) {
        invalidPlan("baseRevision must be a non-empty string");
    }
    plan.baseRevision = base->asString();

    const Value* steps = value.find("steps");
    if (steps == nullptr || steps->kind() != Value::Kind::array || steps->asArray().empty()) {
        invalidPlan("steps must be a non-empty array");
    }
    for (std::size_t i = 0; i < steps->asArray().size(); ++i) {
        try {
            plan.steps.push_back(Command::fromJson(steps->asArray()[i]));
        } catch (const CommandError& error) {
            throw CommandError("invalid_plan", "steps[" + std::to_string(i) + "]: " + error.what(), i);
        }
    }
    plan.readSet = entitySetFromJson(value.find("readSet"), "readSet");
    plan.writeSet = entitySetFromJson(value.find("writeSet"), "writeSet");

    plan.parentPlan = optionalString(value, "parentPlan");
    if (plan.parentPlan && !hash::parseHash(*plan.parentPlan)) {
        invalidPlan("parentPlan must be \"sha256:<hex>\"");
    }
    plan.hashText = optionalString(value, "hash");
    if (const auto state = optionalString(value, "state")) {
        const auto parsed = planStateFromName(*state);
        if (!parsed) {
            invalidPlan("unknown plan state " + *state);
        }
        plan.state = *parsed;
    }
    plan.approvedBy = optionalString(value, "approvedBy");
    plan.approvedAt = optionalString(value, "approvedAt");
    plan.rejectedBy = optionalString(value, "rejectedBy");
    plan.rejectedAt = optionalString(value, "rejectedAt");
    plan.rejectionNote = optionalString(value, "rejectionNote");
    plan.appliedRevision = optionalString(value, "appliedRevision");
    return plan;
}

Plan Plan::parse(std::string_view text) {
    Value value;
    try {
        value = json::parse(text);
    } catch (const json::ParseError& error) {
        const std::string& code = error.code();
        if (code == "syntax" || code == "trailing_content" || code == "too_deep") {
            invalidPlan(std::string("plan is not valid JSON: ") + error.what());
        }
        throw CommandError("plan_not_canonicalizable", error.what());
    }
    return fromJson(value);
}

Value Plan::toJson() const {
    Array stepValues;
    for (const Command& step : steps) {
        stepValues.push_back(step.json);
    }
    Object out{
        {"schema", Value(std::string(kPlanSchema))},
        {"baseRevision", Value(baseRevision)},
        {"steps", Value(std::move(stepValues))},
        {"readSet", entitySetToJson(readSet)},
        {"writeSet", entitySetToJson(writeSet)},
    };
    const auto put = [&out](const char* key, const std::optional<std::string>& field) {
        if (field) {
            out.emplace_back(key, Value(*field));
        }
    };
    put("parentPlan", parentPlan);
    put("hash", hashText);
    out.emplace_back("state", Value(std::string(planStateName(state))));
    put("approvedBy", approvedBy);
    put("approvedAt", approvedAt);
    put("rejectedBy", rejectedBy);
    put("rejectedAt", rejectedAt);
    put("rejectionNote", rejectionNote);
    put("appliedRevision", appliedRevision);
    return Value(std::move(out));
}

hash::Digest planHash(const Plan& plan) {
    const Value full = plan.toJson();
    const auto& excluded = planHashExcludedFields();
    Object hashed;
    for (const auto& member : full.asObject()) {
        if (std::find(excluded.begin(), excluded.end(), member.first) == excluded.end()) {
            hashed.push_back(member);
        }
    }
    try {
        return hash::sha256(jcs::canonicalize(Value(std::move(hashed))));
    } catch (const jcs::CanonicalizeError& error) {
        throw CommandError("plan_not_canonicalizable", error.what());
    }
}


PlanStaleError::PlanStaleError(std::string planHashText, std::vector<StaleEntity> changed)
    : CommandError("plan_stale", staleMessage(changed)), plan_(std::move(planHashText)), changed_(std::move(changed)) {}

std::vector<std::string> PlanStaleError::changedEntityKeys() const {
    std::vector<std::string> keys;
    keys.reserve(changed_.size());
    for (const StaleEntity& entry : changed_) {
        keys.push_back(entityKey(entry.entity));
    }
    return keys;
}

const Plan* PlanStore::find(std::string_view planHashText) const noexcept {
    const auto it = plans_.find(planHashText);
    return it == plans_.end() ? nullptr : &it->second;
}

Plan& PlanStore::require(std::string_view planHashText) {
    const auto it = plans_.find(planHashText);
    if (it == plans_.end()) {
        throw CommandError("not_found", "no plan with hash " + std::string(planHashText));
    }
    return it->second;
}

const Plan& PlanStore::store(Plan plan) {
    std::string key = hash::formatHash(planHash(plan));
    plan.hashText = key;
    return plans_.try_emplace(std::move(key), std::move(plan)).first->second;
}

void PlanStore::requireFresh(const History& history, const Plan& plan) const {
    std::vector<StaleEntity> changed = staleEntities(history.head().document, plan);
    if (!changed.empty()) {
        throw PlanStaleError(*plan.hashText, std::move(changed));
    }
}

const Plan& PlanStore::submit(const History& history, std::vector<Command> steps, std::vector<EntityRef> readSet,
                              const std::string& baseRevision) {
    const model::Document& base = requireRevision(history, baseRevision).document;
    const Prepared prepared = prepareTransaction(base, steps);
    Plan plan;
    plan.baseRevision = baseRevision;
    plan.steps = std::move(steps);
    plan.readSet = snapshot(base, std::move(readSet));
    plan.writeSet = writeSetOf(base, prepared.effects);
    plan.state = PlanState::validated;
    return store(std::move(plan));
}

std::vector<StaleEntity> PlanStore::validate(const History& history, std::string_view planHashText) const {
    const Plan* plan = find(planHashText);
    if (plan == nullptr) {
        throw CommandError("not_found", "no plan with hash " + std::string(planHashText));
    }
    return staleEntities(history.head().document, *plan);
}

const Plan& PlanStore::approve(const History& history, std::string_view planHashText, std::string approvedBy,
                               std::string time) {
    Plan& plan = require(planHashText);
    if (plan.state != PlanState::validated) {
        throw CommandError("invalid_state", "only a validated plan can be approved; this one is " +
                                                std::string(planStateName(plan.state)));
    }
    requireFresh(history, plan);
    plan.state = PlanState::approved;
    plan.approvedBy = std::move(approvedBy);
    plan.approvedAt = std::move(time);
    return plan;
}

const Plan& PlanStore::approvePartial(const History& history, std::string_view planHashText,
                                      const std::vector<std::size_t>& stepIndexes, std::string approvedBy,
                                      std::string time) {
    Plan& original = require(planHashText);
    if (original.state != PlanState::validated) {
        throw CommandError("invalid_state", "only a validated plan can be approved; this one is " +
                                                std::string(planStateName(original.state)));
    }
    std::vector<std::size_t> indexes = stepIndexes;
    std::sort(indexes.begin(), indexes.end());
    if (indexes.empty()) {
        throw CommandError("invalid_params", "partial approval needs at least one step");
    }
    if (std::adjacent_find(indexes.begin(), indexes.end()) != indexes.end()) {
        throw CommandError("invalid_params", "partial approval lists a step twice");
    }
    if (indexes.back() >= original.steps.size()) {
        throw CommandError("invalid_params", "partial approval names step " + std::to_string(indexes.back()) +
                                                 " of a plan with " + std::to_string(original.steps.size()));
    }
    if (indexes.size() == original.steps.size()) {
        throw CommandError("invalid_params", "partial approval of every step; approve the plan instead");
    }

    Plan sub;
    sub.baseRevision = original.baseRevision;
    for (const std::size_t index : indexes) {
        sub.steps.push_back(original.steps[index]);
    }
    const model::Document& base = requireRevision(history, original.baseRevision).document;
    const Prepared prepared = [&] {
        try {
            return prepareTransaction(base, sub.steps);
        } catch (const CommandError& error) {
            throw CommandError("invalid_params",
                               std::string("the approved steps do not apply without the others: ") + error.what(),
                               error.step());
        }
    }();
    sub.readSet = original.readSet;
    sub.writeSet = writeSetOf(base, prepared.effects);
    sub.parentPlan = original.hashText;
    sub.state = PlanState::validated;
    const std::string subHash = *store(std::move(sub)).hashText;

    original.state = PlanState::rejected;
    original.rejectedBy = approvedBy;
    original.rejectedAt = time;
    original.rejectionNote = "partially approved as " + subHash;

    return approve(history, subHash, std::move(approvedBy), std::move(time));
}

const Plan& PlanStore::reject(std::string_view planHashText, std::string rejectedBy, std::string time,
                              std::string note) {
    Plan& plan = require(planHashText);
    if (plan.state != PlanState::validated && plan.state != PlanState::approved) {
        throw CommandError("invalid_state", "a plan that is " + std::string(planStateName(plan.state)) +
                                                " cannot be rejected");
    }
    plan.state = PlanState::rejected;
    plan.rejectedBy = std::move(rejectedBy);
    plan.rejectedAt = std::move(time);
    plan.rejectionNote = std::move(note);
    return plan;
}

const Revision& PlanStore::apply(History& history, std::string_view planHashText, std::string actor,
                                 std::string time) {
    return apply(history, planHashText, std::move(actor), std::move(time),
                 [&history](std::vector<Command> steps, std::string a, std::string t) -> const Revision& {
                     return history.commit(std::move(steps), std::move(a), std::move(t), Cause::plan);
                 });
}

const Revision& PlanStore::apply(const History& history, std::string_view planHashText, std::string actor,
                                 std::string time, const Commit& commit) {
    Plan& plan = require(planHashText);
    if (plan.state != PlanState::approved) {
        throw CommandError("invalid_state", "only an approved plan can be applied; this one is " +
                                                std::string(planStateName(plan.state)));
    }
    requireFresh(history, plan);
    const Revision& revision = commit(plan.steps, std::move(actor), std::move(time));
    plan.state = PlanState::applied;
    plan.appliedRevision = revision.envelope.id;
    return revision;
}

const Revision& PlanStore::rollback(History& history, std::string_view planHashText, std::string actor,
                                    std::string time) {
    return rollback(planHashText, std::move(actor), std::move(time),
                    [&history](const std::string& planRevisionId, std::string a, std::string t) -> const Revision& {
                        return history.rollback(planRevisionId, std::move(a), std::move(t));
                    });
}

const Revision& PlanStore::rollback(std::string_view planHashText, std::string actor, std::string time,
                                    const Rollback& rollbackRevision) {
    Plan& plan = require(planHashText);
    if (plan.state != PlanState::applied || !plan.appliedRevision) {
        throw CommandError("plan_not_applied", "only an applied plan can be rolled back; this one is " +
                                                   std::string(planStateName(plan.state)));
    }
    const Revision& revision = rollbackRevision(*plan.appliedRevision, std::move(actor), std::move(time));
    plan.state = PlanState::rolled_back;
    return revision;
}

}  // namespace siann::command
