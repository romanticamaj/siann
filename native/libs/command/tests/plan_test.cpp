#include <catch2/catch_test_macros.hpp>

#include <optional>
#include <string>
#include <vector>

#include "siann/command/history.hpp"
#include "siann/command/plan.hpp"

using siann::command::Cause;
using siann::command::Command;
using siann::command::CommandError;
using siann::command::EntitySnapshot;
using siann::command::History;
using siann::command::Plan;
using siann::command::PlanStaleError;
using siann::command::PlanState;
using siann::command::PlanStore;
using siann::command::Revision;
using siann::command::RollbackError;
using siann::command::planHash;
using siann::hash::formatHash;
using siann::model::DiffEntry;
using siann::model::Document;
using siann::model::EntityRef;
using siann::model::EntityType;

namespace {

Command cmd(const std::string& json) {
    return Command::fromJson(siann::json::parse(json));
}

Command addTrack(const std::string& id) {
    return cmd(R"({"op":"track.add","trackId":")" + id + R"(","name":")" + id + R"(","channels":2})");
}

Command removeTrack(const std::string& id) {
    return cmd(R"({"op":"track.remove","trackId":")" + id + R"("})");
}

Command setGain(const std::string& id, int milliDb) {
    return cmd(R"({"op":"track.set_gain","trackId":")" + id + R"(","gainMilliDb":)" + std::to_string(milliDb) + "}");
}

Command setPan(const std::string& id, int pan) {
    return cmd(R"({"op":"track.set_pan","trackId":")" + id + R"(","pan":)" + std::to_string(pan) + "}");
}

Command renameTrack(const std::string& id, const std::string& name) {
    return cmd(R"({"op":"track.rename","trackId":")" + id + R"(","name":")" + name + R"("})");
}

Command placeClip(const std::string& clipId, const std::string& trackId) {
    return cmd(R"({"op":"clip.place","clipId":")" + clipId + R"(","trackId":")" + trackId +
               R"(","mediaId":"m1","position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"4800"})");
}

const std::string kMediaHash = "sha256:" + std::string(64, 'a');

// r1 is the empty document, r2 adds tracks t1, t2, t3 and media m1.
History base() {
    History history(Document::create("Song", 48'000), "test", "2026-11-04T00:00:00Z");
    history.commit({addTrack("t1"), addTrack("t2"), addTrack("t3"),
                    cmd(R"({"op":"media.add","mediaId":"m1","contentHash":")" + kMediaHash +
                        R"(","format":"wav","channels":2,"sampleRate":48000,"frames":"48000"})")},
                   "test", "2026-11-04T00:00:01Z");
    return history;
}

EntityRef track(const std::string& id) {
    return EntityRef{EntityType::track, id};
}

const EntityRef kRoot{EntityType::root, "root"};

std::vector<EntityRef> refsOf(const std::vector<EntitySnapshot>& set) {
    std::vector<EntityRef> out;
    for (const EntitySnapshot& entry : set) {
        out.push_back(entry.ref);
    }
    return out;
}

std::vector<EntityRef> refsOf(const std::vector<DiffEntry>& diff) {
    std::vector<EntityRef> out;
    for (const DiffEntry& entry : diff) {
        out.push_back(entry.entity);
    }
    return out;
}

// Runs fn and returns the plan_stale error it throws.
template <typename Fn>
std::optional<PlanStaleError> staleError(Fn&& fn) {
    try {
        fn();
    } catch (const PlanStaleError& error) {
        return error;
    }
    return std::nullopt;
}

template <typename Fn>
std::string errorCode(Fn&& fn) {
    try {
        fn();
    } catch (const CommandError& error) {
        return error.code();
    }
    return "no error";
}

}  // namespace

