// The master entity through the protocol (m5b-engine-master, UI redesign E-11):
// master.set_gain through command.execute, its session.changed seen by a second
// connection, session.fetch, session.sync, session.undo, plan.preview and
// engine.capabilities.

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

Value setMaster(double milliDb) {
    return Value(Object{{"op", Value("master.set_gain")}, {"gainMilliDb", Value(milliDb)}});
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

TEST_CASE("master.set_gain through command.execute is one revision, published as master:master to a second connection",
          "[protocol][master]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    const std::size_t revisions = f.session.history().revisions().size();
    const auto before = f.head().envelope.documentHash;

    const Value result = f.commit(c, Array{setMaster(-6000)});
    CHECK(f.session.history().revisions().size() == revisions + 1);
    REQUIRE(at(at(result, "revision"), "diff").asArray().size() == 1);
    CHECK(at(at(result, "revision"), "diff").asArray()[0].asString() == "master:master");
    REQUIRE(f.head().document.master() != nullptr);
    CHECK(f.head().document.master()->gain.milliDb == -6000);

    const auto changed = eventsOfType(f, watcher, "session.changed");
    REQUIRE(changed.size() == 1);
    const auto& ids = at(changed[0], "changedIds").asArray();
    REQUIRE(ids.size() == 1);
    CHECK(at(ids[0], "ref").asString() == "master:master");
    CHECK(at(ids[0], "change").asString() == "added");
    CHECK(at(changed[0], "documentHash").asString() == hash::formatHash(f.head().envelope.documentHash));

    f.commit(c, Array{setMaster(-3000)});
    f.commit(c, Array{setMaster(0)});
    const auto again = eventsOfType(f, watcher, "session.changed");
    REQUIRE(again.size() == 3);
    CHECK(at(at(again[1], "changedIds").asArray()[0], "change").asString() == "modified");
    CHECK(at(at(again[2], "changedIds").asArray()[0], "change").asString() == "removed");
    CHECK(f.head().document.master() == nullptr);
    CHECK(f.head().envelope.documentHash == before);
    CHECK(at(again[2], "documentHash").asString() == hash::formatHash(before));
}

TEST_CASE("session.fetch and session.sync return the master entity; undo restores the previous gain",
          "[protocol][master]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const Value missing = f.ok(c, "session.fetch", Value(Object{{"refs", Value(Array{Value("master:master")})}}));
    CHECK(at(at(missing, "entities").asArray()[0], "missing").asBool());

    f.commit(c, Array{setMaster(-6000)});
    f.commit(c, Array{setMaster(-1500)});

    const Value fetched = f.ok(c, "session.fetch", Value(Object{{"refs", Value(Array{Value("master:master")})}}));
    const Value& entity = at(at(fetched, "entities").asArray()[0], "entity");
    CHECK(at(entity, "schema").asString() == "siann.entity.master.v1");
    CHECK(at(entity, "id").asString() == "master");
    CHECK(at(entity, "gainMilliDb").asNumber() == -1500);
    const Value other = f.ok(c, "session.fetch", Value(Object{{"refs", Value(Array{Value("master:other")})}}));
    CHECK(at(at(other, "entities").asArray()[0], "missing").asBool());

    const Value sync = f.ok(c, "session.sync");
    CHECK(at(sync, "entities").asNumber() == 2);  // root and master
    const Value& chunk = at(sync, "chunk");
    const Value& synced = at(chunk, "master");
    CHECK(synced.kind() == Value::Kind::object);
    CHECK(at(synced, "gainMilliDb").asNumber() == -1500);
    // The chunks concatenate to a v2 document with the head's hash.
    const model::Document document = model::Document::fromJson(
        Value(Object{{"schemaVersion", Value("siann.session_document.v2")},
                     {"root", at(chunk, "root")},
                     {"media", at(chunk, "media")},
                     {"tracks", at(chunk, "tracks")},
                     {"clips", at(chunk, "clips")},
                     {"master", synced}}));
    CHECK(hash::formatHash(document.documentHash()) == at(sync, "documentHash").asString());

    f.ok(c, "session.undo");
    REQUIRE(f.head().document.master() != nullptr);
    CHECK(f.head().document.master()->gain.milliDb == -6000);
    f.ok(c, "session.undo");
    CHECK(f.head().document.master() == nullptr);
    const Value none = f.ok(c, "session.sync");
    CHECK(at(none, "chunk").find("master") == nullptr);
    CHECK(at(none, "entities").asNumber() == 1);
}

TEST_CASE("A sync chunk boundary keeps the master after the locators", "[protocol][master]") {
    protocol::ServerOptions options = manualOptions();
    options.syncChunkEntities = 1;
    Fixture f(options);
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1"),
                      Value(Object{{"op", Value("session.set_locators")}, {"left", Value("1")}, {"right", Value("2")}}),
                      setMaster(-6000)});
    const Value first = f.ok(c, "session.sync");
    CHECK(at(first, "entities").asNumber() == 4);
    CHECK(at(first, "chunk").find("master") == nullptr);
    const Value second = f.ok(c, "session.sync", Value(Object{{"cursor", at(first, "next")}}));
    CHECK(at(second, "chunk").find("master") == nullptr);
    const Value third = f.ok(c, "session.sync", Value(Object{{"cursor", at(second, "next")}}));
    CHECK(at(at(third, "chunk"), "locators").kind() == Value::Kind::object);
    CHECK(at(third, "chunk").find("master") == nullptr);
    const Value fourth = f.ok(c, "session.sync", Value(Object{{"cursor", at(third, "next")}}));
    CHECK(at(fourth, "chunk").find("locators") == nullptr);
    CHECK(at(at(at(fourth, "chunk"), "master"), "gainMilliDb").asNumber() == -6000);
    CHECK(at(fourth, "next").kind() == Value::Kind::null);
}

