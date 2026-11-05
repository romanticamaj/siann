// Gap detection, reconnects and chunked session.sync (m3-events-sync and the
// m3-exit-sync criterion), plus session.fetch. In-memory transport, one thread.

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "support/protocol_fixture.hpp"
#include "support/sync_client.hpp"
#include "siann/hash/sha256.hpp"

namespace json = siann::json;
using namespace siann::protocol::testing;
using siann::protocol::ConnectionId;
using siann::protocol::ServerOptions;

namespace {

std::string headHash(const Fixture& f) {
    return siann::hash::formatHash(f.head().envelope.documentHash);
}

void checkModelAtHead(const SyncClient& client, const Fixture& f) {
    CHECK(client.revision() == f.head().envelope.id);
    CHECK(client.documentHash() == headHash(f));
    CHECK(client.modelHash() == headHash(f));
}

// Chunk entities in order, as canonical JSON strings.
struct Concatenated {
    std::optional<Value> root;
    Array media;
    Array tracks;
    Array clips;

    void add(const Value& chunk) {
        if (const Value* r = chunk.find("root")) {
            REQUIRE_FALSE(root.has_value());
            root = *r;
        }
        for (const auto& e : at(chunk, "media").asArray()) {
            media.push_back(e);
        }
        for (const auto& e : at(chunk, "tracks").asArray()) {
            tracks.push_back(e);
        }
        for (const auto& e : at(chunk, "clips").asArray()) {
            clips.push_back(e);
        }
    }

    Value document() const {
        REQUIRE(root.has_value());
        return Value(Object{{"schemaVersion", Value("siann.session_document.v1")},
                            {"root", *root},
                            {"media", Value(media)},
                            {"tracks", Value(tracks)},
                            {"clips", Value(clips)}});
    }
};

std::size_t chunkSize(const Value& chunk) {
    return (chunk.find("root") != nullptr ? 1 : 0) + at(chunk, "media").asArray().size() +
           at(chunk, "tracks").asArray().size() + at(chunk, "clips").asArray().size();
}

Value cursorParams(const std::string& cursor) {
    return Value(Object{{"cursor", Value(cursor)}});
}

}  // namespace

