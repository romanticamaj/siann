#pragma once

// Plans in the engine (architecture spec, "Plans" and "Canonical JSON and
// hashes"). A plan is a list of commands reviewed against one base revision.
// Its readSet and writeSet record entity hashes at that revision; the plan
// stays valid while every one of those entities is unchanged at the head
// (per entity, not per head revision). Approval and apply re-check that and
// throw PlanStaleError otherwise. Partial approval turns a proper subset of
// the steps into a sub-plan with its own hash and rejects the original.
//
// planHash = sha256(JCS(plan)) without the lifecycle fields; it must match
// the Node bridge (src/hash/plan-hash.js) on fixtures/plan/plan-hash.json.
// Plans are in-memory engine state in M3; they are not stored in the bundle.

#include <cstddef>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "siann/command/command.hpp"
#include "siann/command/history.hpp"
#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/model/document.hpp"

namespace siann::command {

inline constexpr std::string_view kPlanSchema = "siann.plan.v1";

enum class PlanState { draft, validated, approved, rejected, applied, rolled_back };

std::string_view planStateName(PlanState state) noexcept;

// One readSet or writeSet entry. entityHash is empty when the entity is absent
// at the base revision (the plan creates it).
struct EntitySnapshot {
    model::EntityRef ref;
    std::optional<hash::Digest> entityHash;

    friend bool operator==(const EntitySnapshot&, const EntitySnapshot&) = default;
};

struct Plan {
    std::string baseRevision;
    std::vector<Command> steps;
    std::vector<EntitySnapshot> readSet;   // sorted by (type name, id), unique
    std::vector<EntitySnapshot> writeSet;  // sorted by (type name, id), unique
    std::optional<std::string> parentPlan;  // "sha256:..." of the plan a sub-plan came from

    // Lifecycle fields; not part of planHash.
    std::optional<std::string> hashText;  // JSON "hash"
    PlanState state = PlanState::draft;
    std::optional<std::string> approvedBy;
    std::optional<std::string> approvedAt;
    std::optional<std::string> rejectedBy;
    std::optional<std::string> rejectedAt;
    std::optional<std::string> rejectionNote;
    std::optional<std::string> appliedRevision;

    // Parses a siann.plan.v1 object. Unknown fields are rejected. Throws
    // CommandError invalid_plan or invalid_entity_set.
    static Plan fromJson(const json::Value& value);
    // Parses JSON text; text that cannot be canonicalized (numbers out of
    // range, lone surrogates, invalid UTF-8, duplicate keys) is
    // plan_not_canonicalizable.
    static Plan parse(std::string_view text);
    json::Value toJson() const;
};

// The fields planHash leaves out, as JSON keys.
const std::vector<std::string_view>& planHashExcludedFields();

hash::Digest planHash(const Plan& plan);

struct StaleEntity {
    model::EntityRef entity;
    model::DiffEntry::Change change = model::DiffEntry::Change::modified;

    friend bool operator==(const StaleEntity&, const StaleEntity&) = default;
};

// "<type>:<id>"
std::string entityKey(const model::EntityRef& ref);

// Code plan_stale. plan() is the hash of the stale plan (for partial approval,
// the sub-plan).
class PlanStaleError : public CommandError {
public:
    PlanStaleError(std::string planHashText, std::vector<StaleEntity> changed);

    const std::string& plan() const noexcept { return plan_; }
    const std::vector<StaleEntity>& changedEntities() const noexcept { return changed_; }
    std::vector<std::string> changedEntityKeys() const;

private:
    std::string plan_;
    std::vector<StaleEntity> changed_;
};

// Holds plans by hash text. Errors are CommandError: not_found (unknown plan
// or base revision), invalid_state, invalid_params, plan_stale
// (PlanStaleError), or the error of a failing step.
class PlanStore {
public:
    // Commits the steps as one plan revision and returns it.
    using Commit = std::function<const Revision&(std::vector<Command> steps, std::string actor, std::string time)>;

    // Prepares the steps at baseRevision, computes writeSet from their
    // declared effects and resolves readSet hashes there. The plan is stored
    // as validated. Submitting an identical plan returns the stored one.
    const Plan& submit(const History& history, std::vector<Command> steps, std::vector<model::EntityRef> readSet,
                       const std::string& baseRevision);

    // Entities of the read and write sets whose head hash differs from the
    // recorded one; empty means the plan is not stale.
    std::vector<StaleEntity> validate(const History& history, std::string_view planHashText) const;

    const Plan& approve(const History& history, std::string_view planHashText, std::string approvedBy,
                        std::string time);

    // See the spec for the order: the sub-plan is prepared at the base
    // revision first (invalid_params with the step index within the sub-plan,
    // nothing changes), then stored as validated, the original is rejected,
    // and the sub-plan is approved (PlanStaleError leaves it validated).
    const Plan& approvePartial(const History& history, std::string_view planHashText,
                               const std::vector<std::size_t>& stepIndexes, std::string approvedBy,
                               std::string time);

    const Plan& reject(std::string_view planHashText, std::string rejectedBy, std::string time, std::string note);

    // Re-runs the staleness check, then commits through history.commit (or the
    // given commit function, which the session uses for its journal).
    const Revision& apply(History& history, std::string_view planHashText, std::string actor, std::string time);
    const Revision& apply(const History& history, std::string_view planHashText, std::string actor,
                          std::string time, const Commit& commit);

    const Plan* find(std::string_view planHashText) const noexcept;
    std::size_t size() const noexcept { return plans_.size(); }

private:
    Plan& require(std::string_view planHashText);
    const Plan& store(Plan plan);
    void requireFresh(const History& history, const Plan& plan) const;

    std::map<std::string, Plan, std::less<>> plans_;
};

}  // namespace siann::command
