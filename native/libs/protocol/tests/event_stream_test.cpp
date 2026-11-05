// Event stream tests (m3-events-sync): sequence numbers, the head revision,
// session.changed with changed IDs, and bounded outboxes that drop instead of
// blocking. In-memory transport, one thread.

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <string>
#include <vector>

#include "support/protocol_fixture.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/protocol/event_stream.hpp"

namespace json = siann::json;
using namespace siann::protocol::testing;
using siann::protocol::ConnectionId;
using siann::protocol::EventStream;
using siann::protocol::EventStreamOptions;
using siann::protocol::ServerOptions;
using siann::protocol::StreamPosition;

namespace {

std::string changeName(siann::model::DiffEntry::Change change) {
    switch (change) {
        case siann::model::DiffEntry::Change::added: return "added";
        case siann::model::DiffEntry::Change::removed: return "removed";
        case siann::model::DiffEntry::Change::modified: return "modified";
    }
    return "?";
}

// Revision.diff rendered as the documented changedIds, independently of the
// server's code.
Value expectedChangedIds(const siann::command::Revision& revision) {
    Array out;
    for (const auto& entry : revision.diff) {
        out.push_back(Value(Object{
            {"ref", Value(std::string(siann::model::entityTypeName(entry.entity.type)) + ":" + entry.entity.id)},
            {"change", Value(changeName(entry.change))}}));
    }
    return Value(std::move(out));
}

void checkChanged(const Value& event, const std::string& seq, const siann::command::Revision& revision,
                  const std::string& sessionId) {
    INFO(canonical(event));
    CHECK(at(event, "schema").asString() == "siann.event.v1");
    CHECK(at(event, "type").asString() == "session.changed");
    CHECK(at(event, "seq").asString() == seq);
    CHECK(at(event, "sessionId").asString() == sessionId);
    CHECK(at(event, "revision").asString() == revision.envelope.id);
    CHECK(at(event, "documentHash").asString() == siann::hash::formatHash(revision.envelope.documentHash));
    CHECK(at(event, "cause").asString() == std::string(siann::command::causeName(revision.envelope.cause)));
    CHECK(at(event, "actor").asString() == revision.envelope.actor);
    CHECK(at(event, "time").asString() == revision.envelope.time);
    Array parents;
    for (const auto& parent : revision.envelope.parents) {
        parents.push_back(Value(parent));
    }
    CHECK(canonical(at(event, "parents")) == canonical(Value(std::move(parents))));
    CHECK(canonical(at(event, "changedIds")) == canonical(expectedChangedIds(revision)));
}

bool hasChange(const Value& event, const std::string& ref, const std::string& change) {
    for (const auto& item : at(event, "changedIds").asArray()) {
        if (at(item, "ref").asString() == ref && at(item, "change").asString() == change) {
            return true;
        }
    }
    return false;
}

std::vector<std::string> seqs(const std::vector<Value>& events) {
    std::vector<std::string> out;
    for (const auto& event : events) {
        out.push_back(at(event, "seq").asString());
    }
    return out;
}

}  // namespace

TEST_CASE("events carry a contiguous sequence and the head revision", "[protocol][events]") {
    Fixture f;
    const ConnectionId listener = f.authed(true);
    const ConnectionId operatorConnection = f.authed(false);
    const Value hello = json::parse(f.transport.sent(listener)[0]);
    CHECK(at(hello, "seq").asString() == "0");

    std::vector<siann::command::Revision> revisions;
    f.commit(operatorConnection, Array{trackAdd("trk_1")});
    revisions.push_back(f.head());
    f.commit(operatorConnection, Array{mediaAdd("med_1"), trackAdd("trk_2")});
    revisions.push_back(f.head());
    f.commit(operatorConnection, Array{trackAdd("trk_3"), clipPlace("clp_1", "trk_3", "med_1", 0)});
    revisions.push_back(f.head());

    auto events = f.events(listener);
    REQUIRE(events.size() == 3);
    for (std::size_t i = 0; i < 3; ++i) {
        checkChanged(events[i], std::to_string(i + 1), revisions[i], f.server.sessionId());
    }
    CHECK(hasChange(events[2], "track:trk_3", "added"));
    CHECK(hasChange(events[2], "clip:clp_1", "added"));
    CHECK(hasChange(events[2], "root:root", "modified"));

    // Undo and redo are revisions too: new ids, the undone entities changed.
    f.ok(operatorConnection, "session.undo");
    const auto undone = f.head();
    f.ok(operatorConnection, "session.redo");
    const auto redone = f.head();
    events = f.events(listener);
    REQUIRE(events.size() == 5);
    checkChanged(events[3], "4", undone, f.server.sessionId());
    checkChanged(events[4], "5", redone, f.server.sessionId());
    CHECK(at(events[3], "cause").asString() == "undo");
    CHECK(hasChange(events[3], "track:trk_3", "removed"));
    CHECK(hasChange(events[3], "clip:clp_1", "removed"));
    CHECK(hasChange(events[4], "track:trk_3", "added"));
    CHECK(at(events[4], "revision").asString() != at(events[2], "revision").asString());

    // A connection that did not subscribe gets responses only.
    CHECK(f.events(operatorConnection).empty());
    CHECK(f.server.events().position().seq == 5);
    CHECK(f.server.events().position().revision == redone.envelope.id);
}

