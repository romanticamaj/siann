// Loopback tests: the protocol server over the IXWebSocket transport on
// 127.0.0.1, driven by IXWebSocket's own client. Waits are condition waits
// with a generous timeout, never sleeps.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <mutex>
#include <optional>
#include <random>
#include <string>

#include <ixwebsocket/IXHttpClient.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>

#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/model/document.hpp"
#include "siann/protocol/ix_transport.hpp"
#include "siann/protocol/protocol_server.hpp"
#include "siann/session/session.hpp"

namespace fs = std::filesystem;
using siann::json::Array;
using siann::json::Object;
using siann::json::Value;
using siann::protocol::IxTransport;
using siann::protocol::kAppOrigin;
using siann::protocol::ProtocolServer;
using siann::protocol::ServerOptions;
using siann::session::Session;

namespace {

constexpr auto kTimeout = std::chrono::seconds(10);

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-protocol-ix-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

// The IXWebSocket client always sends an Origin (ws://host:port unless one is
// given), so the loopback clients present the app's. A request without Origin
// is covered by the fake-transport tests.
ix::WebSocketHttpHeaders appOrigin() {
    ix::WebSocketHttpHeaders headers;
    headers["Origin"] = std::string(kAppOrigin);
    return headers;
}

// A WebSocket client that queues what it receives.
class Client {
public:
    explicit Client(std::uint16_t port, ix::WebSocketHttpHeaders headers = appOrigin()) {
        socket_.setUrl("ws://127.0.0.1:" + std::to_string(port) + "/");
        socket_.setExtraHeaders(headers);
        socket_.disableAutomaticReconnection();
        socket_.setOnMessageCallback([this](const ix::WebSocketMessagePtr& message) {
            std::lock_guard lock(mutex_);
            switch (message->type) {
                case ix::WebSocketMessageType::Open:
                    open_ = true;
                    break;
                case ix::WebSocketMessageType::Message:
                    received_.push_back(message->str);
                    break;
                case ix::WebSocketMessageType::Close:
                    closed_ = true;
                    break;
                case ix::WebSocketMessageType::Error:
                    failed_ = true;
                    httpStatus_ = message->errorInfo.http_status;
                    reason_ = message->errorInfo.reason;
                    break;
                default:
                    break;
            }
            changed_.notify_all();
        });
    }
    ~Client() { socket_.stop(); }
    Client(const Client&) = delete;
    Client& operator=(const Client&) = delete;

    // True once open; false when the upgrade failed (httpStatus() tells why).
    bool start() {
        socket_.start();
        std::unique_lock lock(mutex_);
        REQUIRE(changed_.wait_for(lock, kTimeout, [this] { return open_ || failed_; }));
        UNSCOPED_INFO("upgrade failed: " << reason_);
        return open_;
    }

    int httpStatus() const {
        std::lock_guard lock(mutex_);
        return httpStatus_;
    }

    Value call(const std::string& text) {
        socket_.sendText(text);
        return next();
    }

    Value next() {
        std::unique_lock lock(mutex_);
        REQUIRE(changed_.wait_for(lock, kTimeout, [this] { return !received_.empty() || closed_; }));
        REQUIRE_FALSE(received_.empty());
        lastText_ = received_.front();
        received_.pop_front();
        return siann::json::parse(lastText_);
    }

    std::string lastText() const {
        std::lock_guard lock(mutex_);
        return lastText_;
    }

