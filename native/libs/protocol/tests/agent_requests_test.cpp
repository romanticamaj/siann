// Agent requests (spec, Protocol v0 item 30, m5b-engine-agent-requests, gate
// agent-request-shape; UI redesign UR-16): agent.request and its siblings from
// the UI, next_request and answer_request for the agent, the request link of
// plan.submit, the expiry, the list and the capabilities. The MCP side goes
// through the thread-free seam ProtocolServer::handleMcp and pump() runs on the
// test thread, so a parked next_request stays unanswered until the pump that
// answers it; the wait runs on the injected steady clock, never on a sleep.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "../src/mcp_adapter.hpp"  // the tool table
#include "siann/model/document.hpp"
#include "siann/protocol/transport_port.hpp"
#include "siann/session/session.hpp"
#include "support/mcp_agent.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::HttpResponse;
using protocol::McpScope;
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
        out.position = position;
        return out;
    }
    std::vector<protocol::DeviceDescription> devices() const override { return {}; }
    protocol::DeviceInfo selectDevice(const std::string& id) override {
        return protocol::DeviceInfo{id, 48'000, 256, 256, 256};
    }

    std::int64_t position = 0;
};

ServerOptions requestOptions(Clocks& clocks, StatusPort* port) {
    ServerOptions options = manualOptions();
    options.clock = [&clocks] { return clocks.wall; };
    options.steadyClock = [&clocks] { return clocks.steady; };
    options.transportPort = port;
    options.agentIdleMs = std::chrono::milliseconds(60'000);
    return options;
}

using std::chrono::milliseconds;

Value setLocators(const std::string& left, const std::string& right) {
    return Value(Object{{"op", Value("session.set_locators")}, {"left", Value(left)}, {"right", Value(right)}});
}

Value trackGain(const std::string& id, int milliDb) {
    return Value(Object{{"op", Value("track.set_gain")}, {"trackId", Value(id)}, {"gainMilliDb", Value(milliDb)}});
}

// The agent id engine.status lists for the agent named `name`.
std::string agentIdOf(Fixture& f, ConnectionId c, const std::string& name) {
    const Value status = f.ok(c, "engine.status");
    for (const Value& agent : at(status, "agents").asArray()) {
        if (at(agent, "name").asString() == name) {
            return at(agent, "id").asString();
        }
    }
    FAIL("no agent named " << name);
    return {};
}

Value agentEntry(Fixture& f, ConnectionId c, const std::string& id) {
    const Value status = f.ok(c, "engine.status");
    for (const Value& agent : at(status, "agents").asArray()) {
        if (at(agent, "id").asString() == id) {
            return agent;
        }
    }
    FAIL("no agent " << id);
    return {};
}

Value ask(const std::string& agentId, const std::string& text) {
    return Value(Object{{"agentId", Value(agentId)}, {"text", Value(text)}});
}

Value askWith(const std::string& agentId, const std::string& text, Value selection) {
    return Value(Object{{"agentId", Value(agentId)}, {"text", Value(text)}, {"selection", std::move(selection)}});
}

// agent.request from the UI; the request object.
Value requested(Fixture& f, ConnectionId c, const std::string& agentId, const std::string& text) {
    return at(f.ok(c, "agent.request", ask(agentId, text)), "request");
}

std::string idOf(const Value& request) {
    return at(request, "id").asString();
}

std::string stateOf(const Value& request) {
    return at(request, "state").asString();
}

Value byId(const std::string& id) {
    return Value(Object{{"request", Value(id)}});
}

std::vector<Value> listed(Fixture& f, ConnectionId c) {
    return at(f.ok(c, "agent.requests"), "requests").asArray();
}

// The agent.request_changed payloads a connection received after `from` events.
std::vector<Value> requestEvents(const Fixture& f, ConnectionId watcher, std::size_t from = 0) {
    std::vector<Value> out;
    const auto all = f.events(watcher);
    for (std::size_t i = from; i < all.size(); ++i) {
        if (at(all[i], "type").asString() == "agent.request_changed") {
            out.push_back(at(all[i], "request"));
        }
    }
    return out;
}

std::size_t countOfType(const Fixture& f, ConnectionId watcher, const std::string& type, std::size_t from = 0) {
    const auto all = f.events(watcher);
    std::size_t n = 0;
    for (std::size_t i = from; i < all.size(); ++i) {
        n += at(all[i], "type").asString() == type ? 1 : 0;
    }
    return n;
}

std::string repeat(const std::string& unit, std::size_t times) {
    std::string out;
    out.reserve(unit.size() * times);
    for (std::size_t i = 0; i < times; ++i) {
        out += unit;
    }
    return out;
}

// The next_request result's request (null when empty).
Value delivered(const McpAgent::Slot& slot) {
    return at(McpAgent::okOf(slot), "request");
}

}  // namespace