TEST_CASE("a revision committed outside the protocol is published too", "[protocol][events]") {
    Fixture f;
    const ConnectionId listener = f.authed(true);
    std::vector<siann::command::Command> commands;
    commands.push_back(siann::command::Command::fromJson(trackAdd("trk_engine")));
    const auto* revision = &f.session.commit(std::move(commands), "engine", "2026-11-04T00:00:00Z");
    f.server.publishRevision(*revision);
    f.server.pump();
    const auto events = f.events(listener);
    REQUIRE(events.size() == 1);
    checkChanged(events[0], "1", f.head(), f.server.sessionId());
}

TEST_CASE("an overflowing outbox drops events and leaves a visible gap", "[protocol][events]") {
    ServerOptions options = manualOptions();
    options.events.outboxCapacity = 2;
    Fixture f(options);
    const ConnectionId listener = f.authed(true);
    const ConnectionId operatorConnection = f.authed(false);

    // The client's socket is congested: nothing leaves the outbox.
    f.transport.setBufferedAmount(listener, std::size_t{1} << 30);
    for (int i = 1; i <= 5; ++i) {
        f.commit(operatorConnection, Array{trackAdd("trk_" + std::to_string(i))});
    }
    CHECK(f.events(listener).empty());
    CHECK(f.server.events().queued(listener) == 2);
    CHECK(f.server.events().dropped(listener) == 3);

    // The socket drains; the queued events go out and the next one shows the gap.
    f.transport.setBufferedAmount(listener, 0);
    f.server.pump();
    CHECK(seqs(f.events(listener)) == std::vector<std::string>{"1", "2"});
    f.commit(operatorConnection, Array{trackAdd("trk_6")});
    CHECK(seqs(f.events(listener)) == std::vector<std::string>{"1", "2", "6"});
    CHECK(f.server.events().dropped(listener) == 3);
    CHECK(f.server.events().queued(listener) == 0);
}

TEST_CASE("the event stream never blocks a publisher", "[protocol][events]") {
    FakeTransport transport;
    siann::protocol::TransportHandlers handlers;
    handlers.onUpgrade = [](const siann::protocol::HttpRequest&) { return std::optional<siann::protocol::HttpResponse>(); };
    handlers.onOpen = [](ConnectionId, const std::string&) {};
    handlers.onMessage = [](ConnectionId, const std::string&) {};
    handlers.onClose = [](ConnectionId) {};
    transport.setHandlers(handlers);
    const ConnectionId connection = *transport.connect().connection;

    EventStreamOptions options;
    options.outboxCapacity = 2;
    EventStream stream(transport, "ses_test", StreamPosition{0, "r1", "sha256:x", Value()}, options);
    CHECK(stream.subscribe(connection).seq == 0);
    for (int i = 0; i < 5; ++i) {
        CHECK(stream.publish("test.tick", Object{{"n", Value(i)}}) == static_cast<std::uint64_t>(i + 1));
    }
    CHECK(stream.queued(connection) == 2);
    CHECK(stream.dropped(connection) == 3);
    CHECK(stream.flush() == 2);
    stream.publish("test.tick", Object{{"n", Value(5)}});
    stream.flush();

    std::vector<std::string> delivered;
    for (const auto& text : transport.sent(connection)) {
        const Value event = json::parse(text);
        CHECK(at(event, "sessionId").asString() == "ses_test");
        CHECK(at(event, "revision").asString() == "r1");
        CHECK(at(event, "type").asString() == "test.tick");
        delivered.push_back(at(event, "seq").asString());
    }
    CHECK(delivered == std::vector<std::string>{"1", "2", "6"});
    // A later subscriber starts after the last published seq.
    const ConnectionId late = *transport.connect().connection;
    CHECK(stream.subscribe(late).seq == 6);
    CHECK(transport.sent(late).empty());
}
