// Protocol envelope tests against the in-memory transport: no sockets, no
// threads. pump() runs on the test thread, so every step is deterministic.

#include <catch2/catch_test_macros.hpp>

#include <cctype>
#include <filesystem>
#include <random>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "fake_transport.hpp"
#include "support/peaks_fixtures.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/model/document.hpp"
#include "siann/protocol/protocol_server.hpp"
#include "siann/session/journal.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/session.hpp"

namespace fs = std::filesystem;
using siann::json::Array;
using siann::json::Member;
using siann::json::Object;
using siann::json::Value;
using siann::protocol::ConnectionId;
using siann::protocol::HttpRequest;
using siann::protocol::kAppOrigin;
using siann::protocol::ProtocolServer;
using siann::protocol::ServerOptions;
using siann::protocol::testing::FakeTransport;
using siann::session::Session;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-protocol-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    TempDir(const TempDir&) = delete;
    TempDir& operator=(const TempDir&) = delete;
    fs::path bundle() const { return path_ / "Song.siann"; }

private:
    fs::path path_;
};

ServerOptions manualOptions() {
    ServerOptions options;
    options.pumpThread = false;
    options.clock = [] { return std::string("2026-11-04T00:00:00Z"); };
    return options;
}

struct Fixture {
    explicit Fixture(ServerOptions options = manualOptions())
        : session(Session::create(dir.bundle(), siann::model::Document::create("Song", 48'000), "tester",
                                  "2026-11-04T00:00:00Z")),
          server(transport, session, std::move(options)) {
        server.start();
    }

    std::size_t revisions() const { return session.history().revisions().size(); }

    ConnectionId open(siann::protocol::Headers headers = {}) {
        auto upgrade = transport.connect(std::move(headers));
        REQUIRE(upgrade.connection.has_value());
        return *upgrade.connection;
    }

    // Opens a connection and authenticates it.
    ConnectionId authed() {
        const ConnectionId connection = open();
        transport.deliver(connection, siann::jcs::canonicalize(Value(Object{
                                          {"type", Value("auth")}, {"token", Value(server.token())}})));
        REQUIRE(transport.sent(connection).size() == 1);
        return connection;
    }

    std::string request(const std::string& requestId, const std::string& method, Value params = Value(Object{}),
                        const std::string& expectedRevision = {}) {
        Object envelope{{"requestId", Value(requestId)},
                        {"sessionId", Value(server.sessionId())},
                        {"method", Value(method)},
                        {"params", std::move(params)}};
        if (!expectedRevision.empty()) {
            envelope.emplace_back("expectedRevision", Value(expectedRevision));
        }
        return siann::jcs::canonicalize(Value(std::move(envelope)));
    }

    std::vector<std::string> sent(ConnectionId connection) const { return transport.sent(connection); }

    TempDir dir;
    Session session;
    FakeTransport transport;
    ProtocolServer server;
};

Value parse(const std::string& text) {
    return siann::json::parse(text);
}

// Member lookup that fails the test instead of dereferencing null.
const Value& at(const Value& object, const char* key) {
    const Value* member = object.find(key);
    INFO("missing member " << key);
    REQUIRE(member != nullptr);
    return *member;
}

std::string errorCode(const Value& response) {
    const Value* error = response.find("error");
    REQUIRE(error != nullptr);
    return at(*error, "code").asString();
}

Value trackAdd(const std::string& id) {
    return Value(Object{{"op", Value("track.add")}, {"trackId", Value(id)}, {"name", Value(id)}, {"channels", Value(2)}});
}

Value commandsParams(Array commands) {
    return Value(Object{{"commands", Value(std::move(commands))}});
}

bool isLowerHex(const std::string& text) {
    for (char c : text) {
        if (!std::isxdigit(static_cast<unsigned char>(c)) || std::isupper(static_cast<unsigned char>(c))) {
            return false;
        }
    }
    return true;
}

}  // namespace

TEST_CASE("the token is random per server and at least 64 lowercase hex characters", "[protocol]") {
    Fixture a;
    Fixture b;
    CHECK(a.server.token().size() >= 64);
    CHECK(isLowerHex(a.server.token()));
    CHECK(a.server.token() != b.server.token());
    CHECK(a.server.sessionId().rfind("ses_", 0) == 0);
    CHECK(a.server.sessionId() != b.server.sessionId());
}

TEST_CASE("the server listens on 127.0.0.1 by default", "[protocol]") {
    Fixture f;
    CHECK(f.transport.listening());
    CHECK(f.transport.host() == "127.0.0.1");
    CHECK(f.server.port() == 40000);
}