TEST_CASE("agent.request from the UI returns the pending request with the stamped context; a second client "
          "sees agent.request_changed",
          "[protocol][agents][requests]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(requestOptions(clocks, &port));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a"), setLocators("100", "200")});
    port.position = 4800;
    McpAgent agent(f);
    agent.initialize("mix-assistant");
    const std::string agentId = agentIdOf(f, c, "mix-assistant");
    const ConnectionId watcher = f.authed(true);
    const std::size_t mark = f.events(watcher).size();

    clocks.wall = "2026-11-15T10:01:00Z";
    const Value result = f.ok(c, "agent.request",
                              askWith(agentId, "Lower the drums",
                                      Value(Object{{"tracks", Value(Array{Value("trk_a")})},
                                                   {"clips", Value(Array{Value("clp_1"), Value("clp_2")})}})));
    REQUIRE(result.asObject().size() == 1);
    const Value& request = at(result, "request");
    CHECK(idOf(request).rfind("arq_", 0) == 0);
    CHECK(idOf(request).size() > 4);
    CHECK(at(request, "agentId").asString() == agentId);
    CHECK(at(request, "text").asString() == "Lower the drums");
    CHECK(stateOf(request) == "pending");
    CHECK(at(request, "createdAt").asString() == "2026-11-15T10:01:00Z");
    CHECK(request.find("plan") == nullptr);
    CHECK(request.find("message") == nullptr);
    const Value& context = at(request, "context");
    CHECK(canonical(at(context, "selection")) == R"({"clips":["clp_1","clp_2"],"tracks":["trk_a"]})");
    const Value& locators = at(context, "locators");
    CHECK(at(locators, "left").asString() == "100");
    CHECK(at(locators, "right").asString() == "200");
    CHECK(at(context, "cursor").asString() == "4800");
    CHECK(at(context, "headRevision").asString() == f.head().envelope.id);
    CHECK(context.asObject().size() == 4);

    // The second, subscribed client sees the queued request as the answer gave it.
    const auto events = requestEvents(f, watcher, mark);
    REQUIRE(events.size() == 1);
    CHECK(canonical(events[0]) == canonical(request));

    // Without a selection both lists are empty; without locators they are null.
    Fixture bare(requestOptions(clocks, &port));
    const ConnectionId b = bare.authed();
    McpAgent other(bare);
    other.initialize("helper");
    const Value plain = requested(bare, b, agentIdOf(bare, b, "helper"), "Hello");
    CHECK(canonical(at(at(plain, "context"), "selection")) == R"({"clips":[],"tracks":[]})");
    CHECK(at(at(plain, "context"), "locators").isNull());

    // Without a transport port the cursor is null (no engine.status: the id
    // comes from agent.changed).
    Fixture portless(requestOptions(clocks, nullptr));
    const ConnectionId p = portless.authed();
    const ConnectionId pw = portless.authed(true);
    McpAgent third(portless);
    third.initialize("third");
    portless.server.pump();
    std::string thirdId;
    for (const Value& event : portless.events(pw)) {
        if (at(event, "type").asString() == "agent.changed") {
            thirdId = at(at(event, "agent"), "id").asString();
        }
    }
    REQUIRE_FALSE(thirdId.empty());
    const Value noCursor = requested(portless, p, thirdId, "Hi");
    CHECK(at(at(noCursor, "context"), "cursor").isNull());
}

TEST_CASE("the request methods belong to one credential: scope_denied otherwise", "[protocol][agents][requests]") {
    for (const McpScope scope : {McpScope::propose, McpScope::trusted}) {
        Clocks clocks;
        StatusPort port;
        ServerOptions options = requestOptions(clocks, &port);
        options.mcpScope = scope;
        Fixture f(std::move(options));
        const ConnectionId c = f.authed();
        McpAgent agent(f);
        agent.initialize("mix-assistant");
        const std::string agentId = agentIdOf(f, c, "mix-assistant");
        const Value request = requested(f, c, agentId, "Lower the drums");

        // The agent's side with the UI token: scope_denied, and nothing changes.
        CHECK(errorCode(f.call(c, "agent.next_request")) == "scope_denied");
        CHECK(errorCode(f.call(c, "agent.answer_request",
                               Value(Object{{"request", Value(idOf(request))}, {"message", Value("hi")}}))) ==
              "scope_denied");
        CHECK(stateOf(listed(f, c).at(0)) == "pending");

        // The user's side has no MCP tool, under either scope: a tools/call
        // naming it reaches no method, and no tool maps it.
        for (const char* method : {"agent.request", "agent.cancel_request", "agent.requests"}) {
            for (const auto& tool : protocol::detail::mcpTools()) {
                CHECK(tool.method != method);
            }
            const HttpResponse response =
                agent.send(agent.request(McpAgent::body(Value(++agent.nextId), "tools/call",
                                                        McpAgent::toolParams(method, ask(agentId, "x")))));
            const Value parsed = json::parse(response.body);
            REQUIRE(parsed.find("error") != nullptr);
            CHECK(at(at(parsed, "error"), "code").asNumber() == -32602);
        }
        CHECK(listed(f, c).size() == 1);

        // The agent's side is in the propose scope.
        for (const auto& tool : protocol::detail::mcpTools()) {
            if (tool.name == "next_request" || tool.name == "answer_request") {
                CHECK(tool.scope == McpScope::propose);
            }
        }
    }
}

