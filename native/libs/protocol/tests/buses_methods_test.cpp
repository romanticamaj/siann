// Buses and sends through the protocol (m5b-engine-buses-sends, UR-10):
// engine.capabilities features, command.list cascades, the bus and send commands
// through command.execute seen by a second connection, session.sync chunks,
// session.fetch and plan.preview.

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

Value op(const std::string& name, Object fields) {
    Object out{{"op", Value(name)}};
    for (auto& field : fields) {
        out.push_back(std::move(field));
    }
    return Value(std::move(out));
}

Value busAdd(const std::string& id) {
    return op("bus.add", {{"busId", Value(id)}, {"name", Value("Bus " + id)}});
}

Value sendAdd(const std::string& id, const std::string& trackId, const std::string& busId) {
    return op("send.add", {{"sendId", Value(id)}, {"trackId", Value(trackId)}, {"busId", Value(busId)}});
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

std::vector<std::string> refsOf(const Value& changed) {
    std::vector<std::string> out;
    for (const Value& id : at(changed, "changedIds").asArray()) {
        out.push_back(at(id, "ref").asString() + "/" + at(id, "change").asString());
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

TEST_CASE("engine.capabilities lists features.buses and features.sends and the 14 commands", "[protocol][buses]") {
    Fixture f;
    const Value capabilities = f.ok(f.authed(), "engine.capabilities");
    CHECK(at(at(capabilities, "features"), "buses").asBool());
    CHECK(at(at(capabilities, "features"), "sends").asBool());
    std::vector<std::string> names;
    for (const Value& name : at(capabilities, "commands").asArray()) {
        names.push_back(name.asString());
    }
    for (const char* name : {"bus.add", "bus.remove", "bus.rename", "bus.set_gain", "bus.set_pan", "bus.set_mute",
                             "bus.set_solo", "bus.set_output", "send.add", "send.remove", "send.set_level",
                             "send.set_pre", "send.set_enabled", "track.set_output"}) {
        INFO(name);
        CHECK(std::find(names.begin(), names.end(), name) != names.end());
    }
}

TEST_CASE("command.list returns commands, still a string array, and cascades", "[protocol][buses]") {
    Fixture f;
    const Value listed = f.ok(f.authed(), "command.list");
    REQUIRE(listed.asObject().size() == 2);
    const auto& commands = at(listed, "commands").asArray();
    REQUIRE(commands.size() == command::commandNames().size());
    for (std::size_t i = 0; i < commands.size(); ++i) {
        CHECK(commands[i].asString() == command::commandNames()[i]);
    }
    const Value expected(Object{
        {"bus.remove", Value(Array{Value("bus"), Value("plugin_slot"), Value("root"), Value("send"), Value("track")})},
        {"track.remove", Value(Array{Value("clip"), Value("plugin_slot"), Value("root"), Value("send")})},
    });
    CHECK(canonical(at(listed, "cascades")) == canonical(expected));
}

TEST_CASE("bus and send commands through command.execute reach a second connection as session.changed",
          "[protocol][buses]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    f.commit(c, Array{trackAdd("trk_1")});
    const Value added = f.commit(c, Array{busAdd("b1"), sendAdd("s1", "trk_1", "b1")});
    const std::vector<Value> changed = eventsOfType(f, watcher, "session.changed");
    REQUIRE(changed.size() == 2);
    CHECK(refsOf(changed[1]) == std::vector<std::string>{"root:root/modified", "track:trk_1/modified",
                                                         "bus:b1/added", "send:s1/added"});
    (void)added;

    f.commit(c, Array{op("bus.remove", {{"busId", Value("b1")}})});
    const std::vector<Value> removed = eventsOfType(f, watcher, "session.changed");
    REQUIRE(removed.size() == 1);
    CHECK(refsOf(removed[0]) == std::vector<std::string>{"root:root/modified", "track:trk_1/modified",
                                                         "bus:b1/removed", "send:s1/removed"});
    // A cycle is refused with its own code and changes nothing.
    f.commit(c, Array{busAdd("b1"), busAdd("b2"), op("bus.set_output", {{"busId", Value("b1")},
                                                                       {"output", Value(Object{{"busId", Value("b2")}})}})});
    const std::string head = f.head().envelope.id;
    const Value refused = f.call(c, "command.execute",
                                 Value(Object{{"commands", Value(Array{op("bus.set_output",
                                                                          {{"busId", Value("b2")},
                                                                           {"output", Value(Object{{"busId", Value("b1")}})}})})}}));
    CHECK(errorCode(refused) == "routing_cycle");
    CHECK(f.head().envelope.id == head);
}

TEST_CASE("session.sync chunks carry buses and sends; session.fetch returns them", "[protocol][buses]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1"), busAdd("b1"), sendAdd("s1", "trk_1", "b1")});
    const Value sync = f.ok(c, "session.sync");
    const Value& chunk = at(sync, "chunk");
    REQUIRE(at(chunk, "buses").asArray().size() == 1);
    REQUIRE(at(chunk, "sends").asArray().size() == 1);
    CHECK(at(at(chunk, "buses").asArray()[0], "schema").asString() == "siann.entity.bus.v1");
    CHECK(at(at(chunk, "sends").asArray()[0], "schema").asString() == "siann.entity.send.v1");
    CHECK(at(sync, "entities").asNumber() == 4);  // root, track, bus, send
    const model::Document document = model::Document::fromJson(
        Value(Object{{"schemaVersion", Value("siann.session_document.v3")},
                     {"root", at(chunk, "root")},
                     {"media", at(chunk, "media")},
                     {"tracks", at(chunk, "tracks")},
                     {"clips", at(chunk, "clips")},
                     {"buses", at(chunk, "buses")},
                     {"sends", at(chunk, "sends")}}));
    CHECK(hash::formatHash(document.documentHash()) == at(sync, "documentHash").asString());

    const Value fetched =
        f.ok(c, "session.fetch", Value(Object{{"refs", Value(Array{Value("bus:b1"), Value("send:s1"), Value("bus:b9")})}}));
    const auto& entities = at(fetched, "entities").asArray();
    REQUIRE(entities.size() == 3);
    CHECK(at(at(entities[0], "entity"), "name").asString() == "Bus b1");
    CHECK(at(at(entities[1], "entity"), "trackId").asString() == "trk_1");
    CHECK(at(entities[2], "missing").asBool());

    // Without buses and sends the chunk has neither key, as before.
    Fixture bare;
    const Value empty = bare.ok(bare.authed(), "session.sync");
    CHECK(at(empty, "chunk").find("buses") == nullptr);
    CHECK(at(empty, "chunk").find("sends") == nullptr);
}

