#pragma once

// Loopback clients over IXWebSocket for tests that talk to a real protocol
// server (in process, or a siann-engine child): an MCP client over
// Streamable HTTP and a WebSocket client for the UI side. Waits are condition
// waits with a bounded timeout, never sleeps. Call ix::initNetSystem() first.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

#include <ixwebsocket/IXHttpClient.h>
#include <ixwebsocket/IXWebSocket.h>

#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/protocol/about.hpp"
#include "siann/protocol/protocol_server.hpp"
#include "siann/protocol/realtime_channel.hpp"

namespace siann::protocol::testing {

inline constexpr auto kClientTimeout = std::chrono::seconds(10);

inline const json::Value& clientMember(const json::Value& object, const char* key) {
    const json::Value* member = object.find(key);
    INFO("missing member " << key);
    REQUIRE(member != nullptr);
    return *member;
}

// An MCP client over Streamable HTTP (JSON responses).
class McpClient {
public:
    McpClient(std::uint16_t port, std::string token)
        : url_("http://127.0.0.1:" + std::to_string(port) + "/v0/mcp"), token_(std::move(token)) {}

    ix::HttpResponsePtr post(const std::string& body, bool withToken = true) {
        auto args = client_.createRequest();
        args->connectTimeout = 10;
        args->transferTimeout = 30;
        args->extraHeaders["Content-Type"] = "application/json";
        // IX's client sends Origin http://<host>:<port> unless given one; an
        // MCP client is no browser, it presents the app origin like the UI.
        args->extraHeaders["Origin"] = std::string(kAppOrigin);
        if (withToken) {
            args->extraHeaders["Authorization"] = "Bearer " + token_;
        }
        if (!session_.empty()) {
            args->extraHeaders["Mcp-Session-Id"] = session_;
        }
        return client_.post(url_, body, args);
    }

    void initialize() {
        using json::Object;
        using json::Value;
        const auto response = post(rpc("initialize", Value(Object{{"protocolVersion", Value("2025-06-18")},
                                                                  {"capabilities", Value(Object{})},
                                                                  {"clientInfo", Value(Object{{"name", Value("e2e")},
                                                                                              {"version", Value("1")}})}})));
        REQUIRE(response->statusCode == 200);
        const auto header = response->headers.find("Mcp-Session-Id");
        REQUIRE(header != response->headers.end());
        session_ = header->second;
        const Value body = json::parse(response->body);
        CHECK(clientMember(clientMember(clientMember(body, "result"), "serverInfo"), "name").asString() ==
              buildInfo().name);
        CHECK(post(R"({"jsonrpc":"2.0","method":"notifications/initialized"})")->statusCode == 202);
    }

    // A tool call's JSON-RPC result.
    json::Value tool(const std::string& name, json::Value arguments = json::Value(json::Object{})) {
        using json::Object;
        using json::Value;
        const auto response =
            post(rpc("tools/call", Value(Object{{"name", Value(name)}, {"arguments", std::move(arguments)}})));
        INFO(name << ": " << response->body);
        REQUIRE(response->statusCode == 200);
        const Value body = json::parse(response->body);
        return clientMember(body, "result");
    }

    json::Value ok(const std::string& name, json::Value arguments = json::Value(json::Object{})) {
        const json::Value result = tool(name, std::move(arguments));
        INFO(name << ": " << jcs::canonicalize(result));
        REQUIRE_FALSE(clientMember(result, "isError").asBool());
        return clientMember(result, "structuredContent");
    }

private:
    std::string rpc(const std::string& method, json::Value params) {
        using json::Object;
        using json::Value;
        return jcs::canonicalize(Value(Object{{"jsonrpc", Value("2.0")},
                                              {"id", Value(++nextId_)},
                                              {"method", Value(method)},
                                              {"params", std::move(params)}}));
    }