    void stop() { socket_.stop(); }

private:
    ix::WebSocket socket_;
    mutable std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<std::string> received_;
    std::string lastText_;
    bool open_ = false;
    bool closed_ = false;
    bool failed_ = false;
    int httpStatus_ = 0;
    std::string reason_;
};

struct Server {
    Server()
        : session(Session::create(dir.bundle(), siann::model::Document::create("Song", 48'000), "tester",
                                  "2026-11-04T00:00:00Z")),
          server(transport, session, ServerOptions{}) {
        server.start();
    }
    ~Server() { server.stop(); }

    std::string auth() const {
        return siann::jcs::canonicalize(Value(Object{{"type", Value("auth")}, {"token", Value(server.token())}}));
    }

    std::string request(const std::string& requestId, const std::string& method, Value params = Value(Object{})) const {
        return siann::jcs::canonicalize(Value(Object{{"requestId", Value(requestId)},
                                                     {"sessionId", Value(server.sessionId())},
                                                     {"method", Value(method)},
                                                     {"params", std::move(params)}}));
    }

    TempDir dir;
    Session session;
    IxTransport transport;
    ProtocolServer server;
};

Value addTrack(const std::string& id) {
    Array commands{Value(Object{{"op", Value("track.add")}, {"trackId", Value(id)}, {"name", Value(id)},
                                {"channels", Value(2)}})};
    return Value(Object{{"commands", Value(std::move(commands))}});
}

// Member lookup that fails the test instead of dereferencing null.
const Value& at(const Value& object, const char* key) {
    const Value* member = object.find(key);
    INFO("missing member " << key);
    REQUIRE(member != nullptr);
    return *member;
}

ix::HttpResponsePtr httpGet(std::uint16_t port, const std::string& path, std::optional<std::string> bearer) {
    ix::HttpClient client;
    auto args = client.createRequest();
    args->connectTimeout = 10;
    args->transferTimeout = 10;
    if (bearer) {
        args->extraHeaders["Authorization"] = "Bearer " + *bearer;
    }
    return client.get("http://127.0.0.1:" + std::to_string(port) + path, args);
}

}  // namespace

TEST_CASE("the IX transport serves 127.0.0.1 on the port it picked", "[protocol][ix]") {
    Server s;
    REQUIRE(s.server.port() != 0);

    Client client(s.server.port());
    REQUIRE(client.start());
    const Value reply = client.call(s.auth());
    REQUIRE(at(reply, "ok").asBool());
    CHECK(at(reply, "sessionId").asString() == s.server.sessionId());

    const Value inspect = client.call(s.request("q1", "session.inspect"));
    CHECK(at(inspect, "requestId").asString() == "q1");
    CHECK(at(at(inspect, "result"), "revision").asString() == "r1");

    const Value executed = client.call(s.request("q2", "command.execute", addTrack("trk_a")));
    REQUIRE(at(executed, "ok").asBool());
    CHECK(at(at(at(executed, "result"), "revision"), "id").asString() == "r2");
    const std::string original = client.lastText();
    client.stop();

    Client again(s.server.port());
    REQUIRE(again.start());
    REQUIRE(at(again.call(s.auth()), "ok").asBool());
    again.call(s.request("q2", "command.execute", addTrack("trk_a")));
    CHECK(again.lastText() == original);
    // Fence: the duplicate added no revision.
    const Value fence = again.call(s.request("fence", "session.inspect"));
    CHECK(at(at(fence, "result"), "revisions").asNumber() == 2);
}

TEST_CASE("the IX transport needs the token before any request", "[protocol][ix]") {
    Server s;
    Client client(s.server.port());
    REQUIRE(client.start());
    const Value response = client.call(s.request("q1", "session.inspect"));
    CHECK(at(response, "requestId").asString() == "q1");
    CHECK(at(at(response, "error"), "code").asString() == "unauthenticated");
}

TEST_CASE("the IX transport rejects a foreign Origin with 403", "[protocol][ix]") {
    Server s;
    Client evil(s.server.port(), {{"Origin", "http://evil.example"}});
    CHECK_FALSE(evil.start());
    CHECK(evil.httpStatus() == 403);

    Client app(s.server.port(), {{"Origin", std::string(kAppOrigin)}});
    CHECK(app.start());
    CHECK(at(app.call(s.auth()), "ok").asBool());
}

TEST_CASE("the IX transport answers plain HTTP with the bearer token only", "[protocol][ix]") {
    Server s;
    CHECK(httpGet(s.server.port(), "/v0/health", std::nullopt)->statusCode == 401);
    const auto health = httpGet(s.server.port(), "/v0/health", s.server.token());
    CHECK(health->statusCode == 200);
    CHECK(health->body == R"({"ok":true})");
    CHECK(httpGet(s.server.port(), "/v0/nope", s.server.token())->statusCode == 404);
}