TEST_CASE("Submit records readSet and writeSet hashes equal to entityHash at baseRevision", "[plan]") {
    History history = base();
    PlanStore store;
    const Document& doc = history.head().document;

    const Plan& gain = store.submit(history, {setGain("t1", -600)}, {}, "r2");
    CHECK(gain.state == PlanState::validated);
    CHECK(gain.baseRevision == "r2");
    CHECK(gain.readSet.empty());
    REQUIRE(gain.writeSet.size() == 1);
    CHECK(gain.writeSet[0].ref == track("t1"));
    CHECK(gain.writeSet[0].entityHash == std::optional{doc.entityHash(track("t1"))});
    REQUIRE(gain.hashText.has_value());
    CHECK(*gain.hashText == formatHash(planHash(gain)));
    CHECK(store.find(*gain.hashText) == &gain);

    const Plan& add = store.submit(history, {addTrack("t4")}, {track("t2")}, "r2");
    CHECK(refsOf(add.writeSet) == std::vector<EntityRef>{kRoot, track("t4")});
    CHECK(add.writeSet[0].entityHash == std::optional{doc.entityHash(kRoot)});
    CHECK_FALSE(add.writeSet[1].entityHash.has_value());
    REQUIRE(add.readSet.size() == 1);
    CHECK(add.readSet[0].ref == track("t2"));
    CHECK(add.readSet[0].entityHash == std::optional{doc.entityHash(track("t2"))});
    CHECK(*add.hashText != *gain.hashText);
}

TEST_CASE("Submit hashes against the base revision, not the head", "[plan]") {
    History history = base();
    const auto atBase = history.head().document.entityHash(track("t1"));
    history.commit({setGain("t1", -300)}, "user", "t");
    PlanStore store;
    const Plan& plan = store.submit(history, {setPan("t1", 500)}, {}, "r2");
    CHECK(plan.writeSet[0].entityHash == std::optional{atBase});
    CHECK_FALSE(store.validate(history, *plan.hashText).empty());
}

TEST_CASE("Submitting the same plan twice returns the stored plan", "[plan]") {
    History history = base();
    PlanStore store;
    const Plan& a = store.submit(history, {setGain("t1", -600)}, {}, "r2");
    const Plan& b = store.submit(history, {setGain("t1", -600)}, {}, "r2");
    CHECK(&a == &b);
    CHECK(store.size() == 1);
}

TEST_CASE("Steps that fail at baseRevision are refused at submit", "[plan]") {
    History history = base();
    PlanStore store;
    try {
        store.submit(history, {setGain("t1", -600), setGain("t9", 0)}, {}, "r2");
        FAIL("expected an error");
    } catch (const CommandError& error) {
        CHECK(error.code() == "not_found");
        CHECK(error.step() == 1);
    }
    CHECK(store.size() == 0);
}

TEST_CASE("An unrelated edit after submit does not make the plan stale", "[plan]") {
    History history = base();
    PlanStore store;
    const std::string hash = *store.submit(history, {setGain("t1", -600)}, {track("t2")}, "r2").hashText;

    history.commit({setPan("t3", 100)}, "user", "2026-11-04T00:01:00Z");
    CHECK(store.validate(history, hash).empty());

    const Plan& approved = store.approve(history, hash, "user", "2026-11-04T00:02:00Z");
    CHECK(approved.state == PlanState::approved);
    CHECK(approved.approvedBy == std::optional<std::string>{"user"});
    CHECK(approved.approvedAt == std::optional<std::string>{"2026-11-04T00:02:00Z"});

    const std::size_t before = history.revisions().size();
    const Revision& revision = store.apply(history, hash, "agent", "2026-11-04T00:03:00Z");
    CHECK(history.revisions().size() == before + 1);
    CHECK(revision.envelope.cause == Cause::plan);
    CHECK(revision.envelope.actor == "agent");
    CHECK(revision.commands.size() == 1);
    CHECK(refsOf(revision.diff) == refsOf(store.find(hash)->writeSet));
    CHECK(history.head().document.track("t1")->gain.milliDb == -600);

    const Plan* applied = store.find(hash);
    CHECK(applied->state == PlanState::applied);
    CHECK(applied->appliedRevision == std::optional{history.head().envelope.id});
}