TEST_CASE("a request before authentication gets one unauthenticated error and the socket closes", "[protocol]") {
    Fixture f;
    const ConnectionId connection = f.open();
    f.transport.deliver(connection, f.request("q1", "command.execute", commandsParams({trackAdd("trk_a")})));
    f.server.pump();

    const auto sent = f.sent(connection);
    REQUIRE(sent.size() == 1);
    const Value response = parse(sent[0]);
    CHECK(at(response, "requestId").asString() == "q1");
    CHECK_FALSE(at(response, "ok").asBool());
    CHECK(errorCode(response) == "unauthenticated");
    CHECK(f.transport.closed(connection));
    CHECK(f.revisions() == 1);
}

TEST_CASE("a wrong token gets invalid_token and the socket closes", "[protocol]") {
    Fixture f;
    const ConnectionId connection = f.open();
    f.transport.deliver(connection, R"({"type":"auth","token":"0000"})");

    const auto sent = f.sent(connection);
    REQUIRE(sent.size() == 1);
    const Value reply = parse(sent[0]);
    CHECK(at(reply, "type").asString() == "auth");
    CHECK_FALSE(at(reply, "ok").asBool());
    CHECK(errorCode(reply) == "invalid_token");
    CHECK(f.transport.closed(connection));
}

TEST_CASE("the right token gets the session id, revision and document hash", "[protocol]") {
    Fixture f;
    const ConnectionId connection = f.authed();

    const Value reply = parse(f.sent(connection)[0]);
    CHECK(at(reply, "type").asString() == "auth");
    CHECK(at(reply, "ok").asBool());
    CHECK(at(reply, "sessionId").asString() == f.server.sessionId());
    CHECK(at(reply, "revision").asString() == "r1");
    CHECK(at(reply, "documentHash").asString() ==
          siann::hash::formatHash(f.session.history().head().envelope.documentHash));
    CHECK_FALSE(f.transport.closed(connection));

    f.transport.deliver(connection, f.request("q1", "session.inspect"));
    f.server.pump();
    const auto sent = f.sent(connection);
    REQUIRE(sent.size() == 2);
    const Value inspect = parse(sent[1]);
    CHECK(at(inspect, "requestId").asString() == "q1");
    CHECK(at(inspect, "ok").asBool());
    const Value* result = inspect.find("result");
    REQUIRE(result != nullptr);
    CHECK(at(*result, "revision").asString() == "r1");
    CHECK(at(*result, "revisions").asNumber() == 1);
    CHECK(at(*result, "documentHash").asString() == at(reply, "documentHash").asString());
}

TEST_CASE("malformed requests get exactly one bad_request", "[protocol]") {
    Fixture f;
    const ConnectionId connection = f.authed();
    const std::string sid = f.server.sessionId();

    struct Case {
        std::string frame;
        const char* echoed;  // nullptr: requestId null
    };
    const std::vector<Case> cases = {
        {"{not json", nullptr},
        {"[1,2,3]", nullptr},
        {R"({"sessionId":")" + sid + R"(","method":"session.inspect"})", nullptr},
        {R"({"requestId":"q-nosession","method":"session.inspect"})", "q-nosession"},
        {R"({"requestId":"q-nomethod","sessionId":")" + sid + R"("})", "q-nomethod"},
        {R"({"requestId":"q-params","sessionId":")" + sid + R"(","method":"session.inspect","params":3})",
         "q-params"},
        {R"({"requestId":"q-expected","sessionId":")" + sid +
             R"(","method":"session.inspect","expectedRevision":1})",
         "q-expected"},
    };
    std::size_t expected = 1;
    for (const auto& c : cases) {
        INFO(c.frame);
        f.transport.deliver(connection, c.frame);
        f.server.pump();
        const auto sent = f.sent(connection);
        REQUIRE(sent.size() == ++expected);
        const Value response = parse(sent.back());
        CHECK_FALSE(at(response, "ok").asBool());
        CHECK(errorCode(response) == "bad_request");
        const Value* requestId = response.find("requestId");
        REQUIRE(requestId != nullptr);
        if (c.echoed == nullptr) {
            CHECK(requestId->isNull());
        } else {
            CHECK(requestId->asString() == c.echoed);
        }
    }
    CHECK_FALSE(f.transport.closed(connection));
}