    ix::HttpClient client_;
    std::string url_;
    std::string token_;
    std::string session_;
    int nextId_ = 0;
};

// A WebSocket client presenting the app origin, as the UI does.
class WsClient {
public:
    explicit WsClient(std::uint16_t port) {
        socket_.setUrl("ws://127.0.0.1:" + std::to_string(port) + "/");
        ix::WebSocketHttpHeaders headers;
        headers["Origin"] = std::string(kAppOrigin);
        socket_.setExtraHeaders(headers);
        socket_.disableAutomaticReconnection();
        socket_.setOnMessageCallback([this](const ix::WebSocketMessagePtr& message) {
            std::lock_guard lock(mutex_);
            if (message->type == ix::WebSocketMessageType::Open) {
                open_ = true;
            } else if (message->type == ix::WebSocketMessageType::Close ||
                       message->type == ix::WebSocketMessageType::Error) {
                closed_ = true;
            } else if (message->type == ix::WebSocketMessageType::Message && !message->binary) {
                received_.push_back(message->str);
            }
            changed_.notify_all();
        });
    }
    ~WsClient() { socket_.stop(); }
    WsClient(const WsClient&) = delete;
    WsClient& operator=(const WsClient&) = delete;

    bool start() {
        socket_.start();
        std::unique_lock lock(mutex_);
        return changed_.wait_for(lock, kClientTimeout, [this] { return open_; });
    }

    json::Value call(const std::string& text) {
        socket_.sendText(text);
        std::unique_lock lock(mutex_);
        REQUIRE(changed_.wait_for(lock, kClientTimeout, [this] { return !received_.empty(); }));
        json::Value out = json::parse(received_.front());
        received_.pop_front();
        return out;
    }

    // The next text frame (a reply or an event), or nothing within the timeout.
    std::optional<json::Value> next() {
        std::unique_lock lock(mutex_);
        if (!changed_.wait_for(lock, kClientTimeout, [this] { return !received_.empty(); })) {
            return std::nullopt;
        }
        json::Value out = json::parse(received_.front());
        received_.pop_front();
        return out;
    }

    // Closes the socket from the client side and waits until it is closed.
    void close() { socket_.stop(); }

    // Sends without waiting for a reply (one may never come: the engine can end first).
    void send(const std::string& text) { socket_.sendText(text); }

    // True once the server has closed the socket (within the timeout).
    bool waitClosed() {
        std::unique_lock lock(mutex_);
        return changed_.wait_for(lock, kClientTimeout, [this] { return closed_; });
    }

private:
    ix::WebSocket socket_;
    std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<std::string> received_;
    bool open_ = false;
    bool closed_ = false;
};

// A client of the realtime channel (kRealtimePath): one auth frame, then the
// binary frames in arrival order.
class RealtimeClient {
public:
    explicit RealtimeClient(std::uint16_t port) {
        socket_.setUrl("ws://127.0.0.1:" + std::to_string(port) + std::string(kRealtimePath));
        ix::WebSocketHttpHeaders headers;
        headers["Origin"] = std::string(kAppOrigin);
        socket_.setExtraHeaders(headers);
        socket_.disableAutomaticReconnection();
        socket_.setOnMessageCallback([this](const ix::WebSocketMessagePtr& message) {
            std::lock_guard lock(mutex_);
            if (message->type == ix::WebSocketMessageType::Open) {
                open_ = true;
            } else if (message->type == ix::WebSocketMessageType::Close ||
                       message->type == ix::WebSocketMessageType::Error) {
                closed_ = true;
            } else if (message->type == ix::WebSocketMessageType::Message && message->binary) {
                frames_.push_back(message->str);
            }
            changed_.notify_all();
        });
    }
    ~RealtimeClient() { socket_.stop(); }
    RealtimeClient(const RealtimeClient&) = delete;
    RealtimeClient& operator=(const RealtimeClient&) = delete;

    bool start(const std::string& token) {
        socket_.start();
        {
            std::unique_lock lock(mutex_);
            if (!changed_.wait_for(lock, kClientTimeout, [this] { return open_; })) {
                return false;
            }
        }
        socket_.sendText(jcs::canonicalize(json::Value(json::Object{{"type", json::Value("auth")},
                                                                    {"token", json::Value(token)}})));
        return true;
    }

    // The next frame, or nullopt when none comes in time or the socket closed.
    std::optional<MeterFrame> next() {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, kClientTimeout, [this] { return !frames_.empty() || closed_; });
        if (frames_.empty()) {
            return std::nullopt;
        }
        const std::string bytes = std::move(frames_.front());
        frames_.pop_front();
        return decodeMeterFrame(bytes);
    }

private:
    ix::WebSocket socket_;
    std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<std::string> frames_;
    bool open_ = false;
    bool closed_ = false;
};

}  // namespace siann::protocol::testing
