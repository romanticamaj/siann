// Markers through the protocol (m5b-engine-markers, UI redesign E-8): the marker
// commands through command.execute, their session.changed seen by a second
// connection, session.sync and session.fetch, plan.submit and plan.preview,
// command.list and engine.capabilities.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "siann/hash/sha256.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;

namespace {

Value op(const std::string& name, std::vector<std::pair<std::string, Value>> fields) {
    Object out{{"op", Value(name)}};
    for (auto& field : fields) {
        out.emplace_back(std::move(field.first), std::move(field.second));
    }
    return Value(std::move(out));
}

Value markerAdd(const std::string& id, const std::string& position, std::vector<std::pair<std::string, Value>> extra = {}) {
    std::vector<std::pair<std::string, Value>> fields{{"markerId", Value(id)}, {"position", Value(position)}};
    for (auto& field : extra) {
        fields.push_back(std::move(field));
    }
    return op("marker.add", std::move(fields));
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

bool listsAll(const Value& names) {
    std::vector<std::string> found;
    for (const Value& name : names.asArray()) {
        found.push_back(name.asString());
    }
    for (const char* name : {"marker.add", "marker.move", "marker.rename", "marker.remove"}) {
        if (std::find(found.begin(), found.end(), name) == found.end()) {
            return false;
        }
    }
    return true;
}

}  // namespace

TEST_CASE("marker commands through command.execute reach a second connection as session.changed", "[protocol][markers]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    const std::size_t revisions = f.session.history().revisions().size();
    const auto before = f.head().envelope.documentHash;

    const Value result = f.commit(c, Array{markerAdd("mk_1", "48000", {{"name", Value("Intro")}})});
    CHECK(f.session.history().revisions().size() == revisions + 1);
    const auto& diff = at(at(result, "revision"), "diff").asArray();
    REQUIRE(diff.size() == 1);
    CHECK(diff[0].asString() == "marker:mk_1");
    REQUIRE(f.head().document.marker("mk_1") != nullptr);
    CHECK(f.head().document.marker("mk_1")->number == 1);

    const auto added = eventsOfType(f, watcher, "session.changed");
    REQUIRE(added.size() == 1);
    const auto& ids = at(added[0], "changedIds").asArray();
    REQUIRE(ids.size() == 1);
    CHECK(at(ids[0], "ref").asString() == "marker:mk_1");
    CHECK(at(ids[0], "change").asString() == "added");
    CHECK(at(added[0], "documentHash").asString() == hash::formatHash(f.head().envelope.documentHash));

    f.commit(c, Array{op("marker.move", {{"markerId", Value("mk_1")}, {"position", Value("96000")}})});
    f.commit(c, Array{op("marker.rename", {{"markerId", Value("mk_1")}, {"name", Value("Verse")}})});
    f.commit(c, Array{op("marker.remove", {{"markerId", Value("mk_1")}})});
    const auto all = eventsOfType(f, watcher, "session.changed");
    REQUIRE(all.size() == 4);
    for (std::size_t i = 1; i < 4; ++i) {
        const auto& changed = at(all[i], "changedIds").asArray();
        REQUIRE(changed.size() == 1);
        CHECK(at(changed[0], "ref").asString() == "marker:mk_1");
        CHECK(at(changed[0], "change").asString() == (i == 3 ? "removed" : "modified"));
    }
    CHECK(f.head().envelope.documentHash == before);
}

TEST_CASE("session.sync lists markers after the master; session.fetch returns marker:<id>", "[protocol][markers]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1"),
                      op("master.set_gain", {{"gainMilliDb", Value(-6000)}}),
                      markerAdd("mk_b", "96000", {{"length", Value("48000")}}),
                      markerAdd("mk_a", "0", {{"name", Value("Start")}})});
    const Value sync = f.ok(c, "session.sync");
    CHECK(at(sync, "entities").asNumber() == 5);  // root, track, master, two markers
    const Value& chunk = at(sync, "chunk");
    const auto& markers = at(chunk, "markers").asArray();
    REQUIRE(markers.size() == 2);
    CHECK(at(markers[0], "id").asString() == "mk_a");  // id order
    CHECK(at(markers[1], "id").asString() == "mk_b");
    CHECK(at(markers[0], "schema").asString() == "siann.entity.marker.v1");
    CHECK(at(markers[1], "length").asString() == "48000");
    // The chunks concatenate to a v4 document with the head's hash.
    const model::Document document = model::Document::fromJson(
        Value(Object{{"schemaVersion", Value("siann.session_document.v4")},
                     {"root", at(chunk, "root")},
                     {"media", at(chunk, "media")},
                     {"tracks", at(chunk, "tracks")},
                     {"clips", at(chunk, "clips")},
                     {"master", at(chunk, "master")},
                     {"markers", at(chunk, "markers")}}));
    CHECK(hash::formatHash(document.documentHash()) == at(sync, "documentHash").asString());
    CHECK(document.documentHash() == f.head().envelope.documentHash);

    const Value fetched = f.ok(
        c, "session.fetch", Value(Object{{"refs", Value(Array{Value("marker:mk_a"), Value("marker:mk_b"), Value("marker:mk_z")})}}));
    const auto& entities = at(fetched, "entities").asArray();
    REQUIRE(entities.size() == 3);
    CHECK(at(entities[0], "ref").asString() == "marker:mk_a");
    CHECK(at(at(entities[0], "entity"), "name").asString() == "Start");
    CHECK(at(at(entities[1], "entity"), "number").asNumber() == 1);
    CHECK(at(entities[2], "missing").asBool());

    // Without markers, the chunk has no markers member.
    Fixture bare;
    const Value empty = bare.ok(bare.authed(), "session.sync");
    CHECK(at(empty, "chunk").find("markers") == nullptr);
}

