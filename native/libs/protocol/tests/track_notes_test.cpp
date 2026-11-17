// A track's notes through the protocol (m5b-engine-track-notes, UI redesign
// UR-17): track.set_notes through command.execute, its session.changed seen by a
// second connection, session.fetch and session.undo, plan.submit / plan.preview /
// plan.propose / plan.apply, the error envelope and engine.capabilities.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "siann/command/command.hpp"
#include "siann/hash/sha256.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;

namespace {

const std::string kNotes = "Verse: double it.\n\xE5\x89\xAF\xE6\xAD\x8C louder\tkeep the breaths.";

Value setNotes(const std::string& trackId, Value notes) {
    return Value(Object{{"op", Value("track.set_notes")}, {"trackId", Value(trackId)}, {"notes", std::move(notes)}});
}

std::vector<Value> eventsOfType(const Harness& f, ConnectionId connection, const std::string& type) {
    std::vector<Value> out;
    for (Value& event : f.events(connection)) {
        if (at(event, "type").asString() == type) {
            out.push_back(std::move(event));
        }
    }
    return out;
}

Value entityRow(const Value& preview, const std::string& ref) {
    for (const Value& entry : at(preview, "entities").asArray()) {
        if (at(entry, "ref").asString() == ref) {
            return entry;
        }
    }
    FAIL("no preview row " << ref);
    return preview;
}

bool lists(const Value& names, const std::string& name) {
    const auto& array = names.asArray();
    return std::any_of(array.begin(), array.end(), [&](const Value& v) { return v.asString() == name; });
}

Value planParams(const std::string& plan) {
    return Value(Object{{"plan", Value(plan)}});
}

}  // namespace

TEST_CASE("track.set_notes through command.execute is one revision, published as track:<id> to a second connection",
          "[protocol][notes]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    f.commit(c, Array{trackAdd("trk_1")});
    const auto plain = f.head().envelope.documentHash;
    const std::size_t revisions = f.session.history().revisions().size();
    const std::size_t changedBefore = eventsOfType(f, watcher, "session.changed").size();

    const Value result = f.commit(c, Array{setNotes("trk_1", Value(kNotes))});
    CHECK(f.session.history().revisions().size() == revisions + 1);
    REQUIRE(at(at(result, "revision"), "diff").asArray().size() == 1);
    CHECK(at(at(result, "revision"), "diff").asArray()[0].asString() == "track:trk_1");
    REQUIRE(f.head().document.track("trk_1")->notes.has_value());
    CHECK(*f.head().document.track("trk_1")->notes == kNotes);

    const auto changed = eventsOfType(f, watcher, "session.changed");
    REQUIRE(changed.size() == changedBefore + 1);
    const auto& ids = at(changed.back(), "changedIds").asArray();
    REQUIRE(ids.size() == 1);
    CHECK(at(ids[0], "ref").asString() == "track:trk_1");
    CHECK(at(ids[0], "change").asString() == "modified");
    CHECK(at(changed.back(), "documentHash").asString() == hash::formatHash(f.head().envelope.documentHash));

    // session.fetch returns the entity with its notes byte for byte.
    const Value fetched = f.ok(c, "session.fetch", Value(Object{{"refs", Value(Array{Value("track:trk_1")})}}));
    CHECK(at(at(at(fetched, "entities").asArray()[0], "entity"), "notes").asString() == kNotes);

    // "" removes the field: the document hash returns to the one without notes.
    f.commit(c, Array{setNotes("trk_1", Value(""))});
    CHECK_FALSE(f.head().document.track("trk_1")->notes.has_value());
    CHECK(f.head().envelope.documentHash == plain);
    const auto again = eventsOfType(f, watcher, "session.changed");
    REQUIRE(again.size() == changedBefore + 2);
    CHECK(at(at(again.back(), "changedIds").asArray()[0], "change").asString() == "modified");

    // Undo brings the notes back, and undo again removes them.
    f.ok(c, "session.undo");
    CHECK(*f.head().document.track("trk_1")->notes == kNotes);
    f.ok(c, "session.undo");
    CHECK_FALSE(f.head().document.track("trk_1")->notes.has_value());
    CHECK(f.head().envelope.documentHash == plain);
}