TEST_CASE("a request for another session gets session_mismatch and changes nothing", "[protocol]") {
    Fixture f;
    const ConnectionId connection = f.authed();
    f.transport.deliver(connection, siann::jcs::canonicalize(Value(Object{
                                        {"requestId", Value("q1")},
                                        {"sessionId", Value("ses_other")},
                                        {"method", Value("command.execute")},
                                        {"params", commandsParams({trackAdd("trk_a")})}})));
    f.server.pump();

    const auto sent = f.sent(connection);
    REQUIRE(sent.size() == 2);
    const Value response = parse(sent[1]);
    CHECK(at(response, "requestId").asString() == "q1");
    CHECK(errorCode(response) == "session_mismatch");
    CHECK(f.revisions() == 1);
}

TEST_CASE("command.execute commits one revision and returns its envelope", "[protocol]") {
    Fixture f;
    const ConnectionId connection = f.authed();
    f.transport.deliver(connection, f.request("q1", "command.execute", commandsParams({trackAdd("trk_a")})));
    f.server.pump();

    REQUIRE(f.revisions() == 2);
    const auto sent = f.sent(connection);
    REQUIRE(sent.size() == 2);
    const Value response = parse(sent[1]);
    CHECK(at(response, "requestId").asString() == "q1");
    REQUIRE(at(response, "ok").asBool());
    const Value* revision = at(response, "result").find("revision");
    REQUIRE(revision != nullptr);
    CHECK(at(*revision, "id").asString() == "r2");
    CHECK(at(*revision, "cause").asString() == "command");
    CHECK(at(*revision, "actor").asString() == "protocol");
    CHECK(at(*revision, "time").asString() == "2026-11-04T00:00:00Z");
    CHECK(at(*revision, "documentHash").asString() ==
          siann::hash::formatHash(f.session.history().head().envelope.documentHash));
}

TEST_CASE("expectedRevision on the head lets command.execute commit", "[protocol]") {
    Fixture f;
    const ConnectionId connection = f.authed();
    f.transport.deliver(connection, f.request("q1", "command.execute", commandsParams({trackAdd("trk_a")}), "r1"));
    f.server.pump();

    REQUIRE(f.revisions() == 2);
    const auto sent = f.sent(connection);
    REQUIRE(sent.size() == 2);
    const Value response = parse(sent[1]);
    REQUIRE(at(response, "ok").asBool());
    CHECK(at(at(at(response, "result"), "revision"), "id").asString() == "r2");
}

TEST_CASE("a stale expectedRevision gets revision_mismatch and nothing is committed", "[protocol]") {
    Fixture f;
    const ConnectionId connection = f.authed();
    f.transport.deliver(connection, f.request("q1", "command.execute", commandsParams({trackAdd("trk_a")})));
    f.server.pump();
    REQUIRE(f.revisions() == 2);

    // The head is r2 now; a client that last saw r1 must not commit over it.
    f.transport.deliver(connection, f.request("q2", "command.execute", commandsParams({trackAdd("trk_b")}), "r1"));
    f.transport.deliver(connection, f.request("q3", "session.inspect", Value(Object{}), "r1"));
    f.server.pump();

    CHECK(f.revisions() == 2);
    const auto sent = f.sent(connection);
    REQUIRE(sent.size() == 4);
    const Value stale = parse(sent[2]);
    CHECK(at(stale, "requestId").asString() == "q2");
    CHECK_FALSE(at(stale, "ok").asBool());
    CHECK(errorCode(stale) == "revision_mismatch");
    const Value inspect = parse(sent[3]);
    CHECK(at(inspect, "requestId").asString() == "q3");
    CHECK(errorCode(inspect) == "revision_mismatch");

    // The mismatch is the executed answer: a duplicate returns it unchanged.
    f.transport.deliver(connection, f.request("q2", "command.execute", commandsParams({trackAdd("trk_b")}), "r1"));
    f.server.pump();
    REQUIRE(f.sent(connection).size() == 5);
    CHECK(f.sent(connection)[4] == sent[2]);
    CHECK(f.revisions() == 2);
}

TEST_CASE("command errors pass through with their stable code and step", "[protocol]") {
    Fixture f;
    const ConnectionId connection = f.authed();
    f.transport.deliver(connection,
                        f.request("q1", "command.execute",
                                  commandsParams({trackAdd("trk_a"), Value(Object{{"op", Value("no.such")}})})));
    f.transport.deliver(connection,
                        f.request("q2", "command.execute",
                                  commandsParams({Value(Object{{"op", Value("track.add")}, {"trackId", Value(3)}})})));
    f.transport.deliver(connection, f.request("q3", "no.such.method"));
    f.server.pump();

    const auto sent = f.sent(connection);
    REQUIRE(sent.size() == 4);
    const Value unknown = parse(sent[1]);
    CHECK(at(unknown, "requestId").asString() == "q1");
    CHECK(errorCode(unknown) == "unknown_command");
    CHECK(at(at(unknown, "error"), "step").asNumber() == 1);
    const Value invalid = parse(sent[2]);
    CHECK(errorCode(invalid) == "invalid_params");
    CHECK(at(at(invalid, "error"), "step").asNumber() == 0);
    const Value method = parse(sent[3]);
    CHECK(at(method, "requestId").asString() == "q3");
    CHECK(errorCode(method) == "unknown_method");
    CHECK(f.revisions() == 1);
}