TEST_CASE("A changed write entity returns plan_stale listing it", "[plan]") {
    History history = base();
    PlanStore store;
    const std::string hash = *store.submit(history, {setGain("t1", -600)}, {}, "r2").hashText;
    history.commit({setGain("t1", -300)}, "user", "t");

    const auto error = staleError([&] { store.approve(history, hash, "user", "t"); });
    REQUIRE(error.has_value());
    CHECK(error->code() == "plan_stale");
    CHECK(error->plan() == hash);
    CHECK(error->changedEntityKeys() == std::vector<std::string>{"track:t1"});
    REQUIRE(error->changedEntities().size() == 1);
    CHECK(error->changedEntities()[0].change == DiffEntry::Change::modified);
    CHECK(store.find(hash)->state == PlanState::validated);
    CHECK_FALSE(store.find(hash)->approvedBy.has_value());
}

TEST_CASE("A changed read entity returns plan_stale", "[plan]") {
    History history = base();
    PlanStore store;
    const std::string hash = *store.submit(history, {setGain("t1", -600)}, {track("t2")}, "r2").hashText;
    history.commit({renameTrack("t2", "Bass")}, "user", "t");

    const auto error = staleError([&] { store.approve(history, hash, "user", "t"); });
    REQUIRE(error.has_value());
    CHECK(error->changedEntityKeys() == std::vector<std::string>{"track:t2"});
    CHECK(store.find(hash)->state == PlanState::validated);
}

TEST_CASE("A removed entity is reported removed", "[plan]") {
    History history = base();
    PlanStore store;
    const std::string hash = *store.submit(history, {setGain("t2", -600)}, {}, "r2").hashText;
    history.commit({removeTrack("t2")}, "user", "t");

    const auto stale = store.validate(history, hash);
    REQUIRE(stale.size() == 1);
    CHECK(stale[0].entity == track("t2"));
    CHECK(stale[0].change == DiffEntry::Change::removed);
}

TEST_CASE("An entity the plan creates that now exists is stale", "[plan]") {
    History history = base();
    PlanStore store;
    const std::string hash = *store.submit(history, {addTrack("t4")}, {}, "r2").hashText;
    history.commit({addTrack("t4")}, "user", "t");

    const auto error = staleError([&] { store.approve(history, hash, "user", "t"); });
    REQUIRE(error.has_value());
    CHECK(error->changedEntityKeys() == std::vector<std::string>{"root:root", "track:t4"});
    CHECK(error->changedEntities()[0].change == DiffEntry::Change::modified);
    CHECK(error->changedEntities()[1].change == DiffEntry::Change::added);
}

TEST_CASE("Undo that restores the entity hash makes the plan valid again", "[plan]") {
    History history = base();
    PlanStore store;
    const std::string hash = *store.submit(history, {setGain("t1", -600)}, {}, "r2").hashText;
    history.commit({setGain("t1", -300)}, "user", "t");
    CHECK(store.validate(history, hash).size() == 1);

    history.undo("user", "t");
    CHECK(history.head().envelope.id == "r4");  // a new revision, not the base
    CHECK(store.validate(history, hash).empty());
    CHECK(store.approve(history, hash, "user", "t").state == PlanState::approved);
}

TEST_CASE("Approve then edit then apply re-validates", "[plan]") {
    History history = base();
    PlanStore store;
    const std::string hash = *store.submit(history, {setGain("t1", -600)}, {}, "r2").hashText;
    store.approve(history, hash, "user", "t");
    history.commit({setGain("t1", -300)}, "user", "t");
    const std::string headId = history.head().envelope.id;

    const auto error = staleError([&] { store.apply(history, hash, "agent", "t"); });
    REQUIRE(error.has_value());
    CHECK(error->changedEntityKeys() == std::vector<std::string>{"track:t1"});
    CHECK(history.head().envelope.id == headId);
    CHECK(store.find(hash)->state == PlanState::approved);
    CHECK_FALSE(store.find(hash)->appliedRevision.has_value());
}