TEST_CASE("plan.preview of master.set_gain shows before null on the first set and after null at 0 dB",
          "[protocol][master][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const Value plan = f.ok(c, "plan.submit", Value(Object{{"steps", Value(Array{setMaster(-6000)})}}));
    const std::string hash = at(plan, "hash").asString();
    REQUIRE(at(plan, "writeSet").asArray().size() == 1);
    CHECK(at(at(plan, "writeSet").asArray()[0], "type").asString() == "master");
    CHECK(at(at(plan, "writeSet").asArray()[0], "id").asString() == "master");

    const Value preview = f.ok(c, "plan.preview", Value(Object{{"plan", Value(hash)}}));
    const Value row = entityRow(preview, "master:master");
    CHECK(at(row, "before").kind() == Value::Kind::null);
    CHECK(at(at(row, "after"), "gainMilliDb").asNumber() == -6000);

    f.ok(c, "plan.approve", Value(Object{{"plan", Value(hash)}}));
    f.ok(c, "plan.apply", Value(Object{{"plan", Value(hash)}}));
    CHECK(f.head().document.master()->gain.milliDb == -6000);

    const Value back = f.ok(c, "plan.submit", Value(Object{{"steps", Value(Array{setMaster(0)})}}));
    const Value row2 = entityRow(f.ok(c, "plan.preview", Value(Object{{"plan", at(back, "hash")}})), "master:master");
    CHECK(at(at(row2, "before"), "gainMilliDb").asNumber() == -6000);
    CHECK(at(row2, "after").kind() == Value::Kind::null);
}

TEST_CASE("A master gain out of range answers invalid_gain, a malformed one invalid_params", "[protocol][master]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const std::string head = f.head().envelope.id;
    const auto execute = [&](Value command) {
        return f.call(c, "command.execute", Value(Object{{"commands", Value(Array{std::move(command)})}}));
    };
    CHECK(errorCode(execute(setMaster(24'001))) == "invalid_gain");
    CHECK(errorCode(execute(setMaster(-144'001))) == "invalid_gain");
    CHECK(errorCode(execute(setMaster(-0.5))) == "invalid_params");
    CHECK(errorCode(execute(Value(Object{{"op", Value("master.set_gain")}, {"gainMilliDb", Value("-6000")}}))) ==
          "invalid_params");
    CHECK(errorCode(execute(Value(Object{{"op", Value("master.set_gain")},
                                         {"gainMilliDb", Value(-6000)},
                                         {"trackId", Value("trk_1")}}))) == "invalid_params");
    CHECK(f.head().envelope.id == head);
}

TEST_CASE("engine.capabilities lists master.set_gain and features.masterGain", "[protocol][master]") {
    Fixture f;
    const Value capabilities = f.ok(f.authed(), "engine.capabilities");
    CHECK(at(at(capabilities, "features"), "masterGain").asBool());
    bool listed = false;
    for (const Value& name : at(capabilities, "commands").asArray()) {
        listed = listed || name.asString() == "master.set_gain";
    }
    CHECK(listed);
}