TEST_CASE("A sync chunk boundary keeps markers after every other entity", "[protocol][markers]") {
    protocol::ServerOptions options = manualOptions();
    options.syncChunkEntities = 2;
    Fixture f(options);
    const ConnectionId c = f.authed();
    f.commit(c, Array{markerAdd("mk_1", "0"), markerAdd("mk_2", "10"), markerAdd("mk_3", "20"),
                      op("master.set_gain", {{"gainMilliDb", Value(-1000)}})});
    const Value first = f.ok(c, "session.sync");  // root, master
    CHECK(at(first, "entities").asNumber() == 5);
    CHECK(at(first, "chunk").find("markers") == nullptr);
    CHECK(at(first, "chunk").find("master") != nullptr);
    const Value second = f.ok(c, "session.sync", Value(Object{{"cursor", at(first, "next")}}));
    CHECK(at(at(second, "chunk"), "markers").asArray().size() == 2);
    const Value third = f.ok(c, "session.sync", Value(Object{{"cursor", at(second, "next")}}));
    CHECK(at(at(third, "chunk"), "markers").asArray().size() == 1);
    CHECK(at(at(at(third, "chunk"), "markers").asArray()[0], "id").asString() == "mk_3");
    CHECK(at(third, "next").kind() == Value::Kind::null);
}