TEST_CASE("Unknown baseRevision and unknown plans are not_found", "[plan]") {
    History history = base();
    PlanStore store;
    CHECK(errorCode([&] { store.submit(history, {setGain("t1", -600)}, {}, "r99"); }) == "not_found");
    const std::string missing = "sha256:" + std::string(64, 'b');
    CHECK(store.find(missing) == nullptr);
    CHECK(errorCode([&] { store.approve(history, missing, "user", "t"); }) == "not_found");
    CHECK(errorCode([&] { store.reject(missing, "user", "t", "no"); }) == "not_found");
    CHECK(errorCode([&] { store.apply(history, missing, "user", "t"); }) == "not_found");
}

TEST_CASE("Approving a rejected or applied plan is invalid_state", "[plan]") {
    History history = base();
    PlanStore store;
    const std::string rejected = *store.submit(history, {setGain("t1", -600)}, {}, "r2").hashText;
    const Plan& r = store.reject(rejected, "user", "2026-11-04T00:05:00Z", "not now");
    CHECK(r.state == PlanState::rejected);
    CHECK(r.rejectedBy == std::optional<std::string>{"user"});
    CHECK(r.rejectedAt == std::optional<std::string>{"2026-11-04T00:05:00Z"});
    CHECK(r.rejectionNote == std::optional<std::string>{"not now"});
    CHECK(errorCode([&] { store.approve(history, rejected, "user", "t"); }) == "invalid_state");
    CHECK(errorCode([&] { store.reject(rejected, "user", "t", ""); }) == "invalid_state");

    const std::string applied = *store.submit(history, {setGain("t2", -600)}, {}, "r2").hashText;
    CHECK(errorCode([&] { store.apply(history, applied, "agent", "t"); }) == "invalid_state");  // not approved
    store.approve(history, applied, "user", "t");
    CHECK(errorCode([&] { store.approve(history, applied, "user", "t"); }) == "invalid_state");
    store.apply(history, applied, "agent", "t");
    CHECK(errorCode([&] { store.approve(history, applied, "user", "t"); }) == "invalid_state");
    CHECK(errorCode([&] { store.apply(history, applied, "agent", "t"); }) == "invalid_state");
    CHECK(errorCode([&] { store.reject(applied, "user", "t", ""); }) == "invalid_state");
}

TEST_CASE("Partial approval creates a sub-plan with a new hash and parentPlan, the original is rejected",
          "[plan][partial]") {
    History history = base();
    PlanStore store;
    const std::string original =
        *store.submit(history, {setGain("t1", -600), setPan("t2", 300), renameTrack("t3", "Keys")}, {track("t2")}, "r2")
             .hashText;

    const Plan& sub = store.approvePartial(history, original, {0, 2}, "user", "2026-11-04T00:06:00Z");
    REQUIRE(sub.hashText.has_value());
    CHECK(*sub.hashText != original);
    CHECK(*sub.hashText == formatHash(planHash(sub)));
    CHECK(sub.parentPlan == std::optional{original});
    CHECK(sub.baseRevision == "r2");
    REQUIRE(sub.steps.size() == 2);
    CHECK(sub.steps[0].op() == "track.set_gain");
    CHECK(sub.steps[1].op() == "track.rename");
    CHECK(refsOf(sub.writeSet) == std::vector<EntityRef>{track("t1"), track("t3")});
    CHECK(refsOf(sub.readSet) == std::vector<EntityRef>{track("t2")});
    CHECK(sub.state == PlanState::approved);
    CHECK(sub.approvedBy == std::optional<std::string>{"user"});
    CHECK(store.find(*sub.hashText) == &sub);

    const Plan* parent = store.find(original);
    CHECK(parent->state == PlanState::rejected);
    CHECK(parent->rejectedBy == std::optional<std::string>{"user"});
    CHECK(parent->rejectedAt == std::optional<std::string>{"2026-11-04T00:06:00Z"});

    const Revision& revision = store.apply(history, *sub.hashText, "agent", "t");
    CHECK(refsOf(revision.diff) == std::vector<EntityRef>{track("t1"), track("t3")});
    CHECK(history.head().document.track("t2")->pan == 0);
}