TEST_CASE("a duplicate requestId returns the original response, also after a reconnect", "[protocol]") {
    Fixture f;
    const ConnectionId first = f.authed();
    const std::string frame = f.request("q1", "command.execute", commandsParams({trackAdd("trk_a")}));
    f.transport.deliver(first, frame);
    f.server.pump();
    f.transport.deliver(first, frame);
    f.server.pump();

    auto sent = f.sent(first);
    REQUIRE(sent.size() == 3);
    CHECK(sent[2] == sent[1]);
    CHECK(f.revisions() == 2);

    f.transport.disconnect(first);
    const ConnectionId second = f.authed();
    f.transport.deliver(second, frame);
    f.server.pump();
    const auto again = f.sent(second);
    REQUIRE(again.size() == 2);
    CHECK(again[1] == sent[1]);
    CHECK(f.revisions() == 2);

    // A new requestId executes again.
    f.transport.deliver(second, f.request("q2", "command.execute", commandsParams({trackAdd("trk_b")})));
    f.server.pump();
    REQUIRE(f.sent(second).size() == 3);
    CHECK(f.revisions() == 3);
}

TEST_CASE("a duplicate of a failed request returns the same error without retrying", "[protocol]") {
    Fixture f;
    const ConnectionId connection = f.authed();
    const std::string frame =
        f.request("q1", "command.execute", commandsParams({Value(Object{{"op", Value("no.such")}})}));
    f.transport.deliver(connection, frame);
    f.transport.deliver(connection, frame);
    f.server.pump();
    const auto sent = f.sent(connection);
    REQUIRE(sent.size() == 3);
    CHECK(sent[1] == sent[2]);
    CHECK(errorCode(parse(sent[1])) == "unknown_command");
}

namespace {

// A path in the ANSI code page (CP950 on a Traditional Chinese Windows) is not
// UTF-8; IoError and SessionError carry such paths in their messages.
constexpr const char* kNotUtf8 = "cannot write D:/\xad\xb5\xbc\xd6/Song.siann/journal: \xff";
constexpr const char* kReplacement = "\xEF\xBF\xBD";  // U+FFFD

enum class Throw { nothing, runtimeError, sessionError, notAnException };

// A clock that throws as the commit asks for the time, the way a journal
// write that fails during command.execute throws out of Session::commit.
ServerOptions throwingClockOptions(const Throw& mode, bool pumpThread) {
    ServerOptions options = manualOptions();
    options.pumpThread = pumpThread;
    options.clock = [&mode]() -> std::string {
        switch (mode) {
            case Throw::runtimeError: throw std::runtime_error(kNotUtf8);
            case Throw::sessionError: throw siann::session::SessionError("corrupt_record", kNotUtf8);
            case Throw::notAnException: throw 42;
            case Throw::nothing: break;
        }
        return "2026-11-04T00:00:00Z";
    };
    return options;
}

}  // namespace

TEST_CASE("an exception whose message is not UTF-8 still gets exactly one error response", "[protocol]") {
    Throw mode = Throw::nothing;
    Fixture f(throwingClockOptions(mode, false));
    const ConnectionId connection = f.authed();

    std::string code;
    bool replaced = true;
    SECTION("std::exception") {
        mode = Throw::runtimeError;
        code = "internal_error";
    }
    SECTION("SessionError keeps its code") {
        mode = Throw::sessionError;
        code = "corrupt_record";
    }
    SECTION("an exception that is not a std::exception") {
        mode = Throw::notAnException;
        code = "internal_error";
        replaced = false;
    }
    f.transport.deliver(connection, f.request("q1", "command.execute", commandsParams({trackAdd("trk_a")})));
    REQUIRE_NOTHROW(f.server.pump());
    auto sent = f.sent(connection);
    REQUIRE(sent.size() == 2);
    const Value response = parse(sent[1]);
    CHECK(at(response, "requestId").asString() == "q1");
    CHECK_FALSE(at(response, "ok").asBool());
    CHECK(errorCode(response) == code);
    if (replaced) {
        CHECK(at(at(response, "error"), "message").asString().find(kReplacement) != std::string::npos);
    }
    CHECK(f.revisions() == 1);

    // The server keeps serving.
    mode = Throw::nothing;
    f.transport.deliver(connection, f.request("q2", "command.execute", commandsParams({trackAdd("trk_a")})));
    f.server.pump();
    sent = f.sent(connection);
    REQUIRE(sent.size() == 3);
    CHECK(at(parse(sent[2]), "ok").asBool());
    CHECK(f.revisions() == 2);
}