TEST_CASE("a client that detects a gap syncs and continues", "[protocol][sync]") {
    ServerOptions options = manualOptions();
    options.events.outboxCapacity = 2;
    Fixture f(options);
    const ConnectionId operatorConnection = f.authed(false);
    f.commit(operatorConnection, Array{mediaAdd("med_1"), trackAdd("trk_0")});

    SyncClient client(f.transport, f.server, [&] { f.server.pump(); });
    client.connect();
    REQUIRE(client.syncs() == 1);
    checkModelAtHead(client, f);

    // Five commits while the client's socket is congested: two fit the outbox.
    f.transport.setBufferedAmount(*client.connection(), std::size_t{1} << 30);
    for (int i = 1; i <= 5; ++i) {
        f.commit(operatorConnection, Array{trackAdd("trk_" + std::to_string(i)),
                                           clipPlace("clp_" + std::to_string(i), "trk_" + std::to_string(i), "med_1",
                                                     i * 48'000)});
    }
    REQUIRE(f.server.events().dropped(*client.connection()) == 3);
    f.transport.setBufferedAmount(*client.connection(), 0);
    f.server.pump();
    client.poll();
    CHECK(client.gaps() == 0);
    CHECK(client.lastSeq() == 3);  // seq 1 was the first commit, before the client connected

    // The next event (seq 7) reveals the gap: the client syncs.
    f.commit(operatorConnection, Array{trackAdd("trk_6")});
    client.poll();
    CHECK(client.gaps() == 1);
    REQUIRE(client.syncs() == 2);
    const auto synced = client.lastSync();
    CHECK(synced.revision == f.head().envelope.id);
    CHECK(synced.seq >= 7);
    CHECK(synced.seq == f.server.events().position().seq);
    checkModelAtHead(client, f);
    CHECK(client.document().documentHash() == f.head().envelope.documentHash);

    // And continues from the read model: the next event applies without a sync.
    f.commit(operatorConnection, Array{clipRemove("clp_2"), trackAdd("trk_7")});
    client.poll();
    CHECK(client.syncs() == 2);
    CHECK(client.gaps() == 1);
    REQUIRE_FALSE(client.seqsApplied().empty());
    CHECK(client.seqsApplied().back() == synced.seq + 1);
    CHECK(client.lastSeq() == synced.seq + 1);
    checkModelAtHead(client, f);
    CHECK(client.document().clip("clp_2") == nullptr);
    CHECK(client.document().track("trk_7") != nullptr);
}

TEST_CASE("a reconnecting client resyncs", "[protocol][sync]") {
    Fixture f;
    const ConnectionId operatorConnection = f.authed(false);
    SyncClient client(f.transport, f.server, [&] { f.server.pump(); });
    client.connect();
    f.commit(operatorConnection, Array{trackAdd("trk_1")});
    client.poll();
    REQUIRE(client.lastSeq() == 1);
    REQUIRE(client.syncs() == 1);
    checkModelAtHead(client, f);

    // Two commits while the client is away.
    client.disconnect();
    f.commit(operatorConnection, Array{trackAdd("trk_2")});
    f.commit(operatorConnection, Array{mediaAdd("med_1"), clipPlace("clp_1", "trk_2", "med_1", 0)});

    client.connect();
    const Value& hello = client.hello();
    CHECK(at(hello, "seq").asString() == "3");
    CHECK(at(hello, "revision").asString() == f.head().envelope.id);
    CHECK(at(hello, "documentHash").asString() == headHash(f));
    CHECK(client.syncs() == 2);
    CHECK(client.lastSeq() == 3);
    checkModelAtHead(client, f);

    f.commit(operatorConnection, Array{trackAdd("trk_3")});
    client.poll();
    CHECK(client.syncs() == 2);
    CHECK(client.lastSeq() == 4);
    checkModelAtHead(client, f);

    // A reconnect that missed nothing does not sync.
    client.disconnect();
    client.connect();
    CHECK(client.syncs() == 2);
    CHECK(at(client.hello(), "seq").asString() == "4");
}

TEST_CASE("large sessions sync in chunks at one revision", "[protocol][sync]") {
    ServerOptions options = manualOptions();
    options.syncChunkEntities = 4;
    Fixture f(options);
    const ConnectionId connection = f.authed(false);
    Array commands{mediaAdd("med_1")};
    for (int t = 0; t < 10; ++t) {
        commands.push_back(trackAdd("trk_" + std::to_string(t)));
    }
    for (int c = 0; c < 20; ++c) {
        commands.push_back(clipPlace("clp_" + std::to_string(c), "trk_" + std::to_string(c % 10), "med_1", c * 48'000));
    }
    f.commit(connection, commands);
    const auto pinned = f.head();
    const std::size_t total = 1 + 1 + 10 + 20;  // root, media, tracks, clips
    const std::size_t expectedChunks = (total + 3) / 4;

    Concatenated all;
    std::vector<std::string> cursors;
    std::optional<std::string> cursor;
    std::size_t chunks = 0;
    for (;;) {
        const Value result = f.ok(connection, "session.sync", cursor ? cursorParams(*cursor) : Value(Object{}));
        ++chunks;
        CHECK(at(result, "revision").asString() == pinned.envelope.id);
        CHECK(at(result, "documentHash").asString() == siann::hash::formatHash(pinned.envelope.documentHash));
        CHECK(at(result, "entities").asNumber() == static_cast<double>(total));
        CHECK(at(result, "seq").kind() == Value::Kind::string);
        const Value& chunk = at(result, "chunk");
        CHECK(chunkSize(chunk) <= 4);
        CHECK(chunkSize(chunk) >= 1);
        all.add(chunk);
        if (chunks == 2) {
            // A commit in the middle does not change the remaining chunks.
            f.commit(connection, Array{trackAdd("trk_late"), clipRemove("clp_19")});
        }
        const Value& next = at(result, "next");
        if (next.isNull()) {
            break;
        }
        REQUIRE(next.kind() == Value::Kind::string);
        cursor = next.asString();
        cursors.push_back(*cursor);
        REQUIRE(chunks < 100);
    }
    CHECK(chunks == expectedChunks);
    CHECK(cursors.size() == expectedChunks - 1);

    // The chunks are Document::toJson() of the pinned revision, entity by entity.
    const Value expected = pinned.document.toJson();
    const Value got = all.document();
    CHECK(canonical(at(got, "root")) == canonical(at(expected, "root")));
    for (const char* table : {"media", "tracks", "clips"}) {
        const auto& g = at(got, table).asArray();
        const auto& e = at(expected, table).asArray();
        REQUIRE(g.size() == e.size());
        for (std::size_t i = 0; i < g.size(); ++i) {
            CHECK(canonical(g[i]) == canonical(e[i]));
        }
    }
    const auto parsed = siann::model::Document::fromJson(got);
    CHECK(parsed.documentHash() == pinned.envelope.documentHash);
    CHECK(parsed.track("trk_late") == nullptr);
    CHECK(parsed.clip("clp_19") != nullptr);

    // A cursor of this sync stays usable until a new sync starts.
    const Value again = f.ok(connection, "session.sync", cursorParams(cursors[1]));
    CHECK(at(again, "revision").asString() == pinned.envelope.id);

    // A new sync pins the new head; the old cursors are stale.
    const Value fresh = f.ok(connection, "session.sync");
    CHECK(at(fresh, "revision").asString() == f.head().envelope.id);
    CHECK(errorCode(f.call(connection, "session.sync", cursorParams(cursors[1]))) == "sync_cursor_invalid");
    for (const char* forged : {"garbage", "sync_999:4", "", ":", "sync_1:-4", "sync_1:99999"}) {
        INFO(forged);
        CHECK(errorCode(f.call(connection, "session.sync", cursorParams(forged))) == "sync_cursor_invalid");
    }
    // Cursors belong to the connection.
    const ConnectionId other = f.authed(false);
    const std::string freshNext = at(fresh, "next").asString();
    const std::string prefix = freshNext.substr(0, freshNext.find(':') + 1);
    for (const std::string offset : {"99999", "3", "-4", "4x"}) {
        INFO(prefix + offset);
        CHECK(errorCode(f.call(connection, "session.sync", cursorParams(prefix + offset))) == "sync_cursor_invalid");
    }
    CHECK(errorCode(f.call(other, "session.sync", cursorParams(freshNext))) == "sync_cursor_invalid");
    CHECK(errorCode(f.call(connection, "session.sync", Value(Object{{"cursor", Value(4)}}))) == "invalid_params");
}

TEST_CASE("session.fetch returns entities at the head revision", "[protocol][sync]") {
    Fixture f;
    const ConnectionId connection = f.authed(false);
    f.commit(connection, Array{mediaAdd("med_1"), trackAdd("trk_1"), clipPlace("clp_1", "trk_1", "med_1", 0),
                               clipPlace("clp_2", "trk_1", "med_1", 48'000)});
    const std::string placed = f.head().envelope.id;
    f.commit(connection, Array{clipRemove("clp_2")});
    const auto& head = f.head();

    const Value result = f.ok(connection, "session.fetch",
                              Value(Object{{"refs", Value(Array{Value("track:trk_1"), Value("clip:clp_1"),
                                                                Value("clip:clp_2"), Value("root:root"),
                                                                Value("media:med_1")})}}));
    CHECK(at(result, "revision").asString() == head.envelope.id);
    CHECK(at(result, "documentHash").asString() == siann::hash::formatHash(head.envelope.documentHash));
    const auto& entities = at(result, "entities").asArray();
    REQUIRE(entities.size() == 5);
    CHECK(at(entities[0], "ref").asString() == "track:trk_1");
    CHECK(canonical(at(entities[0], "entity")) == canonical(siann::model::toJson(*head.document.track("trk_1"))));
    CHECK(canonical(at(entities[1], "entity")) == canonical(siann::model::toJson(*head.document.clip("clp_1"))));
    CHECK(at(entities[2], "ref").asString() == "clip:clp_2");
    CHECK(at(entities[2], "missing").asBool());
    CHECK(entities[2].find("entity") == nullptr);
    CHECK(canonical(at(entities[3], "entity")) == canonical(siann::model::toJson(head.document.root())));
    CHECK(canonical(at(entities[4], "entity")) == canonical(siann::model::toJson(*head.document.media("med_1"))));
    // The fetched JSON is the hashed form.
    CHECK(siann::hash::sha256(canonical(at(entities[0], "entity"))) ==
          head.document.entityHash(siann::model::EntityRef{siann::model::EntityType::track, "trk_1"}));

    for (const Value& bad : {Value(Object{}), Value(Object{{"refs", Value(Array{})}}),
                             Value(Object{{"refs", Value(Array{Value("nonsense")})}}),
                             Value(Object{{"refs", Value(Array{Value("plugin:p1")})}}),
                             Value(Object{{"refs", Value(Array{Value("track:")})}}),
                             Value(Object{{"refs", Value(Array{Value(1)})}})}) {
        INFO(canonical(bad));
        CHECK(errorCode(f.call(connection, "session.fetch", bad)) == "invalid_params");
    }

    // At an earlier revision named by an event: the removed clip is still there.
    const Value earlier = f.ok(connection, "session.fetch",
                               Value(Object{{"refs", Value(Array{Value("clip:clp_2")})}, {"revision", Value(placed)}}));
    CHECK(at(earlier, "revision").asString() == placed);
    const auto& old = at(earlier, "entities").asArray();
    REQUIRE(old.size() == 1);
    CHECK(old[0].find("entity") != nullptr);
    CHECK(errorCode(f.call(connection, "session.fetch",
                           Value(Object{{"refs", Value(Array{Value("clip:clp_1")})}, {"revision", Value("r999")}}))) ==
          "revision_unavailable");
    CHECK(errorCode(f.call(connection, "session.fetch",
                           Value(Object{{"refs", Value(Array{Value("clip:clp_1")})}, {"revision", Value(2)}}))) ==
          "invalid_params");
}