TEST_CASE("A sub-plan whose steps depend on a dropped step fails with the step index and changes nothing",
          "[plan][partial]") {
    History history = base();
    PlanStore store;
    const std::string original = *store.submit(history, {addTrack("t5"), placeClip("c1", "t5")}, {}, "r2").hashText;

    try {
        store.approvePartial(history, original, {1}, "user", "t");
        FAIL("expected an error");
    } catch (const CommandError& error) {
        CHECK(error.code() == "invalid_params");
        CHECK(error.step() == 0);
    }
    CHECK(store.find(original)->state == PlanState::validated);
    CHECK(store.size() == 1);
}

TEST_CASE("A stale sub-plan returns plan_stale, is stored validated, and the original is still rejected",
          "[plan][partial]") {
    History history = base();
    PlanStore store;
    const std::string original =
        *store.submit(history, {setGain("t1", -600), setPan("t2", 300), renameTrack("t3", "Keys")}, {}, "r2").hashText;
    history.commit({setGain("t1", -300)}, "user", "t");

    const auto error = staleError([&] { store.approvePartial(history, original, {0, 1}, "user", "t"); });
    REQUIRE(error.has_value());
    CHECK(error->changedEntityKeys() == std::vector<std::string>{"track:t1"});
    CHECK(error->plan() != original);
    const Plan* sub = store.find(error->plan());
    REQUIRE(sub != nullptr);
    CHECK(sub->state == PlanState::validated);
    CHECK(sub->parentPlan == std::optional{original});
    CHECK(store.find(original)->state == PlanState::rejected);
}

TEST_CASE("Partial approval with every step or no step is invalid_params", "[plan][partial]") {
    History history = base();
    PlanStore store;
    const std::string original =
        *store.submit(history, {setGain("t1", -600), setPan("t2", 300), renameTrack("t3", "Keys")}, {}, "r2").hashText;

    using Indexes = std::vector<std::size_t>;
    for (const Indexes& indexes : {Indexes{}, Indexes{0, 1, 2}, Indexes{2, 0, 1}, Indexes{3}, Indexes{0, 0}}) {
        INFO("indexes " << indexes.size());
        CHECK(errorCode([&] { store.approvePartial(history, original, indexes, "user", "t"); }) == "invalid_params");
    }
    CHECK(store.find(original)->state == PlanState::validated);
    CHECK(store.size() == 1);
}

TEST_CASE("Partial approval of a plan that is not validated is invalid_state", "[plan][partial]") {
    History history = base();
    PlanStore store;
    const std::string original = *store.submit(history, {setGain("t1", -600), setPan("t2", 300)}, {}, "r2").hashText;
    store.reject(original, "user", "t", "");
    CHECK(errorCode([&] { store.approvePartial(history, original, {0}, "user", "t"); }) == "invalid_state");
}

namespace {

// Submits, approves and applies the steps at the head; returns the plan hash.
std::string appliedPlan(History& history, PlanStore& store, std::vector<Command> steps) {
    const std::string hash = *store.submit(history, std::move(steps), {}, history.head().envelope.id).hashText;
    store.approve(history, hash, "user", "t");
    store.apply(history, hash, "agent", "t");
    return hash;
}

}  // namespace