TEST_CASE("plan.preview shows a marker with before and after", "[protocol][markers][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const auto previewOf = [&](Value step) {
        const Value plan = f.ok(c, "plan.submit", Value(Object{{"steps", Value(Array{std::move(step)})}}));
        return std::make_pair(plan, f.ok(c, "plan.preview", Value(Object{{"plan", at(plan, "hash")}})));
    };
    const auto apply = [&](const Value& plan) {
        f.ok(c, "plan.approve", Value(Object{{"plan", at(plan, "hash")}}));
        f.ok(c, "plan.apply", Value(Object{{"plan", at(plan, "hash")}}));
    };

    // add: before null, after the entity.
    const auto [add, addPreview] = previewOf(markerAdd("mk_1", "48000", {{"name", Value("Intro")}}));
    REQUIRE(at(add, "writeSet").asArray().size() == 1);
    CHECK(at(at(add, "writeSet").asArray()[0], "type").asString() == "marker");
    CHECK(at(at(add, "writeSet").asArray()[0], "id").asString() == "mk_1");
    const Value addRow = entityRow(addPreview, "marker:mk_1");
    CHECK(at(addRow, "before").kind() == Value::Kind::null);
    CHECK(at(at(addRow, "after"), "position").asString() == "48000");
    CHECK(at(at(addRow, "after"), "number").asNumber() == 1);
    apply(add);
    REQUIRE(f.head().document.marker("mk_1") != nullptr);

    // move and rename: before and after.
    const auto [movePlan, movePreview] =
        previewOf(op("marker.move", {{"markerId", Value("mk_1")}, {"position", Value("96000")}}));
    const Value moveRow = entityRow(movePreview, "marker:mk_1");
    CHECK(at(at(moveRow, "before"), "position").asString() == "48000");
    CHECK(at(at(moveRow, "after"), "position").asString() == "96000");
    CHECK(at(at(moveRow, "after"), "name").asString() == "Intro");
    const auto [renamePlan, renamePreview] =
        previewOf(op("marker.rename", {{"markerId", Value("mk_1")}, {"name", Value("Verse")}}));
    const Value renameRow = entityRow(renamePreview, "marker:mk_1");
    CHECK(at(at(renameRow, "before"), "name").asString() == "Intro");
    CHECK(at(at(renameRow, "after"), "name").asString() == "Verse");

    // remove: after null.
    const auto [removePlan, removePreview] = previewOf(op("marker.remove", {{"markerId", Value("mk_1")}}));
    const Value removeRow = entityRow(removePreview, "marker:mk_1");
    CHECK(at(at(removeRow, "before"), "id").asString() == "mk_1");
    CHECK(at(removeRow, "after").kind() == Value::Kind::null);
    apply(removePlan);
    CHECK(f.head().document.marker("mk_1") == nullptr);
    (void)movePlan;
    (void)renamePlan;
}

TEST_CASE("Marker errors pass through command.execute and change nothing", "[protocol][markers]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{markerAdd("mk_1", "0", {{"number", Value(3)}})});
    const std::string head = f.head().envelope.id;
    const auto execute = [&](Value command) {
        return f.call(c, "command.execute", Value(Object{{"commands", Value(Array{std::move(command)})}}));
    };
    CHECK(errorCode(execute(markerAdd("mk_2", "0", {{"number", Value(3)}}))) == "marker_number_taken");
    CHECK(errorCode(execute(markerAdd("mk_1", "0"))) == "already_exists");
    CHECK(errorCode(execute(markerAdd("mk_2", "-1"))) == "invalid_marker");
    CHECK(errorCode(execute(markerAdd("mk_2", "0", {{"length", Value("0")}}))) == "invalid_marker");
    CHECK(errorCode(execute(op("marker.move", {{"markerId", Value("mk_9")}, {"position", Value("0")}}))) ==
          "not_found");
    CHECK(errorCode(execute(op("marker.move",
                               {{"markerId", Value("mk_1")}, {"position", Value("0")}, {"length", Value("5")}}))) ==
          "invalid_params");
    CHECK(f.head().envelope.id == head);
}

TEST_CASE("command.list and engine.capabilities list the marker commands; features.markers is true",
          "[protocol][markers]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const Value capabilities = f.ok(c, "engine.capabilities");
    CHECK(at(at(capabilities, "features"), "markers").asBool());
    CHECK(listsAll(at(capabilities, "commands")));
    const Value listed = f.ok(c, "command.list");
    CHECK(listsAll(at(listed, "commands")));
    for (const char* name : {"marker.add", "marker.move", "marker.rename", "marker.remove"}) {
        CHECK(at(listed, "cascades").find(name) == nullptr);
    }
}
