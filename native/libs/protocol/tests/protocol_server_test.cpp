// Protocol envelope tests against the in-memory transport: no sockets, no
// threads. pump() runs on the test thread, so every step is deterministic.

#include <catch2/catch_test_macros.hpp>

#include <cctype>
#include <filesystem>
#include <random>
#include <string>
#include <vector>

#include "fake_transport.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/model/document.hpp"
#include "siann/protocol/protocol_server.hpp"
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