TEST_CASE("the text is 1 to 4,000 code points of display-safe UTF-8; selection ids are checked; the 17th open "
          "request is agent_busy",
          "[protocol][agents][requests]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(requestOptions(clocks, &port));
    const ConnectionId c = f.authed();
    McpAgent agent(f);
    agent.initialize("mix-assistant");
    const std::string agentId = agentIdOf(f, c, "mix-assistant");
    const ConnectionId watcher = f.authed(true);
    const std::size_t mark = f.events(watcher).size();

    // U+9F13 is three UTF-8 bytes: 4,000 of them are 12,000 bytes and accepted.
    const std::string drum = "\xE9\xBC\x93";
    const Value at4000 = requested(f, c, agentId, repeat(drum, 4000));
    CHECK(at(at4000, "text").asString().size() == 12'000);
    const Value ascii = requested(f, c, agentId, std::string(4000, 'a'));
    CHECK(at(ascii, "text").asString().size() == 4000);
    const Value controls = requested(f, c, agentId, "tab\there\nline\r\nend");
    CHECK(at(controls, "text").asString() == "tab\there\nline\r\nend");
    std::size_t queued = 3;
    REQUIRE(listed(f, c).size() == queued);
    REQUIRE(requestEvents(f, watcher, mark).size() == queued);

    const auto refused = [&](const Value& params, const std::string& code) {
        INFO(canonical(params).substr(0, 80));
        CHECK(errorCode(f.call(c, "agent.request", params)) == code);
        CHECK(listed(f, c).size() == queued);
        CHECK(requestEvents(f, watcher, mark).size() == queued);
    };
    refused(ask(agentId, repeat(drum, 4001)), "invalid_request_text");
    refused(ask(agentId, std::string(4001, 'a')), "invalid_request_text");
    refused(ask(agentId, ""), "invalid_request_text");
    // Text that is not UTF-8 never reaches the method: the frame is no JSON.
    for (const std::string& raw : {std::string("bad \xC3"), std::string("\xC0\xAF"), std::string("\xED\xA0\x80")}) {
        f.transport.deliver(c, R"({"method":"agent.request","params":{"agentId":")" + agentId + R"(","text":")" + raw +
                                   R"("},"requestId":"raw","sessionId":")" + f.server.sessionId() + R"("})");
        f.server.pump();
        const Value reply = json::parse(f.transport.sent(c).back());
        CHECK_FALSE(at(reply, "ok").asBool());
        CHECK(listed(f, c).size() == queued);
    }
    refused(ask(agentId, "Lower \xE2\x80\xAE" "smurd"), "invalid_request_text");  // U+202E RLO
    refused(ask(agentId, "two\xE2\x80\xA8" "lines"), "invalid_request_text");     // U+2028 LS
    refused(ask(agentId, std::string("bell\x01")), "invalid_request_text");     // C0 other than tab, LF, CR
    refused(ask(agentId, "\xC2\x85next"), "invalid_request_text");              // U+0085, C1
    refused(Value(Object{{"agentId", Value(agentId)}, {"text", Value(7)}}), "invalid_params");
    refused(Value(Object{{"agentId", Value(agentId)}}), "invalid_params");
    refused(Value(Object{{"text", Value("hi")}}), "invalid_params");
    refused(Value(Object{{"agentId", Value(agentId)}, {"text", Value("hi")}, {"context", Value(Object{})}}),
            "invalid_params");

    // Selection: the ID shape only, at most 256 ids per list, no other member.
    Array many;
    for (int i = 0; i < 257; ++i) {
        many.push_back(Value("trk_" + std::to_string(i)));
    }
    refused(askWith(agentId, "hi", Value(Object{{"tracks", Value(Array{Value("bad id")})}})), "invalid_params");
    refused(askWith(agentId, "hi", Value(Object{{"clips", Value(Array{Value(std::string(65, 'c'))})}})),
            "invalid_params");
    refused(askWith(agentId, "hi", Value(Object{{"clips", Value(Array{Value("")})}})), "invalid_params");
    refused(askWith(agentId, "hi", Value(Object{{"tracks", Value(Array{Value(7)})}})), "invalid_params");
    refused(askWith(agentId, "hi", Value(Object{{"tracks", Value(many)}})), "invalid_params");
    refused(askWith(agentId, "hi", Value(Object{{"buses", Value(Array{})}})), "invalid_params");
    refused(askWith(agentId, "hi", Value(Array{})), "invalid_params");
    many.pop_back();
    const Value at256 = at(f.ok(c, "agent.request", askWith(agentId, "hi", Value(Object{{"tracks", Value(many)}}))),
                           "request");
    CHECK(at(at(at(at256, "context"), "selection"), "tracks").asArray().size() == 256);
    ++queued;

    // 16 open requests per agent: the 17th is agent_busy and nothing is queued.
    while (queued < 16) {
        requested(f, c, agentId, "more " + std::to_string(queued));
        ++queued;
    }
    refused(ask(agentId, "one too many"), "agent_busy");
    // A taken request is still open and still counts.
    const Value taken = agent.ok("next_request", Value(Object{{"waitMs", Value(0)}}));
    CHECK(stateOf(at(taken, "request")) == "taken");
    const std::size_t afterTake = requestEvents(f, watcher, mark).size();
    CHECK(errorCode(f.call(c, "agent.request", ask(agentId, "still too many"))) == "agent_busy");
    CHECK(requestEvents(f, watcher, mark).size() == afterTake);
    // Another agent's queue is its own.
    McpAgent other(f);
    other.initialize("helper");
    requested(f, c, agentIdOf(f, c, "helper"), "for the helper");
}