TEST_CASE("Rolling back an applied plan marks it rolled_back and returns the inverse revision",
          "[plan][rollback]") {
    History history = base();
    PlanStore store;
    const auto before = history.head().envelope.documentHash;
    const std::string hash = appliedPlan(history, store, {setGain("t1", -600), addTrack("t4")});
    const std::string appliedId = *store.find(hash)->appliedRevision;

    const Revision& revision = store.rollback(history, hash, "user", "t2");
    CHECK(revision.envelope.cause == Cause::rollback);
    CHECK(revision.target == std::optional{appliedId});
    CHECK(&revision == &history.head());
    CHECK(revision.envelope.documentHash == before);
    CHECK(store.find(hash)->state == PlanState::rolled_back);
    CHECK(store.find(hash)->appliedRevision == std::optional{appliedId});
}

TEST_CASE("A rollback conflict leaves the plan applied and lists the entities", "[plan][rollback]") {
    History history = base();
    PlanStore store;
    const std::string hash = appliedPlan(history, store, {setGain("t1", -600), addTrack("t4")});
    history.commit({setGain("t4", -300), setGain("t1", -900)}, "user", "t");
    const std::size_t count = history.revisions().size();

    try {
        store.rollback(history, hash, "user", "t");
        FAIL("expected rollback_conflict");
    } catch (const RollbackError& error) {
        CHECK(error.code() == "rollback_conflict");
        CHECK(error.conflictKeys() == std::vector<std::string>{"track:t1", "track:t4"});
    }
    CHECK(store.find(hash)->state == PlanState::applied);
    CHECK(history.revisions().size() == count);
}

TEST_CASE("Only an applied plan can be rolled back", "[plan][rollback]") {
    History history = base();
    PlanStore store;
    const std::string validated = *store.submit(history, {setGain("t1", -600)}, {}, "r2").hashText;
    const std::string approved = *store.submit(history, {setGain("t2", -600)}, {}, "r2").hashText;
    store.approve(history, approved, "user", "t");
    const std::string rejected = *store.submit(history, {setGain("t3", -600)}, {}, "r2").hashText;
    store.reject(rejected, "user", "t", "no");
    const std::string rolledBack = appliedPlan(history, store, {setPan("t1", 500)});
    store.rollback(history, rolledBack, "user", "t");
    const std::size_t count = history.revisions().size();

    for (const std::string& hash : {validated, approved, rejected, rolledBack}) {
        INFO(hash);
        CHECK(errorCode([&] { store.rollback(history, hash, "user", "t"); }) == "plan_not_applied");
    }
    CHECK(errorCode([&] { store.rollback(history, "sha256:" + std::string(64, '0'), "user", "t"); }) ==
          "not_found");
    CHECK(history.revisions().size() == count);
    CHECK(store.find(validated)->state == PlanState::validated);
    CHECK(store.find(approved)->state == PlanState::approved);
}

TEST_CASE("A proposed plan merged into main can be rolled back", "[plan][rollback][proposal]") {
    History history = base();
    PlanStore store;
    const std::string hash = *store.submit(history, {setGain("t1", -600), addTrack("t4")}, {}, "r2").hashText;
    store.approve(history, hash, "user", "t");
    const auto before = history.head().envelope.documentHash;
    const siann::command::BranchId branch = store.propose(hash, [&](const Plan& plan) {
        const siann::command::BranchId opened = history.branch(plan.baseRevision);
        history.commitOn(opened, plan.steps, "agent", "t", Cause::plan);
        return opened;
    });
    const std::string mergedId = history.merge(branch, "user", "t", store.guardedEntities(branch)).envelope.id;
    store.landProposal(branch, mergedId);
    REQUIRE(store.find(hash)->appliedRevision == std::optional{mergedId});

    const Revision& revision = store.rollback(history, hash, "user", "t2");
    CHECK(revision.envelope.cause == Cause::rollback);
    CHECK(revision.target == std::optional{mergedId});
    CHECK(revision.envelope.documentHash == before);
    CHECK(store.find(hash)->state == PlanState::rolled_back);
}
