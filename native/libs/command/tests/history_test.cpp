#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

#include "siann/command/history.hpp"

using siann::command::Cause;
using siann::command::Command;
using siann::command::CommandError;
using siann::command::History;
using siann::command::Revision;
using siann::model::Document;

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
        return history;
    };
    const History a = run();
    const History b = run();
    REQUIRE(a.revisions().size() == b.revisions().size());
    CHECK(ids(a) == std::vector<std::string>{"r1", "r2", "r3", "r4", "r5", "r6", "r7"});
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
