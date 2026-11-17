#pragma once

// An MCP client over the thread-free seam ProtocolServer::handleMcp, for the
// agent tests (agent requests, plan links): pump() runs on the test thread, so
// a call the command thread parks (next_request) stays unanswered until a
// later pump answers it, and the test sees exactly when.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "protocol_fixture.hpp"

namespace siann::protocol::testing {

// The server's two clocks, moved by the test.
struct Clocks {
    std::string wall = "2026-11-15T10:00:00Z";
    std::chrono::steady_clock::time_point steady{std::chrono::hours(1)};
};

struct McpAgent {
    explicit McpAgent(Harness& harness) : f(harness) {}

    using Slot = std::shared_ptr<std::optional<HttpResponse>>;

    HttpRequest request(std::string body, std::string method = "POST") const {
        HttpRequest r{std::move(method), "/v0/mcp", {{"authorization", "Bearer " + f.server.mcpToken()}},
                      std::move(body)};
        r.headers["content-type"] = "application/json";
        if (!session.empty()) {
            r.headers["mcp-session-id"] = session;
        }
        return r;
    }

    // Hands the request to the server and pumps once; the slot is empty while
    // the command thread holds the call.
    Slot start(HttpRequest r) {
        auto got = std::make_shared<std::optional<HttpResponse>>();
        f.server.handleMcp(r, [got](HttpResponse response) { *got = std::move(response); });
        if (!got->has_value()) {
            f.server.pump();
        }
        return got;
    }

    HttpResponse send(HttpRequest r) {
        const Slot got = start(std::move(r));
        REQUIRE(got->has_value());
        return **got;
    }

    static std::string body(const Value& id, const std::string& method, Value params) {
        return canonical(Value(Object{{"jsonrpc", Value("2.0")},
                                      {"id", id},
                                      {"method", Value(method)},
                                      {"params", std::move(params)}}));
    }

    HttpResponse rpc(const std::string& method, Value params = Value(Object{})) {
        return send(request(body(Value(++nextId), method, std::move(params))));
    }

    void initialize(const std::string& name) {
        const HttpResponse response =
            rpc("initialize", Value(Object{{"protocolVersion", Value("2025-06-18")},
                                           {"clientInfo", Value(Object{{"name", Value(name)}, {"version", Value("1")}})}}));
        REQUIRE(response.status == 200);
        session = response.headers.at("Mcp-Session-Id");
    }

    static Value toolParams(const std::string& name, Value arguments) {
        return Value(Object{{"name", Value(name)}, {"arguments", std::move(arguments)}});
    }

    // tools/call under a JSON-RPC id of the caller's choice; started, not awaited.
    Slot startTool(const Value& id, const std::string& name, Value arguments = Value(Object{})) {
        return start(request(body(id, "tools/call", toolParams(name, std::move(arguments)))));
    }

    Slot startTool(const std::string& name, Value arguments = Value(Object{})) {
        return startTool(Value(++nextId), name, std::move(arguments));
    }

    // The JSON-RPC result of an answered tools/call.
    static Value resultOf(const Slot& slot) {
        REQUIRE(slot->has_value());
        REQUIRE((*slot)->status == 200);
        const Value response = json::parse((*slot)->body);
        INFO((*slot)->body);
        return at(response, "result");
    }

    // The structured result of an answered, successful tool call.
    static Value okOf(const Slot& slot) {
        const Value result = resultOf(slot);
        INFO(canonical(result));
        REQUIRE_FALSE(at(result, "isError").asBool());
        return at(result, "structuredContent");
    }

    // The error code of an answered, failed tool call.
    static std::string errorOf(const Slot& slot) {
        const Value result = resultOf(slot);
        INFO(canonical(result));
        REQUIRE(at(result, "isError").asBool());
        return at(at(at(result, "structuredContent"), "error"), "code").asString();
    }

    Value ok(const std::string& name, Value arguments = Value(Object{})) {
        const Slot slot = startTool(name, std::move(arguments));
        return okOf(slot);
    }

    std::string error(const std::string& name, Value arguments = Value(Object{})) {
        const Slot slot = startTool(name, std::move(arguments));
        return errorOf(slot);
    }

    HttpResponse end() { return send(request("", "DELETE")); }

    Harness& f;
    std::string session;
    int nextId = 0;
};

}  // namespace siann::protocol::testing