TEST_CASE("Bad notes answer invalid_notes, malformed params invalid_params, and nothing is committed",
          "[protocol][notes]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1")});
    const std::string head = f.head().envelope.id;
    const auto execute = [&](Value command) {
        return f.call(c, "command.execute", Value(Object{{"commands", Value(Array{std::move(command)})}}));
    };
    const Value tooLong = execute(setNotes("trk_1", Value(std::string(16'385, 'a'))));
    CHECK(errorCode(tooLong) == "invalid_notes");
    CHECK(at(at(tooLong, "error"), "step").asNumber() == 0);
    CHECK(errorCode(execute(setNotes("trk_1", Value(nullptr)))) == "invalid_params");
    CHECK(errorCode(execute(setNotes("trk_1", Value(3)))) == "invalid_params");
    CHECK(errorCode(execute(Value(Object{{"op", Value("track.set_notes")}, {"trackId", Value("trk_1")}}))) ==
          "invalid_params");
    CHECK(errorCode(execute(setNotes("trk_9", Value("a")))) == "not_found");
    CHECK(f.head().envelope.id == head);
    execute(setNotes("trk_1", Value(std::string(16'384, 'a'))));
    CHECK(f.head().envelope.id != head);
}

TEST_CASE("A plan step with a bidi character in its notes answers invalid_notes with the step index",
          "[protocol][notes][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1")});
    const std::string head = f.head().envelope.id;
    const Value refused = f.call(
        c, "plan.submit",
        Value(Object{{"steps", Value(Array{setNotes("trk_1", Value("fine")),
                                           setNotes("trk_1", Value(std::string("rlo \xE2\x80\xAE txt")))})}}));
    CHECK(errorCode(refused) == "invalid_notes");
    CHECK(at(at(refused, "error"), "step").asNumber() == 1);
    // A control character other than tab, LF and CR through command.execute.
    const Value bell = f.call(c, "command.execute",
                              Value(Object{{"commands", Value(Array{setNotes("trk_1", Value(std::string("x\x07")))})}}));
    CHECK(errorCode(bell) == "invalid_notes");
    CHECK(f.head().envelope.id == head);
}

TEST_CASE("engine.capabilities and command.list list track.set_notes", "[protocol][notes]") {
    Fixture f;
    const ConnectionId c = f.authed();
    CHECK(lists(at(f.ok(c, "engine.capabilities"), "commands"), "track.set_notes"));
    CHECK(lists(at(f.ok(c, "command.list"), "commands"), "track.set_notes"));
    const auto names = command::commandNames();
    CHECK(std::count(names.begin(), names.end(), "track.set_notes") == 1);
}

TEST_CASE("plan.preview of track.set_notes shows the track without notes before and with them after",
          "[protocol][notes][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1")});
    const Value plan =
        f.ok(c, "plan.submit", Value(Object{{"steps", Value(Array{setNotes("trk_1", Value(kNotes))})}}));
    const std::string hash = at(plan, "hash").asString();
    REQUIRE(at(plan, "writeSet").asArray().size() == 1);
    CHECK(at(at(plan, "writeSet").asArray()[0], "type").asString() == "track");
    CHECK(at(at(plan, "writeSet").asArray()[0], "id").asString() == "trk_1");

    const Value row = entityRow(f.ok(c, "plan.preview", planParams(hash)), "track:trk_1");
    CHECK(at(row, "before").find("notes") == nullptr);
    CHECK(at(at(row, "after"), "notes").asString() == kNotes);

    const std::size_t revisions = f.session.history().revisions().size();
    f.ok(c, "plan.approve", planParams(hash));
    f.ok(c, "plan.apply", planParams(hash));
    CHECK(f.session.history().revisions().size() == revisions + 1);
    CHECK(*f.head().document.track("trk_1")->notes == kNotes);

    // A plan that removes them: the preview's after has no notes.
    const Value removal =
        f.ok(c, "plan.submit", Value(Object{{"steps", Value(Array{setNotes("trk_1", Value(""))})}}));
    const Value row2 = entityRow(f.ok(c, "plan.preview", planParams(at(removal, "hash").asString())), "track:trk_1");
    CHECK(at(at(row2, "before"), "notes").asString() == kNotes);
    CHECK(at(row2, "after").find("notes") == nullptr);
}

TEST_CASE("plan.propose of a track.set_notes step opens a branch and main keeps its notes", "[protocol][notes][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1")});
    const std::string mainHead = f.head().envelope.id;
    const Value plan =
        f.ok(c, "plan.submit", Value(Object{{"steps", Value(Array{setNotes("trk_1", Value(kNotes))})}}));
    const std::string hash = at(plan, "hash").asString();
    f.ok(c, "plan.approve", planParams(hash));
    const Value proposed = f.ok(c, "plan.propose", planParams(hash));
    CHECK(at(at(proposed, "revision"), "cause").asString() == "plan");
    CHECK(f.head().envelope.id == mainHead);
    CHECK_FALSE(f.head().document.track("trk_1")->notes.has_value());

    const Value merged = f.ok(c, "proposal.merge", Value(Object{{"branch", at(proposed, "branch")}}));
    CHECK(at(at(merged, "revision"), "cause").asString() == "branch-merge");
    CHECK(*f.head().document.track("trk_1")->notes == kNotes);
}
