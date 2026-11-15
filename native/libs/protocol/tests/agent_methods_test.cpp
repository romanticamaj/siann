// Agent presence (spec, Protocol v0 item 29, m5b-engine-plan-metadata, UI
// redesign E-14): engine.status.agents, the agent.changed event, the idle
// interval on the injected steady clock, and the capabilities. The MCP side goes
// through the thread-free seam ProtocolServer::handleMcp and pump() runs on the
// test thread; the transport port is a fake, as in transport_methods_test.cpp.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "siann/protocol/transport_port.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::HttpRequest;
using protocol::HttpResponse;
using protocol::ServerOptions;

namespace {

class StatusPort final : public protocol::TransportPort {
public:
    protocol::TransportState play() override { return {}; }
    protocol::TransportState stop() override { return {}; }
    protocol::TransportState locate(std::int64_t) override { return {}; }
    protocol::TransportState setCycle(bool) override { return {}; }
    protocol::TransportState setClick(bool, std::optional<std::int32_t>) override { return {}; }
    protocol::EngineStatus status() const override {
        protocol::EngineStatus out;
        out.device = protocol::DeviceInfo{"fake", 48'000, 256, 256, 256};
        return out;
    }
    std::vector<protocol::DeviceDescription> devices() const override { return {}; }
    protocol::DeviceInfo selectDevice(const std::string& id) override {
        return protocol::DeviceInfo{id, 48'000, 256, 256, 256};
    }
};

// The server's two clocks, moved by the test.
struct Clocks {
    std::string wall = "2026-11-15T10:00:00Z";
    std::chrono::steady_clock::time_point steady{std::chrono::hours(1)};
};

ServerOptions agentOptions(Clocks& clocks, StatusPort* port) {
    ServerOptions options = manualOptions();
    options.clock = [&clocks] { return clocks.wall; };
    options.steadyClock = [&clocks] { return clocks.steady; };
    options.transportPort = port;
    options.agentIdleMs = std::chrono::milliseconds(60'000);
    return options;
}

// One MCP client over handleMcp.
struct Agent {
    explicit Agent(Fixture& fixture) : f(fixture) {}

    HttpResponse send(HttpRequest r) {
        std::optional<HttpResponse> got;
        f.server.handleMcp(r, [&got](HttpResponse response) { got = std::move(response); });
        if (!got) {
            f.server.pump();
        }
        REQUIRE(got.has_value());
        return *got;
    }

    HttpRequest request(std::string body, std::string method = "POST") const {
        HttpRequest r{std::move(method), "/v0/mcp", {{"authorization", "Bearer " + f.server.mcpToken()}},
                      std::move(body)};
        r.headers["content-type"] = "application/json";
        if (!session.empty()) {
            r.headers["mcp-session-id"] = session;
        }
        return r;
    }

    HttpResponse rpc(const std::string& method, Value params = Value(Object{})) {
        return send(request(canonical(Value(Object{{"jsonrpc", Value("2.0")},
                                                   {"id", Value(++nextId)},
                                                   {"method", Value(method)},
                                                   {"params", std::move(params)}}))));
    }

    void initialize(const std::string& name) {
        const HttpResponse response =
            rpc("initialize", Value(Object{{"protocolVersion", Value("2025-06-18")},
                                           {"clientInfo", Value(Object{{"name", Value(name)}, {"version", Value("1")}})}}));
        REQUIRE(response.status == 200);
        session = response.headers.at("Mcp-Session-Id");
    }

    Value tool(const std::string& name, Value arguments) {
        const HttpResponse response = rpc("tools/call", Value(Object{{"name", Value(name)}, {"arguments", std::move(arguments)}}));
        REQUIRE(response.status == 200);
        return at(json::parse(response.body), "result");
    }

    Fixture& f;
    std::string session;
    int nextId = 0;
};

Value agentsOf(Fixture& f, ConnectionId c) {
    return at(f.ok(c, "engine.status"), "agents");
}

// The agent.changed payloads a connection received after the first `from` events.
std::vector<Value> agentEvents(const Fixture& f, ConnectionId watcher, std::size_t from = 0) {
    std::vector<Value> out;
    const auto all = f.events(watcher);
    for (std::size_t i = from; i < all.size(); ++i) {
        if (at(all[i], "type").asString() == "agent.changed") {
            out.push_back(at(all[i], "agent"));
        }
    }
    return out;
}

const std::string kMarker = "MARKER-7f3a-never-in-a-payload";

}  // namespace

TEST_CASE("engine.status lists no agent before initialize, then the MCP session's agent", "[protocol][agents]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(agentOptions(clocks, &port));
    const ConnectionId c = f.authed();
    CHECK(agentsOf(f, c).asArray().empty());

    Agent agent(f);
    agent.initialize("mix-assistant");
    f.server.pump();
    const Value agents = agentsOf(f, c);
    REQUIRE(agents.asArray().size() == 1);
    const Value& entry = agents.asArray()[0];
    const std::string id = at(entry, "id").asString();
    CHECK(id.rfind("agt_", 0) == 0);
    CHECK(id != agent.session);
    CHECK(canonical(agents).find(agent.session) == std::string::npos);
    CHECK(at(entry, "name").asString() == "mix-assistant");
    CHECK(at(entry, "transport").asString() == "mcp");
    CHECK(at(entry, "connected").asBool());
    CHECK(at(entry, "lastAction").isNull());
    CHECK(at(entry, "lastActionAt").isNull());
    CHECK(entry.asObject().size() == 6);

    // A second session is a second agent, in initialize order.
    Agent other(f);
    other.initialize("helper");
    f.server.pump();
    const Value both = agentsOf(f, c);
    REQUIRE(both.asArray().size() == 2);
    CHECK(at(both.asArray()[0], "id").asString() == id);
    CHECK(at(both.asArray()[1], "name").asString() == "helper");
    CHECK(at(both.asArray()[1], "id").asString() != id);
}

TEST_CASE("a second client sees agent.changed on connect, action, idle, reconnect and DELETE",
          "[protocol][agents][events]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(agentOptions(clocks, &port));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    const ConnectionId watcher = f.authed(true);
    std::size_t mark = f.events(watcher).size();
    const auto changes = [&] {
        auto out = agentEvents(f, watcher, mark);
        mark = f.events(watcher).size();
        return out;
    };

    Agent agent(f);
    agent.initialize("mix-assistant");
    f.server.pump();
    auto events = changes();
    REQUIRE(events.size() == 1);
    const std::string id = at(events[0], "id").asString();
    CHECK(at(events[0], "name").asString() == "mix-assistant");
    CHECK(at(events[0], "transport").asString() == "mcp");
    CHECK(at(events[0], "connected").asBool());
    CHECK(at(events[0], "lastAction").isNull());
    CHECK(canonical(events[0]) == canonical(agentsOf(f, c).asArray()[0]));
    f.server.pump();
    CHECK(changes().empty());  // nothing changed since

    // A tool call: lastAction is the tool's name and lastActionAt the server clock;
    // the arguments appear nowhere in the agent's payload or status.
    clocks.wall = "2026-11-15T10:00:05Z";
    const Value result = agent.tool(
        "submit_plan", Value(Object{{"steps", Value(Array{Value(Object{{"op", Value("track.set_gain")},
                                                                       {"trackId", Value("trk_a")},
                                                                       {"gainMilliDb", Value(-600)}})})},
                                    {"intent", Value(kMarker)},
                                    {"baseRevision", Value(kMarker)}}));
    CHECK(at(result, "isError").asBool());  // the marker is no revision: not_found
    events = changes();
    REQUIRE(events.size() == 1);
    CHECK(at(events[0], "id").asString() == id);
    CHECK(at(events[0], "lastAction").asString() == "submit_plan");
    CHECK(at(events[0], "lastActionAt").asString() == "2026-11-15T10:00:05Z");
    CHECK(at(events[0], "connected").asBool());
    CHECK(canonical(events[0]).find(kMarker) == std::string::npos);
    CHECK(canonical(agentsOf(f, c)).find(kMarker) == std::string::npos);
    for (const Value& event : f.events(watcher)) {
        if (at(event, "type").asString() == "agent.changed") {
            CHECK(canonical(event).find(kMarker) == std::string::npos);
        }
    }

    // The same tool again at the same time is still an action.
    agent.tool("inspect_session", Value(Object{}));
    events = changes();
    REQUIRE(events.size() == 1);
    CHECK(at(events[0], "lastAction").asString() == "inspect_session");

    // Idle: just before the interval nothing changes, at it the agent disconnects.
    clocks.steady += std::chrono::milliseconds(59'999);
    f.server.pump();
    CHECK(changes().empty());
    clocks.steady += std::chrono::milliseconds(1);
    f.server.pump();
    events = changes();
    REQUIRE(events.size() == 1);
    CHECK_FALSE(at(events[0], "connected").asBool());
    CHECK(at(events[0], "lastAction").asString() == "inspect_session");
    CHECK_FALSE(at(agentsOf(f, c).asArray()[0], "connected").asBool());
    f.server.pump();
    CHECK(changes().empty());

    // Any request after idling reconnects it (the session was not ended).
    const HttpResponse ping = agent.rpc("ping");
    CHECK(ping.status == 200);
    f.server.pump();
    events = changes();
    REQUIRE(events.size() == 1);
    CHECK(at(events[0], "id").asString() == id);
    CHECK(at(events[0], "connected").asBool());

    // DELETE ends the session and disconnects the agent; it stays listed.
    const HttpResponse ended = agent.send(agent.request("", "DELETE"));
    CHECK(ended.status == 204);
    f.server.pump();
    events = changes();
    REQUIRE(events.size() == 1);
    CHECK_FALSE(at(events[0], "connected").asBool());
    REQUIRE(agentsOf(f, c).asArray().size() == 1);
    CHECK(agent.rpc("ping").status == 404);
    f.server.pump();
    CHECK(changes().empty());
}

TEST_CASE("engine.capabilities lists planMetadata, agents and the agent limits", "[protocol][agents][capabilities]") {
    Clocks clocks;
    StatusPort port;
    {
        Fixture f(agentOptions(clocks, &port));
        const ConnectionId c = f.authed();
        const Value capabilities = f.ok(c, "engine.capabilities");
        CHECK(at(at(capabilities, "features"), "planMetadata").asBool());
        CHECK(at(at(capabilities, "features"), "agents").asBool());
        CHECK(at(at(capabilities, "limits"), "agentIdleMs").asNumber() == 60'000);
        CHECK(at(at(capabilities, "limits"), "agentsRetained").asNumber() == 32);
    }
    {
        // Without a transport port there is no engine.status, so no agent list.
        Fixture f(agentOptions(clocks, nullptr));
        const ConnectionId c = f.authed();
        const Value capabilities = f.ok(c, "engine.capabilities");
        CHECK(at(at(capabilities, "features"), "planMetadata").asBool());
        CHECK_FALSE(at(at(capabilities, "features"), "agents").asBool());
        CHECK(at(at(capabilities, "limits"), "agentIdleMs").asNumber() == 60'000);
    }
    {
        // The documented default interval.
        Fixture f;
        const ConnectionId c = f.authed();
        CHECK(at(at(f.ok(c, "engine.capabilities"), "limits"), "agentIdleMs").asNumber() == 300'000);
    }
}

TEST_CASE("past agentsRetained the oldest disconnected agent is forgotten", "[protocol][agents]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(agentOptions(clocks, &port));
    const ConnectionId c = f.authed();
    std::vector<Agent> agents;
    agents.reserve(34);
    for (int i = 0; i < 32; ++i) {
        agents.emplace_back(f);
        agents.back().initialize("agent-" + std::to_string(i));
    }
    // The first one ends its session; the 33rd initialize forgets it.
    agents[0].send(agents[0].request("", "DELETE"));
    f.server.pump();
    agents.emplace_back(f);
    agents.back().initialize("agent-32");
    f.server.pump();
    const Value listed = agentsOf(f, c);
    REQUIRE(listed.asArray().size() == 32);
    CHECK(at(listed.asArray()[0], "name").asString() == "agent-1");
    CHECK(at(listed.asArray()[31], "name").asString() == "agent-32");

    // All 32 connected: the 34th ends the oldest session (later requests are 404).
    agents.emplace_back(f);
    agents.back().initialize("agent-33");
    f.server.pump();
    const Value after = agentsOf(f, c);
    REQUIRE(after.asArray().size() == 32);
    CHECK(at(after.asArray()[0], "name").asString() == "agent-2");
    CHECK(agents[1].rpc("ping").status == 404);
    CHECK(agents[2].rpc("ping").status == 200);
}
