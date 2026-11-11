// session.save and session.open (spec, Protocol v0 item 16).

#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "support/protocol_fixture.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/protocol/audition_port.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::AuditionPort;
using protocol::AuditionPortError;
using protocol::ServerOptions;

namespace {

std::string utf8(const std::filesystem::path& path) {
    const std::u8string text = path.u8string();
    return std::string(text.begin(), text.end());
}

// A second bundle on disk with one track, closed again.
std::filesystem::path otherBundle(const Fixture& f) {
    const std::filesystem::path bundle = f.dir.bundle().parent_path() / "Other.siann";
    session::Session other = session::Session::create(bundle, model::Document::create("Other", 44'100), "tester",
                                                      "2026-11-04T00:00:00Z");
    other.commit({command::Command::fromJson(trackAdd("trk_other")), command::Command::fromJson(trackAdd("trk_two"))},
                 "tester", "2026-11-04T00:00:01Z");
    return bundle;
}

std::string requestFor(const std::string& sessionId, const std::string& requestId, const std::string& method,
                       Value params = Value(Object{})) {
    return jcs::canonicalize(Value(Object{{"requestId", Value(requestId)},
                                          {"sessionId", Value(sessionId)},
                                          {"method", Value(method)},
                                          {"params", std::move(params)}}));
}

// Hears whatever it is told; reset() is what the engine host's rebind does
// on session.open (a new auditioner, main heard).
class FakeAuditionPort final : public AuditionPort {
public:
    void audition(const command::BranchId& branchId) override { heard_ = branchId; }
    void hearMain() override { heard_.reset(); }
    std::optional<command::BranchId> heard() const override { return heard_; }
    const command::Revision& merge(const command::BranchId&, std::string, std::string) override {
        throw AuditionPortError("audition_not_found", "the fake merges nothing");
    }
    void discard(const command::BranchId&) override {
        throw AuditionPortError("audition_not_found", "the fake discards nothing");
    }
    void reset() { heard_.reset(); }

private:
    std::optional<command::BranchId> heard_;
};

// The heard values of the audition.changed events among the events.
std::vector<std::string> heardChanges(const std::vector<Value>& events) {
    std::vector<std::string> out;
    for (const Value& event : events) {
        if (at(event, "type").asString() == "audition.changed") {
            out.push_back(at(event, "heard").asString());
        }
    }
    return out;
}

}  // namespace

TEST_CASE("session.save writes the checkpoint of the head", "[protocol][session]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});

    const Value saved = f.ok(c, "session.save");
    CHECK(at(saved, "revision").asString() == "r2");
    const std::filesystem::path path(
        std::u8string(reinterpret_cast<const char8_t*>(at(saved, "path").asString().c_str())));
    CHECK(path == f.dir.bundle() / "session.json");
    CHECK(std::filesystem::exists(path));

    const std::string expected = hash::formatHash(f.head().envelope.documentHash);
    // The fixture's session holds the bundle's lock while it is served.
    CHECK_THROWS_AS(session::Session::open(f.dir.bundle()), session::SessionError);
    f.server.stop();
    {
        const session::Session closing = std::move(f.session);
    }
    session::OpenReport report;
    const session::Session reopened = session::Session::open(f.dir.bundle(), &report);
    CHECK(report.checkpointVerified);
    CHECK(hash::formatHash(reopened.history().head().envelope.documentHash) == expected);
}

TEST_CASE("session.open serves the new session under a new sessionId", "[protocol][session]") {
    std::optional<session::Session> opened;
    std::optional<std::filesystem::path> asked;
    ServerOptions options = manualOptions();
    options.syncChunkEntities = 1;
    options.openSession = [&](const std::filesystem::path& path) -> session::Session& {
        asked = path;
        opened.emplace(session::Session::open(path));
        return *opened;
    };
    Fixture f(std::move(options));
    const std::filesystem::path bundle = otherBundle(f);
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    f.commit(c, Array{trackAdd("trk_a")});
    const std::string oldId = f.server.sessionId();

    // A pinned sync and a cached response of the old session.
    const Value chunk = f.ok(c, "session.sync");
    const Value cursor = at(chunk, "next");
    REQUIRE(cursor.kind() == Value::Kind::string);
    f.transport.deliver(c, requestFor(oldId, "dup", "session.inspect"));
    f.server.pump();
    const std::string cachedBefore = f.transport.sent(c).back();

    const Value result = f.ok(c, "session.open", Value(Object{{"path", Value(utf8(bundle))}}));
    REQUIRE(asked.has_value());
    CHECK(*asked == bundle);
    const std::string newId = at(result, "sessionId").asString();
    CHECK(newId != oldId);
    CHECK(newId.rfind("ses_", 0) == 0);
    CHECK(f.server.sessionId() == newId);
    CHECK(&f.server.session() == &*opened);
    CHECK(at(result, "revision").asString() == "r2");
    CHECK(at(result, "documentHash").asString() == hash::formatHash(opened->history().head().envelope.documentHash));

    // Subscribers learn about it; seq keeps counting.
    const auto events = f.events(watcher);
    REQUIRE_FALSE(events.empty());
    const Value& event = events.back();
    CHECK(at(event, "type").asString() == "session.opened");
    CHECK(at(event, "sessionId").asString() == newId);
    CHECK(at(event, "revision").asString() == "r2");
    CHECK(at(event, "documentHash").asString() == at(result, "documentHash").asString());
    CHECK(std::stoull(at(event, "seq").asString()) == std::stoull(at(events[events.size() - 2], "seq").asString()) + 1);

    // The old id is refused; the new one serves the new document.
    f.transport.deliver(c, requestFor(oldId, "late", "session.inspect"));
    CHECK(errorCode(json::parse(f.transport.sent(c).back())) == "session_mismatch");
    const Value inspected = f.ok(c, "session.inspect");
    CHECK(at(inspected, "documentHash").asString() == at(result, "documentHash").asString());

    // The old session's sync pin and idempotency cache are gone.
    CHECK(errorCode(f.call(c, "session.sync", Value(Object{{"cursor", cursor}}))) == "sync_cursor_invalid");
    f.transport.deliver(c, requestFor(newId, "dup", "session.inspect"));
    f.server.pump();
    const std::string cachedAfter = f.transport.sent(c).back();
    CHECK(cachedAfter != cachedBefore);
    CHECK(at(at(json::parse(cachedAfter), "result"), "revision").asString() == "r2");
    CHECK(at(at(json::parse(cachedAfter), "result"), "revisions").asNumber() == 2);

    // The auth reply of a new connection names the new session.
    const ConnectionId later = f.authed();
    CHECK(at(json::parse(f.transport.sent(later)[0]), "sessionId").asString() == newId);
}

TEST_CASE("session.open of a missing bundle is not_found and leaves the session served", "[protocol][session]") {
    bool called = false;
    ServerOptions options = manualOptions();
    options.openSession = [&](const std::filesystem::path&) -> session::Session& {
        called = true;
        throw std::runtime_error("must not be called");
    };
    Fixture f(std::move(options));
    const ConnectionId c = f.authed();
    const std::string oldId = f.server.sessionId();
    const std::string missing = utf8(f.dir.bundle().parent_path() / "Missing.siann");
    CHECK(errorCode(f.call(c, "session.open", Value(Object{{"path", Value(missing)}}))) == "not_found");
    CHECK_FALSE(called);
    CHECK(f.server.sessionId() == oldId);
    CHECK(errorCode(f.call(c, "session.open", Value(Object{}))) == "invalid_params");
}

TEST_CASE("without an openSession callback session.open is not_supported", "[protocol][session]") {
    Fixture f;
    const ConnectionId c = f.authed();
    CHECK(errorCode(f.call(c, "session.open", Value(Object{{"path", Value(utf8(f.dir.bundle()))}}))) ==
          "not_supported");
}

TEST_CASE("session.open answers the callback's SessionError and keeps the old session served",
          "[protocol][session]") {
    for (const std::string& code : {std::string("session_locked"), std::string("not_a_bundle")}) {
        INFO(code);
        ServerOptions options = manualOptions();
        options.openSession = [&code](const std::filesystem::path&) -> session::Session& {
            throw session::SessionError(code, "refused by the test");
        };
        Fixture f(std::move(options));
        const std::filesystem::path bundle = otherBundle(f);
        const ConnectionId c = f.authed();
        const std::string oldId = f.server.sessionId();
        const Value refused = f.call(c, "session.open", Value(Object{{"path", Value(utf8(bundle))}}));
        CHECK(errorCode(refused) == code);
        CHECK(f.server.sessionId() == oldId);
        CHECK(&f.server.session() == &f.session);
        CHECK(at(f.ok(c, "session.inspect"), "revision").asString() == "r1");
    }
}

TEST_CASE("session.open while a branch is heard publishes audition.changed {heard: main}",
          "[protocol][session][audition][ui]") {
    FakeAuditionPort port;
    std::optional<session::Session> opened;
    ServerOptions options = manualOptions();
    options.auditionPort = &port;
    options.openSession = [&](const std::filesystem::path& path) -> session::Session& {
        opened.emplace(session::Session::open(path));
        port.reset();
        return *opened;
    };
    Fixture f(std::move(options));
    const std::filesystem::path bundle = otherBundle(f);
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    f.ok(c, "audition.hear", Value(Object{{"side", Value("p1")}}));
    CHECK(heardChanges(f.events(watcher)) == std::vector<std::string>{"p1"});

    f.ok(c, "session.open", Value(Object{{"path", Value(utf8(bundle))}}));
    CHECK(heardChanges(f.events(watcher)) == std::vector<std::string>{"p1", "main"});
    CHECK(at(f.ok(c, "session.inspect"), "heard").asString() == "main");
}
