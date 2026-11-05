#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "siann/command/history.hpp"

using siann::command::Cause;
using siann::command::Command;
using siann::command::CommandError;
using siann::command::History;
using siann::command::Revision;
using siann::command::RollbackError;
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

Command setGain(const std::string& id, int milliDb) {
    return cmd(R"({"op":"track.set_gain","trackId":")" + id + R"(","gainMilliDb":)" + std::to_string(milliDb) + "}");
}

Command addTrackAt(const std::string& id, int index) {
    return cmd(R"({"op":"track.add","trackId":")" + id + R"(","name":")" + id + R"(","channels":2,"index":)" +
               std::to_string(index) + "}");
}

Command rename(const std::string& name) {
    return cmd(R"({"op":"session.rename","name":")" + name + R"("})");
}

Command setTempo(int milliBpm) {
    return cmd(R"({"op":"session.set_tempo","tempo":[{"ticks":"0","milliBpm":)" + std::to_string(milliBpm) + "}]}");
}

Command removeTrack(const std::string& id) {
    return cmd(R"({"op":"track.remove","trackId":")" + id + R"("})");
}

Command addMedia(const std::string& id) {
    return cmd(R"({"op":"media.add","mediaId":")" + id + R"(","contentHash":"sha256:)" + std::string(64, 'b') +
               R"(","format":"wav","channels":2,"sampleRate":48000,"frames":"48000"})");
}

Command placeClip(const std::string& clipId, const std::string& trackId, const std::string& mediaId) {
    return cmd(R"({"op":"clip.place","clipId":")" + clipId + R"(","trackId":")" + trackId + R"(","mediaId":")" +
               mediaId + R"(","position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"4800"})");
}

const EntityRef kRoot{EntityType::root, "root"};

EntityRef trackRef(const std::string& id) {
    return EntityRef{EntityType::track, id};
}

EntityRef mediaRef(const std::string& id) {
    return EntityRef{EntityType::media, id};
}

std::vector<EntityRef> refsOf(const std::vector<DiffEntry>& diff) {
    std::vector<EntityRef> out;
    for (const DiffEntry& entry : diff) {
        out.push_back(entry.entity);
    }
    return out;
}

bool contains(const std::vector<EntityRef>& refs, const EntityRef& ref) {
    return std::find(refs.begin(), refs.end(), ref) != refs.end();
}

// Runs rollback and returns the RollbackError's conflicts; fails the test when
// it does not throw rollback_conflict. The history must stay unchanged.
std::vector<EntityRef> rollbackConflicts(History& history, const std::string& planRevision) {
    const std::size_t count = history.revisions().size();
    const std::string headId = history.head().envelope.id;
    const bool couldUndo = history.canUndo();
    const bool couldRedo = history.canRedo();
    std::vector<EntityRef> conflicts;
    try {
        history.rollback(planRevision, "user", "t");
        FAIL("expected rollback_conflict");
    } catch (const RollbackError& error) {
        CHECK(error.code() == "rollback_conflict");
        conflicts = error.conflicts();
    }
    CHECK(history.revisions().size() == count);
    CHECK(history.head().envelope.id == headId);
    CHECK(history.canUndo() == couldUndo);
    CHECK(history.canRedo() == couldRedo);
    return conflicts;
}

std::string errorCodeOf(History& history, const std::string& id) {
    try {
        history.rollback(id, "user", "t");
    } catch (const RollbackError&) {
        return "rollback_conflict";
    } catch (const CommandError& error) {
        return error.code();
    }
    return "none";
}