TEST_CASE("on the pump thread, an exception whose message is not UTF-8 gets one error and the thread lives",
          "[protocol]") {
    Throw mode = Throw::runtimeError;
    Fixture f(throwingClockOptions(mode, true));
    const ConnectionId connection = f.authed();
    f.transport.deliver(connection, f.request("q1", "command.execute", commandsParams({trackAdd("trk_a")})));
    REQUIRE(f.transport.waitSent(connection, 2));
    CHECK(errorCode(parse(f.sent(connection)[1])) == "internal_error");

    f.transport.deliver(connection, f.request("q2", "session.inspect"));
    REQUIRE(f.transport.waitSent(connection, 3));
    const auto sent = f.sent(connection);
    CHECK(at(parse(sent[2]), "requestId").asString() == "q2");
    CHECK(at(parse(sent[2]), "ok").asBool());
    f.server.stop();
}

TEST_CASE("requests in flight get exactly one response each, in order", "[protocol]") {
    Fixture f;
    const ConnectionId connection = f.authed();
    f.transport.deliver(connection, f.request("q1", "command.execute", commandsParams({trackAdd("trk_a")})));
    f.transport.deliver(connection, f.request("q2", "session.inspect"));
    f.transport.deliver(connection, f.request("q3", "command.execute", commandsParams({trackAdd("trk_b")})));
    f.transport.deliver(connection, f.request("fence", "session.inspect"));
    CHECK(f.server.pump() == 4);

    const auto sent = f.sent(connection);
    REQUIRE(sent.size() == 5);
    const std::vector<std::string> ids = {"q1", "q2", "q3", "fence"};
    for (std::size_t i = 0; i < ids.size(); ++i) {
        const Value response = parse(sent[i + 1]);
        CHECK(at(response, "requestId").asString() == ids[i]);
        CHECK(at(response, "ok").asBool());
    }
    CHECK(at(at(parse(sent[2]), "result"), "revision").asString() == "r2");
    CHECK(at(at(parse(sent[4]), "result"), "revision").asString() == "r3");
    CHECK(f.server.pump() == 0);
    CHECK(f.sent(connection).size() == 5);
}

TEST_CASE("a full inbox answers queue_full at once and keeps the queued request", "[protocol]") {
    ServerOptions options = manualOptions();
    options.inboxCapacity = 1;
    Fixture f(std::move(options));
    const ConnectionId connection = f.authed();
    f.transport.deliver(connection, f.request("q1", "command.execute", commandsParams({trackAdd("trk_a")})));
    f.transport.deliver(connection, f.request("q2", "command.execute", commandsParams({trackAdd("trk_b")})));

    auto sent = f.sent(connection);
    REQUIRE(sent.size() == 2);
    const Value full = parse(sent[1]);
    CHECK(at(full, "requestId").asString() == "q2");
    CHECK(errorCode(full) == "queue_full");
    CHECK(f.revisions() == 1);

    CHECK(f.server.pump() == 1);
    sent = f.sent(connection);
    REQUIRE(sent.size() == 3);
    CHECK(at(parse(sent[2]), "requestId").asString() == "q1");
    CHECK(at(parse(sent[2]), "ok").asBool());
    CHECK(f.revisions() == 2);

    // queue_full was not cached: q2 can be retried with the same requestId.
    f.transport.deliver(connection, f.request("q2", "command.execute", commandsParams({trackAdd("trk_b")})));
    f.server.pump();
    CHECK(at(parse(f.sent(connection).back()), "ok").asBool());
    CHECK(f.revisions() == 3);
}

TEST_CASE("Origin is checked against the allow list at the upgrade", "[protocol]") {
    Fixture f;
    CHECK(f.transport.connect().connection.has_value());
    CHECK(f.transport.connect({{"origin", std::string(kAppOrigin)}}).connection.has_value());

    for (const char* origin : {"http://evil.example", "null", "siann://app.evil.example", "SIANN://APP"}) {
        INFO(origin);
        const auto upgrade = f.transport.connect({{"origin", origin}});
        CHECK_FALSE(upgrade.connection.has_value());
        CHECK(upgrade.rejection.status == 403);
    }
}

