// The locators entity through the protocol (m5-ui-engine-loop-click, spec
// Protocol v0 item 26): session.set_locators through command.execute, its
// session.changed, session.fetch, session.sync, session.undo and plan.preview.

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <utility>
#include <vector>

#include "siann/hash/sha256.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;

namespace {

Value setLocators(const std::string& left, const std::string& right) {
    return Value(Object{{"op", Value("session.set_locators")}, {"left", Value(left)}, {"right", Value(right)}});
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

}  // namespace

TEST_CASE("session.set_locators through command.execute is one revision, published as locators:locators",
          "[protocol][locators]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    const std::size_t revisions = f.session.history().revisions().size();

    const Value result = f.commit(c, Array{setLocators("96000", "480000")});
    CHECK(f.session.history().revisions().size() == revisions + 1);
    CHECK(at(at(result, "revision"), "diff").asArray().size() == 1);
    CHECK(at(at(result, "revision"), "diff").asArray()[0].asString() == "locators:locators");
    REQUIRE(f.head().document.locators() != nullptr);
    CHECK(f.head().document.locators()->left == 96'000);

    const auto changed = eventsOfType(f, watcher, "session.changed");
    REQUIRE(changed.size() == 1);
    const auto& ids = at(changed[0], "changedIds").asArray();
    REQUIRE(ids.size() == 1);
    CHECK(at(ids[0], "ref").asString() == "locators:locators");
    CHECK(at(ids[0], "change").asString() == "added");
    CHECK(at(changed[0], "documentHash").asString() == hash::formatHash(f.head().envelope.documentHash));

    f.commit(c, Array{setLocators("0", "48000")});
    const auto again = eventsOfType(f, watcher, "session.changed");
    REQUIRE(again.size() == 2);
    CHECK(at(at(again[1], "changedIds").asArray()[0], "change").asString() == "modified");
}

TEST_CASE("session.fetch and session.sync return the locators entity; undo restores the previous pair",
          "[protocol][locators]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const Value missing = f.ok(c, "session.fetch", Value(Object{{"refs", Value(Array{Value("locators:locators")})}}));
    CHECK(at(at(missing, "entities").asArray()[0], "missing").asBool());

    f.commit(c, Array{setLocators("100", "200")});
    f.commit(c, Array{setLocators("300", "400")});

    const Value fetched = f.ok(c, "session.fetch", Value(Object{{"refs", Value(Array{Value("locators:locators")})}}));
    const Value& entity = at(at(fetched, "entities").asArray()[0], "entity");
    CHECK(at(entity, "schema").asString() == "siann.entity.locators.v1");
    CHECK(at(entity, "id").asString() == "locators");
    CHECK(at(entity, "left").asString() == "300");
    CHECK(at(entity, "right").asString() == "400");

    const Value sync = f.ok(c, "session.sync");
    CHECK(at(sync, "entities").asNumber() == 2);  // root and locators
    const Value& chunk = at(sync, "chunk");
    const Value& synced = at(chunk, "locators");
    CHECK(synced.kind() == Value::Kind::object);
    CHECK(at(synced, "left").asString() == "300");
    // The chunks concatenate to a v2 document with the head's hash.
    const model::Document document = model::Document::fromJson(
        Value(Object{{"schemaVersion", Value("siann.session_document.v2")},
                     {"root", at(chunk, "root")},
                     {"media", at(chunk, "media")},
                     {"tracks", at(chunk, "tracks")},
                     {"clips", at(chunk, "clips")},
                     {"locators", synced}}));
    CHECK(hash::formatHash(document.documentHash()) == at(sync, "documentHash").asString());

    f.ok(c, "session.undo");
    REQUIRE(f.head().document.locators() != nullptr);
    CHECK(f.head().document.locators()->left == 100);
    CHECK(f.head().document.locators()->right == 200);
    f.ok(c, "session.undo");
    CHECK(f.head().document.locators() == nullptr);
    const Value none = f.ok(c, "session.sync");
    CHECK(at(none, "chunk").find("locators") == nullptr);
}

TEST_CASE("A sync chunk boundary keeps the locators after the plugin slots", "[protocol][locators]") {
    protocol::ServerOptions options = manualOptions();
    options.syncChunkEntities = 1;
    Fixture f(options);
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1"), setLocators("1", "2")});
    const Value first = f.ok(c, "session.sync");
    CHECK(at(first, "entities").asNumber() == 3);
    CHECK(at(first, "chunk").find("locators") == nullptr);
    const Value second = f.ok(c, "session.sync", Value(Object{{"cursor", at(first, "next")}}));
    CHECK(at(second, "chunk").find("locators") == nullptr);
    const Value third = f.ok(c, "session.sync", Value(Object{{"cursor", at(second, "next")}}));
    CHECK(at(at(third, "chunk"), "locators").kind() == Value::Kind::object);
    CHECK(at(third, "next").kind() == Value::Kind::null);
}

TEST_CASE("plan.preview of a set_locators step shows the entity before and after", "[protocol][locators][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const Value plan =
        f.ok(c, "plan.submit", Value(Object{{"steps", Value(Array{setLocators("96000", "480000")})}}));
    const std::string hash = at(plan, "hash").asString();
    CHECK(at(at(plan, "writeSet").asArray()[0], "type").asString() == "locators");

    const Value preview = f.ok(c, "plan.preview", Value(Object{{"plan", Value(hash)}}));
    const Value row = entityRow(preview, "locators:locators");
    CHECK(at(row, "before").kind() == Value::Kind::null);
    CHECK(at(at(row, "after"), "left").asString() == "96000");
    CHECK(at(at(row, "after"), "right").asString() == "480000");

    f.commit(c, Array{setLocators("1", "2")});
    const Value plan2 = f.ok(c, "plan.submit", Value(Object{{"steps", Value(Array{setLocators("3", "4")})}}));
    const Value row2 = entityRow(f.ok(c, "plan.preview", Value(Object{{"plan", at(plan2, "hash")}})), "locators:locators");
    CHECK(at(at(row2, "before"), "left").asString() == "1");
    CHECK(at(at(row2, "after"), "left").asString() == "3");

    // Applied, the plan is one revision with the entity.
    f.ok(c, "plan.approve", Value(Object{{"plan", at(plan2, "hash")}}));
    f.ok(c, "plan.apply", Value(Object{{"plan", at(plan2, "hash")}}));
    CHECK(f.head().document.locators()->left == 3);
}

TEST_CASE("An invalid pair answers invalid_locators, a malformed one invalid_params", "[protocol][locators]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const std::string head = f.head().envelope.id;
    const auto execute = [&](Value command) {
        return f.call(c, "command.execute", Value(Object{{"commands", Value(Array{std::move(command)})}}));
    };
    CHECK(errorCode(execute(setLocators("200", "100"))) == "invalid_locators");
    CHECK(errorCode(execute(setLocators("100", "100"))) == "invalid_locators");
    CHECK(errorCode(execute(setLocators("-5", "100"))) == "invalid_locators");
    CHECK(errorCode(execute(Value(Object{{"op", Value("session.set_locators")},
                                         {"left", Value(1)},
                                         {"right", Value("100")}}))) == "invalid_params");
    CHECK(f.head().envelope.id == head);
    CHECK(errorCode(f.call(c, "plan.submit", Value(Object{{"steps", Value(Array{setLocators("9", "1")})}}))) ==
          "invalid_locators");
}

TEST_CASE("engine.capabilities lists session.set_locators and features.locators", "[protocol][locators]") {
    Fixture f;
    const Value capabilities = f.ok(f.authed(), "engine.capabilities");
    CHECK(at(at(capabilities, "features"), "locators").asBool());
    bool listed = false;
    for (const Value& name : at(capabilities, "commands").asArray()) {
        listed = listed || name.asString() == "session.set_locators";
    }
    CHECK(listed);
}