TEST_CASE("A sync chunk boundary splits buses and sends after the master", "[protocol][buses]") {
    protocol::ServerOptions options = manualOptions();
    options.syncChunkEntities = 2;
    Fixture f(options);
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1"), busAdd("b1"), busAdd("b2"), sendAdd("s1", "trk_1", "b1"),
                      op("master.set_gain", {{"gainMilliDb", Value(-6000)}})});
    // root, trk_1 | master, b1 | b2, s1
    const Value first = f.ok(c, "session.sync");
    CHECK(at(first, "chunk").find("buses") == nullptr);
    const Value second = f.ok(c, "session.sync", Value(Object{{"cursor", at(first, "next")}}));
    CHECK(at(second, "chunk").find("master") != nullptr);
    REQUIRE(at(at(second, "chunk"), "buses").asArray().size() == 1);
    CHECK(at(second, "chunk").find("sends") == nullptr);
    const Value third = f.ok(c, "session.sync", Value(Object{{"cursor", at(second, "next")}}));
    CHECK(at(at(third, "chunk"), "buses").asArray().size() == 1);
    CHECK(at(at(third, "chunk"), "sends").asArray().size() == 1);
    CHECK(at(third, "next").kind() == Value::Kind::null);
}

TEST_CASE("plan.preview shows buses and sends with before and after", "[protocol][buses][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1"), busAdd("b1")});
    const Value plan = f.ok(
        c, "plan.submit",
        Value(Object{{"steps", Value(Array{op("bus.set_gain", {{"busId", Value("b1")}, {"gainMilliDb", Value(-6000)}}),
                                           sendAdd("s1", "trk_1", "b1")})}}));
    const Value preview = f.ok(c, "plan.preview", Value(Object{{"plan", at(plan, "hash")}}));
    const Value bus = entityRow(preview, "bus:b1");
    CHECK(at(at(bus, "before"), "gainMilliDb").asNumber() == 0);
    CHECK(at(at(bus, "after"), "gainMilliDb").asNumber() == -6000);
    const Value send = entityRow(preview, "send:s1");
    CHECK(at(send, "before").kind() == Value::Kind::null);
    CHECK(at(at(send, "after"), "busId").asString() == "b1");

    f.ok(c, "plan.approve", Value(Object{{"plan", at(plan, "hash")}}));
    f.ok(c, "plan.apply", Value(Object{{"plan", at(plan, "hash")}}));
    const Value removal =
        f.ok(c, "plan.submit", Value(Object{{"steps", Value(Array{op("bus.remove", {{"busId", Value("b1")}})})}}));
    const Value removed = f.ok(c, "plan.preview", Value(Object{{"plan", at(removal, "hash")}}));
    CHECK(at(entityRow(removed, "bus:b1"), "after").kind() == Value::Kind::null);
    CHECK(at(entityRow(removed, "send:s1"), "after").kind() == Value::Kind::null);
    CHECK(at(at(entityRow(removed, "send:s1"), "before"), "levelMilliDb").asNumber() == 0);
}