TEST_CASE("agent.request to an unknown or disconnected agent is agent_not_connected", "[protocol][agents][requests]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(requestOptions(clocks, &port));
    const ConnectionId c = f.authed();
    CHECK(errorCode(f.call(c, "agent.request", ask("agt_0000000000000000", "hi"))) == "agent_not_connected");

    McpAgent agent(f);
    agent.initialize("mix-assistant");
    const std::string agentId = agentIdOf(f, c, "mix-assistant");
    CHECK(agent.end().status == 204);
    CHECK(errorCode(f.call(c, "agent.request", ask(agentId, "hi"))) == "agent_not_connected");

    McpAgent idle(f);
    idle.initialize("idle");
    const std::string idleId = agentIdOf(f, c, "idle");
    clocks.steady += milliseconds(60'000);
    f.server.pump();
    CHECK(errorCode(f.call(c, "agent.request", ask(idleId, "hi"))) == "agent_not_connected");
    CHECK(listed(f, c).empty());
}

TEST_CASE("next_request returns the oldest pending request at once and marks it taken",
          "[protocol][agents][requests]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(requestOptions(clocks, &port));
    const ConnectionId c = f.authed();
    McpAgent agent(f);
    agent.initialize("mix-assistant");
    const std::string agentId = agentIdOf(f, c, "mix-assistant");
    const Value first = requested(f, c, agentId, "first");
    const Value second = requested(f, c, agentId, "second");
    const ConnectionId watcher = f.authed(true);
    const std::size_t mark = f.events(watcher).size();

    clocks.wall = "2026-11-15T10:02:00Z";
    const McpAgent::Slot slot = agent.startTool("next_request");
    REQUIRE(slot->has_value());  // answered in the pump that ran it
    const Value got = delivered(slot);
    CHECK(idOf(got) == idOf(first));
    CHECK(stateOf(got) == "taken");
    CHECK(at(got, "text").asString() == "first");
    CHECK(canonical(at(got, "context")) == canonical(at(first, "context")));
    const auto events = requestEvents(f, watcher, mark);
    REQUIRE(events.size() == 1);
    CHECK(canonical(events[0]) == canonical(got));
    // A delivering poll is an action.
    const Value entry = agentEntry(f, c, agentId);
    CHECK(at(entry, "lastAction").asString() == "next_request");
    CHECK(at(entry, "lastActionAt").asString() == "2026-11-15T10:02:00Z");

    CHECK(idOf(delivered(agent.startTool("next_request"))) == idOf(second));
    const auto all = listed(f, c);
    REQUIRE(all.size() == 2);
    CHECK(stateOf(all[0]) == "taken");
    CHECK(stateOf(all[1]) == "taken");
}

TEST_CASE("next_request parks with an empty queue: a later request, the wait, a second call and the clamp",
          "[protocol][agents][requests]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(requestOptions(clocks, &port));
    const ConnectionId c = f.authed();
    McpAgent agent(f);
    agent.initialize("mix-assistant");
    const std::string agentId = agentIdOf(f, c, "mix-assistant");

    // Parked: not answered in its pump; a later agent.request answers it in that pump.
    McpAgent::Slot parked = agent.startTool("next_request");
    CHECK_FALSE(parked->has_value());
    f.server.pump();
    CHECK_FALSE(parked->has_value());
    const Value request = requested(f, c, agentId, "Lower the drums");
    REQUIRE(parked->has_value());
    const Value got = delivered(parked);
    CHECK(idOf(got) == idOf(request));
    CHECK(stateOf(got) == "taken");
    CHECK(stateOf(listed(f, c).at(0)) == "taken");

    // The default wait, agentRequestWaitMs 25,000 ms on the steady clock.
    parked = agent.startTool("next_request");
    CHECK_FALSE(parked->has_value());
    clocks.steady += milliseconds(24'999);
    f.server.pump();
    CHECK_FALSE(parked->has_value());
    clocks.steady += milliseconds(1);
    f.server.pump();
    REQUIRE(parked->has_value());
    CHECK(delivered(parked).isNull());

    // waitMs shortens it; 0 answers at once; a bad waitMs is invalid_params.
    parked = agent.startTool("next_request", Value(Object{{"waitMs", Value(1000)}}));
    CHECK_FALSE(parked->has_value());
    clocks.steady += milliseconds(1000);
    f.server.pump();
    REQUIRE(parked->has_value());
    CHECK(delivered(parked).isNull());
    CHECK(delivered(agent.startTool("next_request", Value(Object{{"waitMs", Value(0)}}))).isNull());
    CHECK(agent.error("next_request", Value(Object{{"waitMs", Value(-1)}})) == "invalid_params");
    CHECK(agent.error("next_request", Value(Object{{"waitMs", Value(1.5)}})) == "invalid_params");
    CHECK(agent.error("next_request", Value(Object{{"waitMs", Value("10")}})) == "invalid_params");
    // A waitMs above the limit is the limit.
    parked = agent.startTool("next_request", Value(Object{{"waitMs", Value(90'000)}}));
    clocks.steady += milliseconds(25'000);
    f.server.pump();
    REQUIRE(parked->has_value());
    CHECK(delivered(parked).isNull());

    // One parked call per agent: a second one answers the first with null.
    McpAgent::Slot one = agent.startTool("next_request");
    CHECK_FALSE(one->has_value());
    McpAgent::Slot two = agent.startTool("next_request");
    REQUIRE(one->has_value());
    CHECK(delivered(one).isNull());
    CHECK_FALSE(two->has_value());
    // Another agent's request does not answer it.
    McpAgent other(f);
    other.initialize("helper");
    requested(f, c, agentIdOf(f, c, "helper"), "for the helper");
    CHECK_FALSE(two->has_value());
    const Value mine = requested(f, c, agentId, "for me");
    REQUIRE(two->has_value());
    CHECK(idOf(delivered(two)) == idOf(mine));

    // The wait is clamped below mcpRequestTimeout (minus 1 s), and the limit says so.
    Clocks short_;
    ServerOptions options = requestOptions(short_, &port);
    options.mcpRequestTimeout = milliseconds(10'000);
    Fixture g(std::move(options));
    const ConnectionId d = g.authed();
    CHECK(at(at(g.ok(d, "engine.capabilities"), "limits"), "agentRequestWaitMs").asNumber() == 9'000);
    McpAgent clamped(g);
    clamped.initialize("clamped");
    McpAgent::Slot waiting = clamped.startTool("next_request");
    short_.steady += milliseconds(8'999);
    g.server.pump();
    CHECK_FALSE(waiting->has_value());
    short_.steady += milliseconds(1);
    g.server.pump();
    REQUIRE(waiting->has_value());
    CHECK(delivered(waiting).isNull());
}

TEST_CASE("a parked next_request keeps its agent connected; DELETE answers it", "[protocol][agents][requests]") {
    Clocks clocks;
    StatusPort port;
    ServerOptions options = requestOptions(clocks, &port);
    options.agentIdleMs = milliseconds(10'000);
    Fixture f(std::move(options));
    const ConnectionId c = f.authed();
    McpAgent agent(f);
    agent.initialize("mix-assistant");
    const std::string agentId = agentIdOf(f, c, "mix-assistant");

    McpAgent::Slot parked = agent.startTool("next_request");
    clocks.steady += milliseconds(20'000);
    f.server.pump();
    CHECK_FALSE(parked->has_value());
    CHECK(at(agentEntry(f, c, agentId), "connected").asBool());
    // A request queued now still reaches it.
    const Value request = requested(f, c, agentId, "hi");
    REQUIRE(parked->has_value());
    CHECK(idOf(delivered(parked)) == idOf(request));

    parked = agent.startTool("next_request");
    CHECK_FALSE(parked->has_value());
    CHECK(agent.end().status == 204);
    f.server.pump();
    REQUIRE(parked->has_value());
    CHECK(delivered(parked).isNull());
}

TEST_CASE("a retry of next_request with the same id returns the same request; an empty poll is no action",
          "[protocol][agents][requests]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(requestOptions(clocks, &port));
    const ConnectionId c = f.authed();
    McpAgent agent(f);
    agent.initialize("mix-assistant");
    const std::string agentId = agentIdOf(f, c, "mix-assistant");
    const ConnectionId watcher = f.authed(true);
    std::size_t mark = f.events(watcher).size();

    // Empty polls, at once and after the wait: no lastAction, no agent.changed, not cached.
    CHECK(delivered(agent.startTool(Value(7), "next_request", Value(Object{{"waitMs", Value(0)}}))).isNull());
    McpAgent::Slot waited = agent.startTool(Value(8), "next_request", Value(Object{{"waitMs", Value(500)}}));
    clocks.steady += milliseconds(500);
    f.server.pump();
    CHECK(delivered(waited).isNull());
    f.server.pump();
    CHECK(at(agentEntry(f, c, agentId), "lastAction").isNull());
    CHECK(countOfType(f, watcher, "agent.changed", mark) == 0);

    // The same id again after a request was queued: delivered, so nothing was cached.
    const Value first = requested(f, c, agentId, "first");
    const Value got = delivered(agent.startTool(Value(7), "next_request", Value(Object{{"waitMs", Value(0)}})));
    CHECK(idOf(got) == idOf(first));
    f.server.pump();
    CHECK(at(agentEntry(f, c, agentId), "lastAction").asString() == "next_request");
    CHECK(countOfType(f, watcher, "agent.changed", mark) == 1);

    // A retry of that id returns the same request, even with another one pending.
    const Value second = requested(f, c, agentId, "second");
    mark = f.events(watcher).size();
    const Value again = delivered(agent.startTool(Value(7), "next_request", Value(Object{{"waitMs", Value(0)}})));
    CHECK(canonical(again) == canonical(got));
    CHECK(requestEvents(f, watcher, mark).empty());
    CHECK(stateOf(listed(f, c).at(1)) == "pending");
    // A parked call delivered later is cached under its id too.
    McpAgent::Slot parked = agent.startTool(Value(9), "next_request");
    REQUIRE(parked->has_value());  // second is pending: delivered at once
    CHECK(idOf(delivered(parked)) == idOf(second));
    parked = agent.startTool(Value(10), "next_request");
    CHECK_FALSE(parked->has_value());
    const Value third = requested(f, c, agentId, "third");
    REQUIRE(parked->has_value());
    CHECK(idOf(delivered(parked)) == idOf(third));
    CHECK(idOf(delivered(agent.startTool(Value(10), "next_request"))) == idOf(third));
}

TEST_CASE("answer_request: a message, a decline, a plan the agent submitted; the refusals",
          "[protocol][agents][requests]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(requestOptions(clocks, &port));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    McpAgent agent(f);
    agent.initialize("mix-assistant");
    const std::string agentId = agentIdOf(f, c, "mix-assistant");
    McpAgent other(f);
    other.initialize("helper");
    const ConnectionId watcher = f.authed(true);

    const auto answer = [](const std::string& id, Object form) {
        form.emplace_back("request", Value(id));
        return Value(std::move(form));
    };

    // A message (the request was taken first).
    const std::string r1 = idOf(requested(f, c, agentId, "What is loud?"));
    CHECK(idOf(delivered(agent.startTool("next_request"))) == r1);
    std::size_t mark = f.events(watcher).size();
    const Value answered = at(agent.ok("answer_request", answer(r1, {{"message", Value("The drums.")}})), "request");
    CHECK(stateOf(answered) == "answered");
    CHECK(at(answered, "message").asString() == "The drums.");
    CHECK(answered.find("plan") == nullptr);
    auto events = requestEvents(f, watcher, mark);
    REQUIRE(events.size() == 1);
    CHECK(canonical(events[0]) == canonical(answered));

    // A decline, with and without a message; a pending request can be answered too.
    const std::string r2 = idOf(requested(f, c, agentId, "Delete everything"));
    const Value declined = at(agent.ok("answer_request", answer(r2, {{"decline", Value(true)}})), "request");
    CHECK(stateOf(declined) == "declined");
    CHECK(declined.find("message") == nullptr);
    const std::string r3 = idOf(requested(f, c, agentId, "Delete the drums"));
    const Value declinedWhy = at(agent.ok("answer_request", answer(r3, {{"decline", Value(true)},
                                                                         {"message", Value("Not without a backup.")}})),
                                 "request");
    CHECK(stateOf(declinedWhy) == "declined");
    CHECK(at(declinedWhy, "message").asString() == "Not without a backup.");

    // A plan the agent submitted.
    const std::string r4 = idOf(requested(f, c, agentId, "Lower the drums"));
    const Value plan = agent.ok("submit_plan", Value(Object{{"steps", Value(Array{trackGain("trk_a", -600)})}}));
    const std::string hash = at(plan, "hash").asString();
    const Value withPlan = at(agent.ok("answer_request", answer(r4, {{"plan", Value(hash)}})), "request");
    CHECK(stateOf(withPlan) == "answered");
    CHECK(at(withPlan, "plan").asString() == hash);
    CHECK(at(f.ok(c, "plan.status", Value(Object{{"plan", Value(hash)}})), "state").asString() == "validated");

    // Refusals: each changes nothing.
    const std::string r5 = idOf(requested(f, c, agentId, "Open"));
    mark = f.events(watcher).size();
    CHECK(other.error("answer_request", answer(r5, {{"message", Value("not mine")}})) == "request_not_open");
    CHECK(agent.error("answer_request", answer(r1, {{"message", Value("again")}})) == "request_not_open");
    CHECK(agent.error("answer_request", answer(r5, {{"message", Value("a")}, {"decline", Value(true)}})) ==
          "invalid_params");
    CHECK(agent.error("answer_request", answer(r5, {{"message", Value("a")}, {"plan", Value(hash)}})) ==
          "invalid_params");
    CHECK(agent.error("answer_request", answer(r5, {})) == "invalid_params");
    CHECK(agent.error("answer_request", answer(r5, {{"decline", Value(false)}})) == "invalid_params");
    CHECK(agent.error("answer_request", answer(r5, {{"message", Value(7)}})) == "invalid_params");
    CHECK(agent.error("answer_request", answer(r5, {{"message", Value("")}})) == "invalid_request_text");
    CHECK(agent.error("answer_request", answer(r5, {{"message", Value("x\xE2\x80\xAE" "y")}})) ==
          "invalid_request_text");
    CHECK(agent.error("answer_request", answer(r5, {{"message", Value(std::string(4001, 'm'))}})) ==
          "invalid_request_text");
    CHECK(agent.error("answer_request", answer("arq_0000", {{"message", Value("a")}})) == "not_found");
    CHECK(agent.error("answer_request", answer(r5, {{"plan", Value("sha256:" + std::string(64, '0'))}})) ==
          "not_found");
    // A plan the UI submitted, or another agent, is not this agent's answer.
    const std::string uiPlan =
        at(f.ok(c, "plan.submit", Value(Object{{"steps", Value(Array{trackGain("trk_a", -300)})}})), "hash").asString();
    const std::string otherPlan =
        at(other.ok("submit_plan", Value(Object{{"steps", Value(Array{trackGain("trk_a", -900)})}})), "hash")
            .asString();
    mark = f.events(watcher).size();
    CHECK(agent.error("answer_request", answer(r5, {{"plan", Value(uiPlan)}})) == "invalid_params");
    CHECK(agent.error("answer_request", answer(r5, {{"plan", Value(otherPlan)}})) == "invalid_params");
    CHECK(requestEvents(f, watcher, mark).empty());
    CHECK(stateOf(listed(f, c).at(0)) == "pending");  // r5, the only open one
    CHECK(agent.error("answer_request", Value(Object{{"message", Value("a")}})) == "invalid_params");
}

TEST_CASE("plan.submit {request} links the plan and answers the request; the head revision is unchanged",
          "[protocol][agents][requests][plans]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(requestOptions(clocks, &port));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    McpAgent agent(f);
    agent.initialize("mix-assistant");
    const std::string agentId = agentIdOf(f, c, "mix-assistant");
    McpAgent other(f);
    other.initialize("helper");
    const ConnectionId watcher = f.authed(true);
    const std::string headBefore = at(f.ok(c, "session.inspect"), "revision").asString();
    const std::size_t revisionsBefore =
        static_cast<std::size_t>(at(f.ok(c, "session.inspect"), "revisions").asNumber());

    const std::string r1 = idOf(requested(f, c, agentId, "Lower the drums"));
    CHECK(idOf(delivered(agent.startTool("next_request"))) == r1);
    std::size_t mark = f.events(watcher).size();
    const Value plan = agent.ok("submit_plan", Value(Object{{"steps", Value(Array{trackGain("trk_a", -600)})},
                                                            {"title", Value("Lower the drums")},
                                                            {"request", Value(r1)}}));
    const std::string hash = at(plan, "hash").asString();
    CHECK(plan.find("request") == nullptr);  // the link is not part of the plan
    CHECK(at(plan, "state").asString() == "validated");
    const auto events = requestEvents(f, watcher, mark);
    REQUIRE(events.size() == 1);
    CHECK(idOf(events[0]) == r1);
    CHECK(stateOf(events[0]) == "answered");
    CHECK(at(events[0], "plan").asString() == hash);
    // The request event follows the plan's plan.changed.
    const auto all = f.events(watcher);
    std::vector<std::string> types;
    for (std::size_t i = mark; i < all.size(); ++i) {
        types.push_back(at(all[i], "type").asString());
    }
    REQUIRE(types.size() >= 2);
    CHECK(types[0] == "plan.changed");
    CHECK(types[1] == "agent.request_changed");

    // The plan awaits the user's approval, and the document did not move.
    CHECK(at(f.ok(c, "plan.status", Value(Object{{"plan", Value(hash)}})), "state").asString() == "validated");
    const Value inspect = f.ok(c, "session.inspect");
    CHECK(at(inspect, "revision").asString() == headBefore);
    CHECK(static_cast<std::size_t>(at(inspect, "revisions").asNumber()) == revisionsBefore);
    CHECK(at(listed(f, c).at(0), "plan").asString() == hash);

    // Refused before anything is stored: the UI's submit with a request, another
    // agent's, a closed request, an unknown one.
    const std::string r2 = idOf(requested(f, c, agentId, "Pan the bass"));
    const std::size_t plansBefore = at(f.ok(c, "plan.list"), "plans").asArray().size();
    mark = f.events(watcher).size();
    const Value steps = Value(Array{trackGain("trk_a", -1200)});
    CHECK(errorCode(f.call(c, "plan.submit", Value(Object{{"steps", steps}, {"request", Value(r2)}}))) ==
          "invalid_params");
    CHECK(other.error("submit_plan", Value(Object{{"steps", steps}, {"request", Value(r2)}})) == "request_not_open");
    CHECK(agent.error("submit_plan", Value(Object{{"steps", steps}, {"request", Value(r1)}})) == "request_not_open");
    CHECK(agent.error("submit_plan", Value(Object{{"steps", steps}, {"request", Value("arq_0000")}})) == "not_found");
    CHECK(agent.error("submit_plan", Value(Object{{"steps", steps}, {"request", Value(7)}})) == "invalid_params");
    CHECK(at(f.ok(c, "plan.list"), "plans").asArray().size() == plansBefore);
    CHECK(f.events(watcher).size() == mark);
    CHECK(stateOf(listed(f, c).at(0)) == "pending");  // r2
}

TEST_CASE("agent.cancel_request cancels an open request; next_request does not deliver it",
          "[protocol][agents][requests]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(requestOptions(clocks, &port));
    const ConnectionId c = f.authed();
    McpAgent agent(f);
    agent.initialize("mix-assistant");
    const std::string agentId = agentIdOf(f, c, "mix-assistant");
    const ConnectionId watcher = f.authed(true);

    const std::string r1 = idOf(requested(f, c, agentId, "first"));
    const std::size_t mark = f.events(watcher).size();
    const Value cancelled = at(f.ok(c, "agent.cancel_request", byId(r1)), "request");
    CHECK(stateOf(cancelled) == "cancelled");
    const auto events = requestEvents(f, watcher, mark);
    REQUIRE(events.size() == 1);
    CHECK(canonical(events[0]) == canonical(cancelled));
    CHECK(delivered(agent.startTool("next_request", Value(Object{{"waitMs", Value(0)}}))).isNull());

    // A taken request can be cancelled too; the agent can no longer answer it.
    const std::string r2 = idOf(requested(f, c, agentId, "second"));
    CHECK(idOf(delivered(agent.startTool("next_request"))) == r2);
    CHECK(stateOf(at(f.ok(c, "agent.cancel_request", byId(r2)), "request")) == "cancelled");
    CHECK(agent.error("answer_request", Value(Object{{"request", Value(r2)}, {"message", Value("done")}})) ==
          "request_not_open");

    CHECK(errorCode(f.call(c, "agent.cancel_request", byId(r1))) == "request_not_open");
    CHECK(errorCode(f.call(c, "agent.cancel_request", byId("arq_0000"))) == "not_found");
    CHECK(errorCode(f.call(c, "agent.cancel_request", Value(Object{}))) == "invalid_params");
}

TEST_CASE("DELETE, idle and session.open expire the open requests", "[protocol][agents][requests]") {
    Clocks clocks;
    StatusPort port;
    std::optional<session::Session> opened;
    ServerOptions options = requestOptions(clocks, &port);
    options.openSession = [&](const std::filesystem::path& path) -> session::Session& {
        opened.emplace(session::Session::open(path));
        return *opened;
    };
    Fixture f(std::move(options));
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);

    // DELETE: both open requests (one taken) expire, a closed one stays as it was.
    McpAgent leaving(f);
    leaving.initialize("leaving");
    const std::string leavingId = agentIdOf(f, c, "leaving");
    const std::string a1 = idOf(requested(f, c, leavingId, "one"));
    const std::string a2 = idOf(requested(f, c, leavingId, "two"));
    const std::string a3 = idOf(requested(f, c, leavingId, "three"));
    CHECK(idOf(delivered(leaving.startTool("next_request"))) == a1);
    f.ok(c, "agent.cancel_request", byId(a3));
    std::size_t mark = f.events(watcher).size();
    CHECK(leaving.end().status == 204);
    f.server.pump();
    auto events = requestEvents(f, watcher, mark);
    REQUIRE(events.size() == 2);
    CHECK(idOf(events[0]) == a1);
    CHECK(stateOf(events[0]) == "expired");
    CHECK(idOf(events[1]) == a2);
    CHECK(stateOf(events[1]) == "expired");
    // The expiry goes out before the pump's agent.changed.
    const auto all = f.events(watcher);
    std::vector<std::string> types;
    for (std::size_t i = mark; i < all.size(); ++i) {
        types.push_back(at(all[i], "type").asString());
    }
    REQUIRE(types.size() == 3);
    CHECK(types[2] == "agent.changed");

    // Idle past agentIdleMs: expired; a reconnect does not revive them.
    McpAgent idle(f);
    idle.initialize("idle");
    const std::string idleId = agentIdOf(f, c, "idle");
    const std::string b1 = idOf(requested(f, c, idleId, "one"));
    mark = f.events(watcher).size();
    clocks.steady += milliseconds(60'000);
    f.server.pump();
    events = requestEvents(f, watcher, mark);
    REQUIRE(events.size() == 1);
    CHECK(idOf(events[0]) == b1);
    CHECK(stateOf(events[0]) == "expired");
    CHECK(idle.rpc("ping").status == 200);
    f.server.pump();
    CHECK(delivered(idle.startTool("next_request", Value(Object{{"waitMs", Value(0)}}))).isNull());

    // session.open: every open request expires, the connected agent's too.
    McpAgent staying(f);
    staying.initialize("staying");
    const std::string stayingId = agentIdOf(f, c, "staying");
    const std::string s1 = idOf(requested(f, c, stayingId, "one"));
    const std::string s2 = idOf(requested(f, c, idleId, "two"));
    const std::filesystem::path other = f.dir.bundle().parent_path() / "Other.siann";
    {
        const session::Session created = session::Session::create(other, model::Document::create("Other", 48'000),
                                                                  "tester", "2026-11-04T00:00:00Z");
    }
    mark = f.events(watcher).size();
    const std::u8string path = other.u8string();
    f.ok(c, "session.open", Value(Object{{"path", Value(std::string(path.begin(), path.end()))}}));
    events = requestEvents(f, watcher, mark);
    REQUIRE(events.size() == 2);
    CHECK(idOf(events[0]) == s1);
    CHECK(stateOf(events[0]) == "expired");
    CHECK(idOf(events[1]) == s2);
    CHECK(stateOf(events[1]) == "expired");
    for (const Value& request : listed(f, c)) {
        CHECK(stateOf(request) != "pending");
        CHECK(stateOf(request) != "taken");
    }
    // The agent stays connected and gets new requests.
    CHECK(stateOf(requested(f, c, stayingId, "after the open")) == "pending");
}

TEST_CASE("agent.requests lists the open requests and the last 16 closed ones", "[protocol][agents][requests]") {
    Clocks clocks;
    StatusPort port;
    Fixture f(requestOptions(clocks, &port));
    const ConnectionId c = f.authed();
    McpAgent agent(f);
    agent.initialize("mix-assistant");
    const std::string agentId = agentIdOf(f, c, "mix-assistant");
    CHECK(listed(f, c).empty());

    std::vector<std::string> closed;
    for (int i = 0; i < 16; ++i) {
        closed.push_back(idOf(requested(f, c, agentId, "closed " + std::to_string(i))));
    }
    // Closed in reverse order, so the list follows the closing, not the creation.
    for (auto it = closed.rbegin(); it != closed.rend(); ++it) {
        f.ok(c, "agent.cancel_request", byId(*it));
    }
    std::vector<std::string> closedOrder(closed.rbegin(), closed.rend());
    const std::string open1 = idOf(requested(f, c, agentId, "open 1"));
    const std::string c17 = idOf(requested(f, c, agentId, "closed 16"));
    const std::string open2 = idOf(requested(f, c, agentId, "open 2"));
    const std::string c18 = idOf(requested(f, c, agentId, "closed 17"));
    f.ok(c, "agent.cancel_request", byId(c17));
    agent.ok("answer_request", Value(Object{{"request", Value(c18)}, {"decline", Value(true)}}));
    closedOrder.push_back(c17);
    closedOrder.push_back(c18);

    // A client that connects later.
    const ConnectionId later = f.authed();
    const auto requests = listed(f, later);
    REQUIRE(requests.size() == 18);
    CHECK(idOf(requests[0]) == open1);
    CHECK(idOf(requests[1]) == open2);
    CHECK(stateOf(requests[0]) == "pending");
    for (std::size_t i = 0; i < 16; ++i) {
        CHECK(idOf(requests[2 + i]) == closedOrder[i + 2]);
    }
    CHECK(stateOf(requests[17]) == "declined");
}

TEST_CASE("engine.capabilities lists the request methods, features.agentRequests and the request limits",
          "[protocol][agents][requests][capabilities]") {
    Clocks clocks;
    StatusPort port;
    {
        Fixture f(requestOptions(clocks, &port));
        const ConnectionId c = f.authed();
        const Value capabilities = f.ok(c, "engine.capabilities");
        std::vector<std::string> methods;
        for (const Value& method : at(capabilities, "methods").asArray()) {
            methods.push_back(method.asString());
        }
        for (const char* method : {"agent.request", "agent.cancel_request", "agent.requests", "agent.next_request",
                                   "agent.answer_request"}) {
            INFO(method);
            CHECK(std::count(methods.begin(), methods.end(), method) == 1);
        }
        CHECK(at(at(capabilities, "features"), "agentRequests").asBool());
        const Value& limits = at(capabilities, "limits");
        CHECK(at(limits, "agentRequestsPerAgent").asNumber() == 16);
        CHECK(at(limits, "agentRequestTextChars").asNumber() == 4000);
        CHECK(at(limits, "agentRequestWaitMs").asNumber() == 25'000);
        CHECK(at(limits, "agentRequestsClosedRetained").asNumber() == 16);
    }
    {
        // As features.agents: without a transport port there is no agent list.
        Fixture f(requestOptions(clocks, nullptr));
        const ConnectionId c = f.authed();
        const Value capabilities = f.ok(c, "engine.capabilities");
        CHECK_FALSE(at(at(capabilities, "features"), "agentRequests").asBool());
        CHECK_FALSE(at(at(capabilities, "features"), "agents").asBool());
    }
    {
        // ServerOptions::agentRequestsPerAgent and agentRequestWaitMs set the limits.
        ServerOptions options = requestOptions(clocks, &port);
        options.agentRequestsPerAgent = 2;
        options.agentRequestWaitMs = milliseconds(5'000);
        Fixture f(std::move(options));
        const ConnectionId c = f.authed();
        const Value capabilities = f.ok(c, "engine.capabilities");
        const Value& limits = at(capabilities, "limits");
        CHECK(at(limits, "agentRequestsPerAgent").asNumber() == 2);
        CHECK(at(limits, "agentRequestWaitMs").asNumber() == 5'000);
        McpAgent agent(f);
        agent.initialize("small");
        const std::string agentId = agentIdOf(f, c, "small");
        requested(f, c, agentId, "one");
        requested(f, c, agentId, "two");
        CHECK(errorCode(f.call(c, "agent.request", ask(agentId, "three"))) == "agent_busy");
    }
}