History fresh() {
    return History(Document::create("Song", 48'000), "test", "2026-10-21T00:00:00Z");
}

std::vector<std::string> ids(const History& history) {
    std::vector<std::string> out;
    for (const Revision& r : history.revisions()) {
        out.push_back(r.envelope.id);
    }
    return out;
}

}  // namespace

TEST_CASE("The first revision records the initial document", "[history]") {
    const History history = fresh();
    const Revision& head = history.head();
    CHECK(head.envelope.id == "r1");
    CHECK(head.envelope.parents.empty());
    CHECK(head.envelope.cause == Cause::create);
    CHECK(head.envelope.documentHash == head.document.documentHash());
    CHECK_FALSE(history.canUndo());
}

TEST_CASE("Commits chain revisions with diffs and envelope data", "[history]") {
    History history = fresh();
    const Revision& r2 = history.commit({addTrack("trk_1")}, "agent", "2026-10-21T00:00:01Z");
    CHECK(r2.envelope.id == "r2");
    CHECK(r2.envelope.parents == std::vector<std::string>{"r1"});
    CHECK(r2.envelope.cause == Cause::command);
    CHECK(r2.envelope.actor == "agent");
    CHECK(r2.envelope.time == "2026-10-21T00:00:01Z");
    CHECK(r2.commands.size() == 1);
    CHECK(r2.diff.size() == 2);  // root and the new track
    CHECK(r2.envelope.documentHash == r2.document.documentHash());

    const Revision& r3 = history.commit({addTrack("trk_2"), setGain("trk_2", -600)}, "agent", "t", Cause::plan);
    CHECK(r3.envelope.cause == Cause::plan);
    CHECK(r3.document.track("trk_2")->gain.milliDb == -600);
}

TEST_CASE("A failed commit leaves the head unchanged", "[history]") {
    History history = fresh();
    history.commit({addTrack("trk_1")}, "a", "t");
    const auto headId = history.head().envelope.id;
    CHECK_THROWS_AS(history.commit({setGain("trk_missing", 0)}, "a", "t"), CommandError);
    CHECK(history.head().envelope.id == headId);
    CHECK(history.revisions().size() == 2);
}

TEST_CASE("Undo and redo create revisions that restore earlier documents", "[history]") {
    History history = fresh();
    const auto h1 = history.head().envelope.documentHash;
    history.commit({addTrack("trk_1")}, "a", "t");
    const auto h2 = history.head().envelope.documentHash;
    history.commit({setGain("trk_1", -1200)}, "a", "t");
    const auto h3 = history.head().envelope.documentHash;

    const Revision& u1 = history.undo("user", "t");
    CHECK(u1.envelope.id == "r4");
    CHECK(u1.envelope.cause == Cause::undo);
    CHECK(u1.target == std::optional<std::string>{"r3"});
    CHECK(u1.envelope.parents == std::vector<std::string>{"r3"});
    CHECK(u1.envelope.documentHash == h2);
    CHECK(u1.diff.size() == 1);

    CHECK(history.undo("user", "t").envelope.documentHash == h1);
    CHECK_FALSE(history.canUndo());
    CHECK_THROWS_AS(history.undo("user", "t"), CommandError);

    const Revision& r1 = history.redo("user", "t");
    CHECK(r1.envelope.cause == Cause::redo);
    CHECK(r1.target == std::optional<std::string>{"r2"});
    CHECK(r1.envelope.documentHash == h2);
    CHECK(history.redo("user", "t").envelope.documentHash == h3);
    CHECK_FALSE(history.canRedo());
    CHECK_THROWS_AS(history.redo("user", "t"), CommandError);
}

TEST_CASE("A new commit after undo clears redo", "[history]") {
    History history = fresh();
    history.commit({addTrack("trk_1")}, "a", "t");
    history.undo("a", "t");
    CHECK(history.canRedo());
    history.commit({addTrack("trk_2")}, "a", "t");
    CHECK_FALSE(history.canRedo());
    CHECK(history.head().document.track("trk_1") == nullptr);
    CHECK(history.head().document.track("trk_2") != nullptr);
}

TEST_CASE("Replaying the same operations reproduces revisions exactly", "[history]") {
    auto run = [] {
        History history = fresh();
        history.commit({addTrack("trk_1")}, "a", "t1");
        history.commit({addTrack("trk_2"), setGain("trk_2", -300)}, "a", "t2", Cause::plan);
        history.undo("a", "t3");
        history.commit({setGain("trk_1", -900)}, "a", "t4");
        history.undo("a", "t5");
        history.redo("a", "t6");
        history.commit({addTrack("trk_3")}, "a", "t7", Cause::plan);
        history.rollback("r8", "a", "t8");
        return history;
    };
    const History a = run();
    const History b = run();
    REQUIRE(a.revisions().size() == b.revisions().size());
    CHECK(ids(a) == std::vector<std::string>{"r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"});
    CHECK(a.head().envelope.cause == Cause::rollback);
    CHECK(a.head().target == std::optional<std::string>{"r8"});
    for (std::size_t i = 0; i < a.revisions().size(); ++i) {
        INFO("revision " << i);
        CHECK(a.revisions()[i].envelope.documentHash == b.revisions()[i].envelope.documentHash);
        CHECK(a.revisions()[i].envelope.parents == b.revisions()[i].envelope.parents);
        CHECK(a.revisions()[i].target == b.revisions()[i].target);
    }
    CHECK(a.head().document.track("trk_1")->gain.milliDb == -900);
    CHECK(a.head().document.track("trk_2") == nullptr);
}

TEST_CASE("Revisions can be found by id", "[history]") {
    History history = fresh();
    history.commit({addTrack("trk_1")}, "a", "t");
    REQUIRE(history.find("r2") != nullptr);
    CHECK(history.find("r2")->document.track("trk_1") != nullptr);
    CHECK(history.find("r9") == nullptr);
}

TEST_CASE("A throwing before-publish hook leaves the history unchanged", "[history]") {
    History history = fresh();
    history.commit({addTrack("trk_1")}, "a", "t");
    std::vector<std::string> seen;
    bool fail = true;
    history.setBeforePublish([&](const Revision& revision) {
        seen.push_back(revision.envelope.id);
        if (fail) {
            throw std::runtime_error("disk full");
        }
    });

    CHECK_THROWS_AS(history.commit({addTrack("trk_2")}, "a", "t"), std::runtime_error);
    CHECK_THROWS_AS(history.undo("a", "t"), std::runtime_error);
    CHECK(history.revisions().size() == 2);
    CHECK(history.canUndo());
    CHECK_FALSE(history.canRedo());
    CHECK(history.head().document.track("trk_2") == nullptr);

    fail = false;
    const Revision& r3 = history.commit({addTrack("trk_2")}, "a", "t", Cause::plan);
    CHECK(r3.envelope.id == "r3");
    CHECK(seen == std::vector<std::string>{"r3", "r3", "r3"});

    fail = true;
    CHECK_THROWS_AS(history.rollback("r3", "a", "t"), std::runtime_error);
    CHECK(history.revisions().size() == 3);
    CHECK(history.head().envelope.id == "r3");
    CHECK(history.head().document.track("trk_2") != nullptr);
    CHECK(history.canUndo());
    CHECK(seen == std::vector<std::string>{"r3", "r3", "r3", "r4"});

    fail = false;
    CHECK(history.rollback("r3", "a", "t").envelope.id == "r4");
}

TEST_CASE("Rolling back a plan with no later edits creates an inverse revision", "[history][rollback]") {
    History history = fresh();
    const auto h1 = history.head().envelope.documentHash;
    history.commit({addTrack("t1"), setGain("t1", -600)}, "agent", "t1", Cause::plan);
    CHECK(refsOf(siann::command::affectedEntities(*history.find("r2"))) ==
          std::vector<EntityRef>{kRoot, trackRef("t1")});

    const Revision& r3 = history.rollback("r2", "user", "t2");
    CHECK(r3.envelope.id == "r3");
    CHECK(r3.envelope.cause == Cause::rollback);
    CHECK(siann::command::causeName(Cause::rollback) == "rollback");
    CHECK(r3.target == std::optional<std::string>{"r2"});
    CHECK(r3.envelope.parents == std::vector<std::string>{"r2"});
    CHECK(r3.envelope.actor == "user");
    CHECK(r3.envelope.time == "t2");
    CHECK(r3.commands.empty());
    CHECK(r3.envelope.documentHash == h1);
    REQUIRE(r3.diff.size() == 2);
    CHECK(r3.diff[0].entity == kRoot);
    CHECK(r3.diff[0].change == DiffEntry::Change::modified);
    CHECK(r3.diff[1].entity == trackRef("t1"));
    CHECK(r3.diff[1].change == DiffEntry::Change::removed);
}

TEST_CASE("Rollback with unrelated later edits restores only the plan's entities", "[history][rollback]") {
    History history = fresh();
    history.commit({addTrack("t0")}, "a", "t");
    history.commit({addTrack("t1"), setGain("t1", -600)}, "agent", "t", Cause::plan);  // r3
    history.commit({setGain("t0", -300)}, "a", "t");                                    // r4

    const Revision& r5 = history.rollback("r3", "user", "t");
    CHECK(r5.envelope.id == "r5");
    CHECK(r5.document.track("t1") == nullptr);
    REQUIRE(r5.document.track("t0") != nullptr);
    CHECK(r5.document.track("t0")->gain.milliDb == -300);
    CHECK(r5.document.root().trackOrder == std::vector<std::string>{"t0"});
    for (std::size_t i = 0; i + 1 < history.revisions().size(); ++i) {
        INFO("revision " << i);
        CHECK(history.revisions()[i].envelope.documentHash != r5.envelope.documentHash);
    }
    CHECK(refsOf(r5.diff) == std::vector<EntityRef>{kRoot, trackRef("t1")});
    CHECK(r5.diff[1].change == DiffEntry::Change::removed);
    CHECK(r5.document.validate().empty());
}

TEST_CASE("Rollback restores a modified entity to its pre-plan value", "[history][rollback]") {
    History history = fresh();
    history.commit({addTrack("t0"), addTrack("t9"), addMedia("m1"), setGain("t0", -150)}, "a", "t");  // r2
    history.commit({setGain("t0", -600)}, "agent", "t", Cause::plan);                                 // r3
    history.commit({placeClip("c1", "t9", "m1")}, "a", "t");                                          // r4

    const Revision& r5 = history.rollback("r3", "user", "t");
    REQUIRE(r5.document.track("t0") != nullptr);
    CHECK(r5.document.track("t0")->gain.milliDb == -150);
    CHECK(r5.document.clip("c1") != nullptr);
    CHECK(refsOf(r5.diff) == std::vector<EntityRef>{trackRef("t0")});
    CHECK(r5.diff[0].change == DiffEntry::Change::modified);
}

TEST_CASE("Rollback is refused with rollback_conflict listing the changed entities", "[history][rollback]") {
    SECTION("an added entity changed afterwards") {
        History history = fresh();
        history.commit({addTrack("t1")}, "agent", "t", Cause::plan);  // r2
        history.commit({setGain("t1", -300)}, "a", "t");
        CHECK(rollbackConflicts(history, "r2") == std::vector<EntityRef>{trackRef("t1")});
    }
    SECTION("a root field the plan changed was changed afterwards") {
        History history = fresh();
        history.commit({rename("Plan name"), addTrack("t1")}, "agent", "t", Cause::plan);  // r2
        history.commit({rename("User name")}, "a", "t");
        CHECK(rollbackConflicts(history, "r2") == std::vector<EntityRef>{kRoot});
    }
    SECTION("the plan's tempo was changed afterwards") {
        History history = fresh();
        history.commit({setTempo(90'000)}, "agent", "t", Cause::plan);  // r2
        history.commit({setTempo(100'000)}, "a", "t");
        CHECK(rollbackConflicts(history, "r2") == std::vector<EntityRef>{kRoot});
    }
    SECTION("a removed entity exists again") {
        History history = fresh();
        history.commit({addTrack("t0")}, "a", "t");
        history.commit({removeTrack("t0")}, "agent", "t", Cause::plan);  // r3
        history.commit({addTrack("t0")}, "a", "t");
        CHECK(rollbackConflicts(history, "r3") == std::vector<EntityRef>{trackRef("t0")});
    }
    SECTION("the error lists every conflict sorted by <type>:<id>") {
        History history = fresh();
        history.commit({addTrack("t1"), addTrack("t2"), rename("Plan")}, "agent", "t", Cause::plan);  // r2
        history.commit({setGain("t2", -300), setGain("t1", -300), addTrack("t3"), rename("User")}, "a", "t");
        try {
            history.rollback("r2", "user", "t");
            FAIL("expected rollback_conflict");
        } catch (const RollbackError& error) {
            CHECK(error.conflictKeys() == std::vector<std::string>{"root:root", "track:t1", "track:t2"});
        }
    }
}

TEST_CASE("A later revision that references a plan-added entity is a conflict", "[history][rollback]") {
    SECTION("a clip on a plan-added track") {
        History history = fresh();
        history.commit({addMedia("m0")}, "a", "t");                   // r2
        history.commit({addTrack("t1")}, "agent", "t", Cause::plan);  // r3
        history.commit({placeClip("c1", "t1", "m0")}, "a", "t");      // r4
        CHECK(rollbackConflicts(history, "r3") == std::vector<EntityRef>{trackRef("t1")});
        CHECK(history.head().document.clip("c1") != nullptr);
    }
    SECTION("a clip on plan-added media") {
        History history = fresh();
        history.commit({addTrack("t0")}, "a", "t");                   // r2
        history.commit({addMedia("m1")}, "agent", "t", Cause::plan);  // r3
        history.commit({placeClip("c1", "t0", "m1")}, "a", "t");      // r4
        CHECK(rollbackConflicts(history, "r3") == std::vector<EntityRef>{mediaRef("m1")});
        CHECK(history.head().document.media("m1") != nullptr);
    }
}

TEST_CASE("A rolled back plan cannot be rolled back twice", "[history][rollback]") {
    History history = fresh();
    history.commit({addTrack("t0")}, "a", "t");                   // r2
    history.commit({addTrack("t1")}, "agent", "t", Cause::plan);  // r3
    history.rollback("r3", "user", "t");                          // r4
    const auto conflicts = rollbackConflicts(history, "r3");
    CHECK(contains(conflicts, trackRef("t1")));
}

TEST_CASE("Only plan revisions can be rolled back", "[history][rollback]") {
    History history = fresh();
    history.commit({addTrack("t0")}, "a", "t");                   // r2 command
    history.commit({addTrack("t1")}, "agent", "t", Cause::plan);  // r3 plan
    history.undo("a", "t");                                       // r4 undo
    const std::size_t count = history.revisions().size();
    CHECK(errorCodeOf(history, "r2") == "not_a_plan");
    CHECK(errorCodeOf(history, "r1") == "not_a_plan");
    CHECK(errorCodeOf(history, "r4") == "not_a_plan");
    CHECK(errorCodeOf(history, "r99") == "not_found");
    CHECK(history.revisions().size() == count);
}

TEST_CASE("Rollback is undoable like a commit and clears redo", "[history][rollback]") {
    History history = fresh();
    history.commit({addTrack("t1")}, "agent", "t", Cause::plan);  // r2
    history.commit({addTrack("t2")}, "a", "t");                   // r3
    history.undo("a", "t");                                       // r4, back to r2's document
    CHECK(history.canRedo());
    const auto before = history.head().envelope.documentHash;

    const Revision& rolled = history.rollback("r2", "user", "t");  // r5
    const auto rolledHash = rolled.envelope.documentHash;  // later appends may move revisions
    CHECK(rolled.document.track("t1") == nullptr);
    CHECK_FALSE(history.canRedo());

    const Revision& undone = history.undo("user", "t");
    CHECK(undone.target == std::optional<std::string>{"r5"});
    CHECK(undone.envelope.documentHash == before);
    CHECK(history.head().document.track("t1") != nullptr);
    const Revision& redone = history.redo("user", "t");
    CHECK(redone.envelope.documentHash == rolledHash);
}

// Root holds session fields and the track order. A plan owns only the root
// fields it changed and the order slots of the tracks it added or removed, so
// unrelated later edits to root do not block its rollback.
TEST_CASE("Unrelated later edits to root do not block rollback", "[history][rollback]") {
    SECTION("a later track add") {
        History history = fresh();
        history.commit({addTrack("t1")}, "agent", "t", Cause::plan);  // r2
        history.commit({addTrack("t2")}, "a", "t");                   // r3
        const Revision& r4 = history.rollback("r2", "user", "t");
        CHECK(r4.document.track("t1") == nullptr);
        CHECK(r4.document.track("t2") != nullptr);
        CHECK(r4.document.root().trackOrder == std::vector<std::string>{"t2"});
        CHECK(r4.document.validate().empty());
    }
    SECTION("a later track remove") {
        History history = fresh();
        history.commit({addTrack("t0")}, "a", "t");                   // r2
        history.commit({addTrack("t1")}, "agent", "t", Cause::plan);  // r3
        history.commit({removeTrack("t0")}, "a", "t");                // r4
        const Revision& r5 = history.rollback("r3", "user", "t");
        CHECK(r5.document.root().trackOrder.empty());
        CHECK(r5.document.validate().empty());
    }
    SECTION("a later session rename and tempo change") {
        History history = fresh();
        history.commit({addTrack("t1")}, "agent", "t", Cause::plan);  // r2
        history.commit({rename("Renamed"), setTempo(90'000)}, "a", "t");
        const Revision& r4 = history.rollback("r2", "user", "t");
        CHECK(r4.document.track("t1") == nullptr);
        CHECK(r4.document.root().name == "Renamed");
        CHECK(r4.document.root().tempo.front().milliBpm == 90'000);
        CHECK(r4.document.root().trackOrder.empty());
    }
    SECTION("several track-adding plans roll back in any order") {
        History history = fresh();
        history.commit({addTrack("t1")}, "agent", "t", Cause::plan);  // r2
        history.commit({addTrack("t2")}, "agent", "t", Cause::plan);  // r3
        history.rollback("r2", "user", "t");                          // r4
        CHECK(history.head().document.root().trackOrder == std::vector<std::string>{"t2"});
        history.rollback("r3", "user", "t");                          // r5
        CHECK(history.head().document.root().trackOrder.empty());
    }
}

TEST_CASE("Rollback keeps later root fields and restores only the plan's", "[history][rollback]") {
    History history = fresh();
    history.commit({rename("Plan"), addTrack("t1")}, "agent", "t", Cause::plan);  // r2
    history.commit({setTempo(90'000), addTrack("t2")}, "a", "t");                 // r3
    const Revision& r4 = history.rollback("r2", "user", "t");
    CHECK(r4.document.root().name == "Song");
    CHECK(r4.document.root().tempo.front().milliBpm == 90'000);
    CHECK(r4.document.root().trackOrder == std::vector<std::string>{"t2"});
}

TEST_CASE("Rolling back a track remove reinserts it after its old neighbour", "[history][rollback]") {
    SECTION("after the nearest earlier neighbour still present") {
        History history = fresh();
        history.commit({addTrack("a"), addTrack("b"), addTrack("c")}, "x", "t");  // r2
        history.commit({removeTrack("b")}, "agent", "t", Cause::plan);            // r3
        history.commit({addTrackAt("d", 1), addTrackAt("e", 0)}, "x", "t");       // r4: e a d c
        const Revision& r5 = history.rollback("r3", "user", "t");
        REQUIRE(r5.document.track("b") != nullptr);
        CHECK(r5.document.root().trackOrder == std::vector<std::string>{"e", "a", "b", "d", "c"});
        CHECK(r5.document.validate().empty());
    }
    SECTION("at the front when no earlier neighbour is left") {
        History history = fresh();
        history.commit({addTrack("a"), addTrack("b")}, "x", "t");       // r2
        history.commit({removeTrack("a")}, "agent", "t", Cause::plan);  // r3
        history.commit({addTrackAt("z", 0)}, "x", "t");                 // r4: z b
        const Revision& r5 = history.rollback("r3", "user", "t");
        CHECK(r5.document.root().trackOrder == std::vector<std::string>{"a", "z", "b"});
    }
}

// Proposal branches (architecture spec, "Revision DAG — single history",
// decisions of 2026-11-05).

namespace {

using siann::command::BranchId;
using siann::model::DiffEntry;
using siann::model::EntityRef;
using siann::model::EntityType;

// r2 adds trk_a, r3 adds trk_b: the base the branch tests start from.
History withTwoTracks() {
    History history = fresh();
    history.commit({addTrack("trk_a")}, "a", "t1");
    history.commit({addTrack("trk_b")}, "a", "t2");
    return history;
}

std::vector<EntityRef> diffEntities(const Revision& revision) {
    std::vector<EntityRef> out;
    for (const DiffEntry& entry : revision.diff) {
        out.push_back(entry.entity);
    }
    return out;
}

std::string errorCode(const std::function<void()>& action) {
    try {
        action();
    } catch (const CommandError& error) {
        return error.code();
    }
    return "no error";
}

}  // namespace

TEST_CASE("A proposal branch starts at a base revision and its commits do not move main", "[history][branch]") {
    History h = withTwoTracks();
    const std::string mainHead = h.head().envelope.id;
    const bool couldUndo = h.canUndo();

    const BranchId b = h.branch("r2");
    CHECK(b == "p1");
    CHECK(h.branches() == std::vector<BranchId>{"p1"});
    CHECK(h.branchHead(b).envelope.id == "r2");

    const Revision& r4 = h.commitOn(b, {setGain("trk_a", -600)}, "agent", "t3");
    CHECK(r4.envelope.id == "r4");
    CHECK(r4.envelope.parents == std::vector<std::string>{"r2"});
    CHECK(r4.envelope.cause == Cause::command);
    CHECK(r4.branch == std::optional<std::string>{"p1"});
    CHECK(r4.document.track("trk_a")->gain.milliDb == -600);
    CHECK(r4.document.track("trk_b") == nullptr);  // the branch starts at r2

    const Revision& r5 = h.commitOn(b, {addTrack("trk_c"), setGain("trk_c", -300)}, "agent", "t4", Cause::plan);
    CHECK(r5.envelope.parents == std::vector<std::string>{"r4"});
    CHECK(r5.envelope.cause == Cause::plan);

    CHECK(h.head().envelope.id == mainHead);
    CHECK(h.branchHead(b).envelope.id == "r5");
    CHECK(h.canUndo() == couldUndo);
    // Undo on main undoes main's last commit, never a branch commit.
    CHECK(h.undo("a", "t5").target == std::optional<std::string>{"r3"});
    CHECK(h.branchHead(b).envelope.id == "r5");

    CHECK(errorCode([&] { h.commitOn(b, {addTrack("trk_x")}, "a", "t", Cause::undo); }) == "invalid_params");
    CHECK(errorCode([&] { (void)h.branch("r99"); }) == "not_found");
    CHECK(errorCode([&] { (void)h.branch("r4"); }) == "invalid_params");  // not on main
}

TEST_CASE("Merging a proposal creates a branch-merge revision on main with two parents", "[history][branch]") {
    History h = withTwoTracks();
    const Revision preMerge = h.head();
    const BranchId b = h.branch(preMerge.envelope.id);
    h.commitOn(b, {addTrack("trk_c")}, "agent", "t3");
    h.commitOn(b, {setGain("trk_c", -900)}, "agent", "t4");
    const Revision tip = h.branchHead(b);

    const Revision& merged = h.merge(b, "user", "t5");
    CHECK(merged.envelope.cause == Cause::branchMerge);
    CHECK(siann::command::causeName(Cause::branchMerge) == "branch-merge");
    CHECK(merged.envelope.parents == std::vector<std::string>{preMerge.envelope.id, tip.envelope.id});
    CHECK(merged.envelope.documentHash == tip.envelope.documentHash);
    REQUIRE(merged.commands.size() == 2);
    CHECK(merged.commands[0].op() == "track.add");
    CHECK(merged.commands[1].op() == "track.set_gain");
    CHECK(merged.envelope.actor == "user");
    CHECK(h.head().envelope.id == merged.envelope.id);
    CHECK(h.branches().empty());
    CHECK(h.reachable(tip.envelope.id));

    const std::string mergedId = merged.envelope.id;  // the next revision may move `merged`
    const Revision& undone = h.undo("user", "t6");
    CHECK(undone.target == std::optional<std::string>{mergedId});
    CHECK(undone.envelope.documentHash == preMerge.envelope.documentHash);
    CHECK(h.redo("user", "t7").envelope.documentHash == tip.envelope.documentHash);
}

TEST_CASE("Merging when main changed unrelated entities keeps both", "[history][branch]") {
    History h = withTwoTracks();
    const BranchId b = h.branch("r3");
    h.commit({setGain("trk_a", -1200)}, "user", "t3");
    const Revision branchCommit = h.commitOn(b, {addTrack("trk_c")}, "agent", "t4");

    const Revision& merged = h.merge(b, "user", "t5");
    CHECK(merged.document.track("trk_a")->gain.milliDb == -1200);
    CHECK(merged.document.track("trk_c") != nullptr);
    CHECK(merged.envelope.parents == std::vector<std::string>{"r4", branchCommit.envelope.id});
    CHECK(diffEntities(merged) == diffEntities(branchCommit));
    CHECK(diffEntities(merged) ==
          std::vector<EntityRef>{EntityRef{EntityType::root, "root"}, EntityRef{EntityType::track, "trk_c"}});
}

TEST_CASE("Merging when main changed an entity the branch wrote is refused with branch_conflict",
          "[history][branch]") {
    History h = withTwoTracks();
    const BranchId b = h.branch("r3");
    h.commit({setGain("trk_a", -1200)}, "user", "t3");
    h.commitOn(b, {setGain("trk_a", -300)}, "agent", "t4");
    const std::string mainHead = h.head().envelope.id;
    const std::size_t count = h.revisions().size();

    try {
        h.merge(b, "user", "t5");
        FAIL("expected branch_conflict");
    } catch (const CommandError& error) {
        CHECK(error.code() == "branch_conflict");
        CHECK(std::string(error.what()).find("track:trk_a") != std::string::npos);
    }
    CHECK(h.head().envelope.id == mainHead);
    CHECK(h.revisions().size() == count);
    CHECK(h.branches() == std::vector<BranchId>{b});
    CHECK(h.branchHead(b).envelope.id == "r5");

    SECTION("an entity main removed counts as changed") {
        History g = withTwoTracks();
        const BranchId p = g.branch("r3");
        g.commit({cmd(R"({"op":"track.remove","trackId":"trk_b"})")}, "user", "t3");
        g.commitOn(p, {setGain("trk_b", -300)}, "agent", "t4");
        CHECK(errorCode([&] { g.merge(p, "user", "t5"); }) == "branch_conflict");
    }
    SECTION("an entity main added that the branch also adds counts as changed") {
        History g = withTwoTracks();
        const BranchId p = g.branch("r3");
        g.commit({addTrack("trk_c")}, "user", "t3");
        g.commitOn(p, {addTrack("trk_c")}, "agent", "t4");
        CHECK(errorCode([&] { g.merge(p, "user", "t5"); }) == "branch_conflict");
    }
    SECTION("a branch without commits cannot be merged") {
        History g = withTwoTracks();
        const BranchId p = g.branch("r3");
        CHECK(errorCode([&] { g.merge(p, "user", "t5"); }) == "empty_transaction");
        CHECK(g.branches() == std::vector<BranchId>{p});
    }
}

TEST_CASE("A merge whose commands reach entities the branch never wrote on main's head is refused",
          "[history][branch]") {
    // track.remove cascades to every clip on the track. On main the track has
    // a clip that did not exist at the base: re-running the branch's remove on
    // main's head would delete main's clip, an entity outside the write set.
    History h = withTwoTracks();
    h.commit({cmd(R"({"op":"media.add","mediaId":"med_1","contentHash":"sha256:)" + std::string(64, 'a') +
                  R"(","format":"wav","channels":2,"sampleRate":48000,"frames":"48000"})")},
             "a", "t3");
    const BranchId b = h.branch("r4");
    h.commitOn(b, {cmd(R"({"op":"track.remove","trackId":"trk_a"})")}, "agent", "t4");
    h.commit({cmd(R"({"op":"clip.place","clipId":"clp_main","trackId":"trk_a","mediaId":"med_1",)"
                  R"("position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"4800"})")},
             "user", "t5");
    REQUIRE(h.head().document.clip("clp_main") != nullptr);
    const std::string mainHead = h.head().envelope.id;
    const std::size_t count = h.revisions().size();

    try {
        h.merge(b, "user", "t6");
        FAIL("expected branch_conflict");
    } catch (const CommandError& error) {
        CHECK(error.code() == "branch_conflict");
        CHECK(std::string(error.what()).find("clip:clp_main") != std::string::npos);
    }
    CHECK(h.head().envelope.id == mainHead);
    CHECK(h.head().document.clip("clp_main") != nullptr);
    CHECK(h.revisions().size() == count);
    CHECK(h.branches() == std::vector<BranchId>{b});

    // Main removes its clip again: the merge reaches only the branch's entities.
    h.undo("user", "t7");
    const Revision& merged = h.merge(b, "user", "t8");
    CHECK(merged.document.track("trk_a") == nullptr);
    CHECK(diffEntities(merged) ==
          std::vector<EntityRef>{EntityRef{EntityType::root, "root"}, EntityRef{EntityType::track, "trk_a"}});
}

TEST_CASE("Merging also guards the entities passed in, as a proposed plan's read set", "[history][branch]") {
    History h = withTwoTracks();
    const BranchId b = h.branch("r3");
    h.commit({setGain("trk_b", -1200)}, "user", "t3");  // the branch never writes trk_b
    h.commitOn(b, {setGain("trk_a", -300)}, "agent", "t4");
    const std::vector<EntityRef> guarded{EntityRef{EntityType::track, "trk_b"}};
    const std::size_t count = h.revisions().size();

    try {
        h.merge(b, "user", "t5", guarded);
        FAIL("expected branch_conflict");
    } catch (const CommandError& error) {
        CHECK(error.code() == "branch_conflict");
        CHECK(std::string(error.what()).find("track:trk_b") != std::string::npos);
    }
    CHECK(h.revisions().size() == count);
    CHECK(h.branches() == std::vector<BranchId>{b});

    // Main undoes its change: the guarded entity is as it was at the base.
    h.undo("user", "t6");
    const Revision& merged = h.merge(b, "user", "t7", guarded);
    CHECK(merged.document.track("trk_a")->gain.milliDb == -300);

    SECTION("without the guard the write set alone decides") {
        History g = withTwoTracks();
        const BranchId p = g.branch("r3");
        g.commit({setGain("trk_b", -1200)}, "user", "t3");
        g.commitOn(p, {setGain("trk_a", -300)}, "agent", "t4");
        CHECK(g.merge(p, "user", "t5").envelope.cause == Cause::branchMerge);
    }
}

TEST_CASE("Discarding a proposal leaves its revisions unreachable but present", "[history][branch]") {
    History h = withTwoTracks();
    const BranchId b = h.branch("r3");
    const std::string branchRev = h.commitOn(b, {addTrack("trk_c")}, "agent", "t3").envelope.id;
    CHECK_FALSE(h.reachable(branchRev));
    CHECK(h.reachable("r3"));
    CHECK(h.reachable("r1"));

    h.discard(b);
    REQUIRE(h.find(branchRev) != nullptr);
    CHECK(h.find(branchRev)->document.track("trk_c") != nullptr);
    CHECK_FALSE(h.reachable(branchRev));
    CHECK_FALSE(h.reachable("r99"));
    CHECK(h.branches().empty());
    CHECK(errorCode([&] { h.commitOn(b, {addTrack("trk_d")}, "a", "t"); }) == "not_found");
    CHECK(errorCode([&] { h.merge(b, "a", "t"); }) == "not_found");
    CHECK(errorCode([&] { h.discard(b); }) == "not_found");
    CHECK(errorCode([&] { (void)h.branchHead(b); }) == "not_found");

    // A later commit on main is unaffected, and the next branch gets a new id.
    h.commit({addTrack("trk_d")}, "user", "t4");
    CHECK(h.head().envelope.parents == std::vector<std::string>{"r3"});
    CHECK(h.branch("r5") == "p2");
}

TEST_CASE("Only one branch can be merged into a given main head per call; two open branches may coexist",
          "[history][branch]") {
    History h = withTwoTracks();
    const BranchId p1 = h.branch("r3");
    const BranchId p2 = h.branch("r3");
    CHECK(p1 != p2);
    h.commitOn(p1, {addTrack("trk_c")}, "agent", "t3");
    h.commitOn(p2, {setGain("trk_a", -600)}, "agent", "t4");
    CHECK(h.branches() == std::vector<BranchId>{p1, p2});

    h.merge(p1, "user", "t5");
    CHECK(h.branches() == std::vector<BranchId>{p2});
    CHECK(h.branchHead(p2).envelope.id == "r5");

    // p2 wrote only trk_a, which main has not changed since r3.
    const Revision& second = h.merge(p2, "user", "t6");
    CHECK(second.envelope.parents == std::vector<std::string>{"r6", "r5"});
    CHECK(second.document.track("trk_c") != nullptr);
    CHECK(second.document.track("trk_a")->gain.milliDb == -600);

    // Two branches that both add a track write root: the second conflicts (rule d).
    History g = withTwoTracks();
    const BranchId q1 = g.branch("r3");
    const BranchId q2 = g.branch("r3");
    g.commitOn(q1, {addTrack("trk_c")}, "agent", "t3");
    g.commitOn(q2, {addTrack("trk_d")}, "agent", "t4");
    g.merge(q1, "user", "t5");
    CHECK(errorCode([&] { g.merge(q2, "user", "t6"); }) == "branch_conflict");
}

TEST_CASE("Replaying branch, merge and discard reproduces revision ids, parents and hashes", "[history][branch]") {
    auto run = [] {
        History history = fresh();
        history.commit({addTrack("trk_a")}, "a", "t1");
        const BranchId p1 = history.branch("r2");
        history.commitOn(p1, {addTrack("trk_c")}, "a", "t2");
        history.commit({setGain("trk_a", -300)}, "a", "t3");
        const BranchId p2 = history.branch("r2");
        history.commitOn(p2, {addTrack("trk_d")}, "a", "t4");
        history.commitOn(p1, {setGain("trk_c", -600)}, "a", "t5", Cause::plan);
        history.merge(p1, "a", "t6");
        history.discard(p2);
        history.undo("a", "t7");
        history.redo("a", "t8");
        return history;
    };
    const History a = run();
    const History b = run();
    REQUIRE(a.revisions().size() == b.revisions().size());
    CHECK(ids(a) == std::vector<std::string>{"r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"});
    for (std::size_t i = 0; i < a.revisions().size(); ++i) {
        INFO("revision " << i);
        CHECK(a.revisions()[i].envelope.documentHash == b.revisions()[i].envelope.documentHash);
        CHECK(a.revisions()[i].envelope.parents == b.revisions()[i].envelope.parents);
        CHECK(a.revisions()[i].envelope.cause == b.revisions()[i].envelope.cause);
        CHECK(a.revisions()[i].branch == b.revisions()[i].branch);
    }
    CHECK(a.find("r7")->envelope.parents == std::vector<std::string>{"r4", "r6"});
    CHECK(a.head().document.track("trk_c")->gain.milliDb == -600);
    CHECK(a.head().document.track("trk_d") == nullptr);
    CHECK_FALSE(a.reachable("r5"));
    CHECK(a.reachable("r6"));

    SECTION("the replay entry points rebuild the same revisions from their records") {
        History replayed = fresh();
        for (std::size_t i = 1; i < a.revisions().size(); ++i) {
            const Revision& r = a.revisions()[i];
            const auto& e = r.envelope;
            if (e.cause == Cause::branchMerge) {
                replayed.mergeReplay(e.parents, r.commands, e.actor, e.time, r.branch);
            } else if (r.branch) {
                replayed.commitOnParent(*r.branch, e.parents.front(), r.commands, e.actor, e.time, e.cause);
            } else if (e.cause == Cause::undo) {
                replayed.undo(e.actor, e.time);
            } else if (e.cause == Cause::redo) {
                replayed.redo(e.actor, e.time);
            } else {
                replayed.commit(r.commands, e.actor, e.time, e.cause);
            }
        }
        REQUIRE(replayed.revisions().size() == a.revisions().size());
        for (std::size_t i = 0; i < a.revisions().size(); ++i) {
            INFO("revision " << i);
            CHECK(replayed.revisions()[i].envelope.id == a.revisions()[i].envelope.id);
            CHECK(replayed.revisions()[i].envelope.parents == a.revisions()[i].envelope.parents);
            CHECK(replayed.revisions()[i].envelope.documentHash == a.revisions()[i].envelope.documentHash);
            CHECK(replayed.revisions()[i].branch == a.revisions()[i].branch);
        }
        CHECK(replayed.head().envelope.id == a.head().envelope.id);
        CHECK_FALSE(replayed.reachable("r5"));
        // Open proposals do not survive a replay; new ids continue after p2.
        CHECK(replayed.branches().empty());
        CHECK(replayed.branch("r2") == "p3");
    }
}

// m3-mcp: a proposed plan lands through a branch-merge revision, and rolling
// back the plan rolls back that revision (diff against its first parent).
TEST_CASE("Rolling back a branch-merge revision creates an inverse revision", "[history][branch][rollback]") {
    History h = withTwoTracks();
    const Revision preMerge = h.head();
    const BranchId b = h.branch(preMerge.envelope.id);
    h.commitOn(b, {addTrack("trk_c"), setGain("trk_a", -600)}, "agent", "t3", Cause::plan);
    const std::string mergedId = h.merge(b, "user", "t4").envelope.id;

    const Revision& inverse = h.rollback(mergedId, "user", "t5");
    CHECK(inverse.envelope.cause == Cause::rollback);
    CHECK(inverse.target == std::optional<std::string>{mergedId});
    CHECK(inverse.envelope.parents == std::vector<std::string>{mergedId});
    CHECK(inverse.envelope.documentHash == preMerge.envelope.documentHash);
    CHECK(h.head().document.track("trk_c") == nullptr);
}

TEST_CASE("Rolling back a branch-merge revision after main changed one of its entities is rollback_conflict",
          "[history][branch][rollback]") {
    History h = withTwoTracks();
    const BranchId b = h.branch(h.head().envelope.id);
    h.commitOn(b, {addTrack("trk_c")}, "agent", "t3", Cause::plan);
    const std::string mergedId = h.merge(b, "user", "t4").envelope.id;
    h.commit({setGain("trk_c", -300)}, "user", "t5");

    CHECK(rollbackConflicts(h, mergedId) == std::vector<EntityRef>{EntityRef{EntityType::track, "trk_c"}});
}