TEST_CASE("an Origin that is not valid UTF-8 gets a 403 with a JSON body", "[protocol]") {
    Fixture f;
    // Raw header bytes reach the handler unchecked; the rejection must not
    // echo them into canonical JSON, which only takes valid UTF-8.
    for (const std::string& origin : {std::string("http://x\xff"), std::string("http://\xc3("),
                                     std::string("\xed\xa0\x80")}) {
        siann::protocol::testing::FakeTransport::Upgrade upgrade;
        REQUIRE_NOTHROW(upgrade = f.transport.connect({{"origin", origin}}));
        CHECK_FALSE(upgrade.connection.has_value());
        CHECK(upgrade.rejection.status == 403);
        const Value body = parse(upgrade.rejection.body);
        CHECK(at(at(body, "error"), "code").asString() == "origin_not_allowed");
    }
}

TEST_CASE("an authenticated HTTP request with a non-UTF-8 method or path gets a 404 with a JSON body", "[protocol]") {
    Fixture f;
    const std::string bearer = "Bearer " + f.server.token();
    for (const auto& [method, path] : {std::pair<std::string, std::string>{"GET", "/v0/\xff"},
                                       std::pair<std::string, std::string>{"G\xfe", "/v0/health"}}) {
        siann::protocol::HttpResponse response;
        REQUIRE_NOTHROW(response = f.transport.http(HttpRequest{method, path, {{"authorization", bearer}}, {}}));
        CHECK(response.status == 404);
        CHECK(at(at(parse(response.body), "error"), "code").asString() == "not_found");
    }
}

TEST_CASE("an allow list from the options replaces the default", "[protocol]") {
    ServerOptions options = manualOptions();
    options.allowedOrigins = {std::string(kAppOrigin), "null"};
    Fixture f(std::move(options));
    CHECK(f.transport.connect({{"origin", "null"}}).connection.has_value());
    CHECK(f.transport.connect({{"origin", std::string(kAppOrigin)}}).connection.has_value());
    CHECK(f.transport.connect({{"origin", "http://evil.example"}}).rejection.status == 403);
}

TEST_CASE("plain HTTP needs the bearer token", "[protocol]") {
    Fixture f;
    CHECK(f.transport.http(HttpRequest{"GET", "/v0/health", {}, {}}).status == 401);
    CHECK(f.transport.http(HttpRequest{"GET", "/v0/health", {{"authorization", "Bearer nope"}}, {}}).status == 401);
    const auto health =
        f.transport.http(HttpRequest{"GET", "/v0/health", {{"authorization", "Bearer " + f.server.token()}}, {}});
    CHECK(health.status == 200);
    CHECK(health.body == R"({"ok":true})");
    CHECK(f.transport.http(HttpRequest{"GET", "/v0/nope", {{"authorization", "Bearer " + f.server.token()}}, {}})
              .status == 404);
}

// ---- GET /v0/peaks/<hash> (spec, Protocol v0 item 23; docs/schemas/protocol-peaks-v0.md) ----

namespace {

// A bundle with two media entities made by importMedia from the fixture
// signals of fixtures/peaks (square-mono and silence-mono, both at 48 kHz, so
// stored byte for byte), served with jobs run by runJobs() on the test thread.
struct PeaksFixture {
    PeaksFixture()
        : session(Session::create(dir.bundle(), siann::model::Document::create("Song", 48'000), "tester",
                                  "2026-11-04T00:00:00Z")),
          square(importFixture("square-mono", "med_sq")),
          silence(importFixture("silence-mono", "med_si")),
          server(transport, session, options()) {
        server.start();
    }

    static ServerOptions options() {
        ServerOptions o = manualOptions();
        o.jobs.workerThread = false;
        return o;
    }

    // Imports the fixture's signal; returns the stored file's content hash, as hex.
    std::string importFixture(const std::string& name, const std::string& mediaId) {
        const fs::path wav = dir.bundle().parent_path() / (name + ".wav");
        siann::io::writeFileAtomic(wav, siann::media::encodeWavFloat32(siann::media::testing::fixtureSignal(
                                            siann::media::testing::peaksFixture(name))));
        const auto imported = siann::session::importMedia(session, wav, mediaId, "tester", "2026-11-04T00:00:00Z");
        return imported.storedFile.stem().string();
    }

    siann::protocol::HttpResponse get(const std::string& hex, siann::protocol::Headers headers = {}) {
        if (headers.find("authorization") == headers.end()) {
            headers["authorization"] = "Bearer " + server.token();
        }
        return transport.http(HttpRequest{"GET", "/v0/peaks/" + hex, std::move(headers), {}});
    }

    // Opens a connection and authenticates it.
    ConnectionId authed() {
        auto upgrade = transport.connect({});
        REQUIRE(upgrade.connection.has_value());
        transport.deliver(*upgrade.connection, siann::jcs::canonicalize(Value(Object{
                                                   {"type", Value("auth")}, {"token", Value(server.token())}})));
        return *upgrade.connection;
    }

    std::string request(const std::string& requestId, const std::string& method, Value params = Value(Object{})) {
        return siann::jcs::canonicalize(Value(Object{{"requestId", Value(requestId)},
                                                     {"sessionId", Value(server.sessionId())},
                                                     {"method", Value(method)},
                                                     {"params", std::move(params)}}));
    }

    fs::path peaksFile(const std::string& hex) const { return dir.bundle() / "peaks" / (hex + ".peaks"); }

    TempDir dir;
    Session session;
    std::string square;
    std::string silence;
    FakeTransport transport;
    ProtocolServer server;
};

std::string httpErrorCode(const siann::protocol::HttpResponse& response) {
    return at(at(parse(response.body), "error"), "code").asString();
}

}  // namespace

TEST_CASE("GET /v0/peaks/<hash> without a bearer is 401", "[protocol][peaks]") {
    PeaksFixture f;
    for (const std::string& bearer : {std::string(), std::string("Bearer nope"), "Bearer " + f.server.mcpToken()}) {
        INFO("bearer: [" << bearer << "]");
        siann::protocol::Headers headers;
        if (!bearer.empty()) {
            headers["authorization"] = bearer;
        }
        const auto response = f.transport.http(HttpRequest{"GET", "/v0/peaks/" + f.square, headers, {}});
        CHECK(response.status == 401);
        CHECK(httpErrorCode(response) == "unauthenticated");
    }
    CHECK(f.server.runJobs() == 0);
}

TEST_CASE("a hash not in the head document is 404 not_found before any file is opened", "[protocol][peaks]") {
    PeaksFixture f;
    // A valid pyramid planted under peaks/ for a hash no media entity has.
    const std::string foreign(64, 'b');
    siann::io::createDirectoriesDurable(f.dir.bundle() / "peaks");
    siann::io::writeFileAtomic(f.peaksFile(foreign), siann::media::testing::peaksFixtureBytes("square-mono"));
    const auto response = f.get(foreign);
    CHECK(response.status == 404);
    CHECK(httpErrorCode(response) == "not_found");
    std::string upper = f.square;
    for (char& c : upper) {
        c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    }
    for (const std::string& bad : {upper, f.square.substr(1), f.square + "0", std::string("..%2Fsession.json"),
                                   std::string("../session.json"), std::string(), "sha256:" + f.square}) {
        INFO("hash: [" << bad << "]");
        const auto refused = f.get(bad);
        CHECK(refused.status == 404);
        CHECK(httpErrorCode(refused) == "not_found");
    }
    // Nothing was queued for any of them.
    CHECK(f.server.runJobs() == 0);
}

TEST_CASE("a media entity whose pyramid is absent answers 202 peaks_pending once and 200 after the job ran",
          "[protocol][peaks]") {
    PeaksFixture f;
    REQUIRE_FALSE(fs::exists(f.peaksFile(f.square)));
    const auto pending = f.get(f.square);
    CHECK(pending.status == 202);
    CHECK(httpErrorCode(pending) == "peaks_pending");
    // Asked again while queued: still pending, and no second job.
    CHECK(f.get(f.square).status == 202);
    CHECK(f.server.runJobs() == 1);
    CHECK(fs::exists(f.peaksFile(f.square)));

    const auto served = f.get(f.square);
    CHECK(served.status == 200);
    CHECK(served.contentType == "application/octet-stream");
    CHECK(served.body == siann::media::testing::peaksFixtureBytes("square-mono"));
    // Served from the cache: no job.
    CHECK(f.get(f.square).status == 200);
    CHECK(f.server.runJobs() == 0);

    // The silent media's pyramid is the silence fixture.
    CHECK(f.get(f.silence).status == 202);
    CHECK(f.server.runJobs() == 1);
    CHECK(f.get(f.silence).body == siann::media::testing::peaksFixtureBytes("silence-mono"));
}

TEST_CASE("a media file removed from media/ is 404 media_missing", "[protocol][peaks]") {
    PeaksFixture f;
    REQUIRE(fs::remove(f.dir.bundle() / "media" / (f.square + ".wav")));
    const auto response = f.get(f.square);
    CHECK(response.status == 404);
    CHECK(httpErrorCode(response) == "media_missing");
    CHECK(f.server.runJobs() == 0);
}

TEST_CASE("a corrupt peaks cache file is rebuilt", "[protocol][peaks]") {
    PeaksFixture f;
    siann::io::createDirectoriesDurable(f.dir.bundle() / "peaks");
    siann::io::writeFileAtomic(f.peaksFile(f.square), "SPKS but not a pyramid");
    CHECK(f.get(f.square).status == 202);
    CHECK(f.server.runJobs() == 1);
    const auto served = f.get(f.square);
    CHECK(served.status == 200);
    CHECK(served.body == siann::media::testing::peaksFixtureBytes("square-mono"));
}

TEST_CASE("a failed peaks computation answers its code once, then queues again", "[protocol][peaks]") {
    PeaksFixture f;
    siann::io::writeFileAtomic(f.dir.bundle() / "media" / (f.square + ".wav"), "JUNK, not a WAV file at all");
    CHECK(f.get(f.square).status == 202);
    CHECK(f.server.runJobs() == 1);
    const auto failed = f.get(f.square);
    CHECK(failed.status == 500);
    CHECK(httpErrorCode(failed) == "unsupported_media");
    CHECK(f.get(f.square).status == 202);
    CHECK(f.server.runJobs() == 1);
}

TEST_CASE("media committed after the server started is served once the revision is published",
          "[protocol][peaks]") {
    PeaksFixture f;
    const fs::path wav = f.dir.bundle().parent_path() / "ramp.wav";
    siann::io::writeFileAtomic(wav, siann::media::encodeWavFloat32(siann::media::testing::fixtureSignal(
                                        siann::media::testing::peaksFixture("short-mono"))));
    const auto imported = siann::session::importMedia(f.session, wav, "med_rp", "tester", "2026-11-04T00:00:00Z");
    const std::string hex = imported.storedFile.stem().string();
    CHECK(f.get(hex).status == 404);  // not in the served head yet
    f.server.publishRevision(*imported.revision);
    CHECK(f.get(hex).status == 202);
    CHECK(f.server.runJobs() == 1);
    CHECK(f.get(hex).body == siann::media::testing::peaksFixtureBytes("short-mono"));

    // A commit through the protocol that removes the media: its hash is no longer served.
    const ConnectionId connection = f.authed();
    const Value remove(Object{{"op", Value("media.remove")}, {"mediaId", Value("med_rp")}});
    f.transport.deliver(connection, f.request("rm", "command.execute", commandsParams({remove})));
    f.server.pump();
    REQUIRE(at(parse(f.transport.sent(connection).back()), "ok").asBool());
    CHECK(f.get(hex).status == 404);
}

TEST_CASE("the peaks route answers the CORS preflight and names an allowed Origin", "[protocol][peaks]") {
    PeaksFixture f;
    const std::string origin(kAppOrigin);
    const auto preflight = f.transport.http(HttpRequest{"OPTIONS",
                                                        "/v0/peaks/" + f.square,
                                                        {{"origin", origin},
                                                         {"access-control-request-method", "GET"},
                                                         {"access-control-request-headers", "authorization"}},
                                                        {}});
    CHECK(preflight.status == 204);
    REQUIRE(preflight.headers.count("Access-Control-Allow-Origin") == 1);
    CHECK(preflight.headers.at("Access-Control-Allow-Origin") == origin);
    CHECK(preflight.headers.at("Access-Control-Allow-Methods") == "GET");
    CHECK(preflight.headers.at("Access-Control-Allow-Headers") == "authorization");
    CHECK(f.transport.http(HttpRequest{"OPTIONS", "/v0/peaks/" + f.square, {{"origin", "http://evil.example"}}, {}})
              .status == 403);

    const auto pending = f.get(f.square, {{"origin", origin}});
    CHECK(pending.status == 202);
    REQUIRE(pending.headers.count("Access-Control-Allow-Origin") == 1);
    CHECK(pending.headers.at("Access-Control-Allow-Origin") == origin);
    // A token does not let another Origin in.
    const auto foreign = f.get(f.square, {{"origin", "http://evil.example"}});
    CHECK(foreign.status == 403);
    CHECK(httpErrorCode(foreign) == "origin_not_allowed");
    CHECK(foreign.headers.count("Access-Control-Allow-Origin") == 0);
}

TEST_CASE("engine.capabilities lists the peaks feature", "[protocol][peaks]") {
    PeaksFixture f;
    const ConnectionId connection = f.authed();
    f.transport.deliver(connection, f.request("caps", "engine.capabilities"));
    f.server.pump();
    const Value response = parse(f.transport.sent(connection).back());
    const Value* peaks = at(at(response, "result"), "features").find("peaks");
    REQUIRE(peaks != nullptr);
    CHECK(peaks->asBool());
}
