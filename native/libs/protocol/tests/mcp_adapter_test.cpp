// The MCP adapter (docs/schemas/protocol-mcp-v0.md) through the thread-free
// seam ProtocolServer::handleMcp: the response arrives at once or from
// pump() on the test thread.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <filesystem>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "support/protocol_fixture.hpp"
#include "../src/mcp_adapter.hpp"  // the tool table with each tool's scope
#include "siann/command/command.hpp"
#include "siann/protocol/record_port.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/protocol/about.hpp"
#include "siann/protocol/transport_port.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::HttpRequest;
using protocol::HttpResponse;
using protocol::McpScope;
using protocol::ServerOptions;

namespace {

const std::vector<std::string> kTools = {
    "list_commands",  "describe_capabilities", "inspect_session", "submit_plan",   "plan_status",
    "approve_plan",   "reject_plan",           "apply_plan",      "rollback_plan", "propose_plan",
    "audition",       "merge_proposal",        "discard_proposal", "execute",      "job_status",
    "render",         "open_session",          "save_session",    "play",          "stop",
    "locate",         "set_cycle",             "set_click",       "set_punch",     "set_preroll",
    "set_count_in",   "engine_status",         "list_devices",
    "select_device",  "record_arm",            "record",          "create_session", "import_media",
    "list_plans",     "preview_plan",          "undo",            "redo",
    "next_request",   "answer_request",
};

// The propose scope's tools: recording (m5b-engine-record) added none;
// m5b-protocol-parity added list_plans and preview_plan, which only read;
// agent requests (m5b-engine-agent-requests) the agent's two; punch, pre-roll and
// count-in (m5b-engine-punch-count-in) three that start nothing.
const std::vector<std::string> kProposeTools = {
    "list_commands", "describe_capabilities", "inspect_session", "submit_plan", "plan_status", "reject_plan",
    "propose_plan",  "audition",              "discard_proposal", "job_status", "render",     "save_session",
    "play",          "stop",                  "locate",           "set_cycle",  "set_click",  "set_punch",
    "set_preroll",   "set_count_in",          "engine_status",
    "list_devices",  "list_plans",            "preview_plan",     "next_request", "answer_request",
};

// A transport port that records what each tool reached.
class RecordingPort final : public protocol::TransportPort {
public:
    protocol::TransportState play() override { return reached("play", {true, position, cycle, click}); }
    protocol::TransportState stop() override { return reached("stop", {false, position, cycle, click}); }
    protocol::TransportState locate(std::int64_t frames) override {
        position = frames;
        return reached("locate", {false, frames, cycle, click});
    }
    protocol::TransportState setCycle(bool enabled) override {
        cycle = enabled;
        return reached("set_cycle", current());
    }
    protocol::TransportState setClick(bool enabled, std::optional<std::int32_t> gainMilliDb) override {
        click.enabled = enabled;
        if (gainMilliDb) {
            click.gainMilliDb = *gainMilliDb;
        }
        return reached("set_click", current());
    }
    protocol::TransportState setPunch(bool punchIn, bool punchOut) override {
        punch = protocol::PunchState{punchIn, punchOut};
        return reached("set_punch", current());
    }
    protocol::TransportState setPreroll(bool enabled, std::optional<std::int32_t> bars) override {
        preroll = protocol::BarsState{enabled, bars.value_or(preroll.bars)};
        return reached("set_preroll", current());
    }
    protocol::TransportState setCountIn(bool enabled, std::optional<std::int32_t> bars) override {
        countIn = protocol::BarsState{enabled, bars.value_or(countIn.bars)};
        return reached("set_count_in", current());
    }
    protocol::EngineStatus status() const override {
        protocol::EngineStatus out;
        out.device = protocol::DeviceInfo{"fake", 48'000, 256, 256, 256};
        out.cycle = cycle;
        out.click = click;
        out.punch = punch;
        out.preroll = preroll;
        out.countIn = countIn;
        out.load = protocol::DspLoad{0.125, 0.5};
        return out;
    }
    protocol::TransportState current() const {
        protocol::TransportState out{false, position, cycle, click};
        out.punch = punch;
        out.preroll = preroll;
        out.countIn = countIn;
        return out;
    }
    std::vector<protocol::DeviceDescription> devices() const override {
        return {{"fake", "fake", "fake", false, true}};
    }
    protocol::DeviceInfo selectDevice(const std::string& id) override {
        selected.push_back(id);
        calls.push_back("select");
        if (refusal) {
            throw protocol::TransportPortError(*refusal, "refused");
        }
        return protocol::DeviceInfo{id, 48'000, 256, 256, 256};
    }

    std::vector<std::string> calls;
    std::vector<std::string> selected;
    std::optional<std::string> refusal;
    std::int64_t position = 0;
    bool cycle = false;
    protocol::ClickState click;
    protocol::PunchState punch;
    protocol::BarsState preroll{false, protocol::BarsState::kDefaultPrerollBars};
    protocol::BarsState countIn{false, protocol::BarsState::kDefaultCountInBars};

private:
    protocol::TransportState reached(const std::string& name, protocol::TransportState state) {
        calls.push_back(name);
        if (refusal) {
            throw protocol::TransportPortError(*refusal, "refused");
        }
        return state;
    }
};

ServerOptions withTransport(protocol::TransportPort& port, McpScope scope) {
    ServerOptions options = manualOptions();
    options.mcpScope = scope;
    options.transportPort = &port;
    return options;
}

// An MCP client over handleMcp.
struct Mcp {
    explicit Mcp(Fixture& fixture) : f(fixture) {}

    HttpRequest request(const std::string& body, bool withSession = true) const {
        HttpRequest r{"POST", "/v0/mcp", {{"authorization", "Bearer " + f.server.mcpToken()}}, body};
        r.headers["content-type"] = "application/json";
        if (withSession && !sessionHeader.empty()) {
            r.headers["mcp-session-id"] = sessionHeader;
        }
        return r;
    }

    HttpResponse send(const HttpRequest& r) {
        std::optional<HttpResponse> got;
        f.server.handleMcp(r, [&got](HttpResponse response) { got = std::move(response); });
        if (!got) {
            f.server.pump();
        }
        REQUIRE(got.has_value());
        return *got;
    }

    HttpResponse post(const std::string& body, bool withSession = true) { return send(request(body, withSession)); }

    static std::string rpc(const Value& id, const std::string& method, Value params = Value(Object{})) {
        return jcs::canonicalize(Value(Object{{"jsonrpc", Value("2.0")},
                                              {"id", id},
                                              {"method", Value(method)},
                                              {"params", std::move(params)}}));
    }

    Value call(const Value& id, const std::string& method, Value params = Value(Object{})) {
        const HttpResponse response = post(rpc(id, method, std::move(params)));
        INFO(response.body);
        REQUIRE(response.status == 200);
        CHECK(response.contentType == "application/json");
        return json::parse(response.body);
    }

    // tools/call; returns the JSON-RPC result.
    Value tool(const std::string& name, Value arguments = Value(Object{})) {
        const Value response = call(Value(++nextId), "tools/call",
                                    Value(Object{{"name", Value(name)}, {"arguments", std::move(arguments)}}));
        INFO(canonical(response));
        return at(response, "result");
    }

    // A successful tool call's structured result.
    Value ok(const std::string& name, Value arguments = Value(Object{})) {
        const Value result = tool(name, std::move(arguments));
        INFO(canonical(result));
        REQUIRE_FALSE(at(result, "isError").asBool());
        return at(result, "structuredContent");
    }

    // A failed tool call's error object.
    Value error(const std::string& name, Value arguments = Value(Object{})) {
        const Value result = tool(name, std::move(arguments));
        INFO(canonical(result));
        REQUIRE(at(result, "isError").asBool());
        const Value& content = at(result, "content").asArray().at(0);
        const Value& structured = at(at(result, "structuredContent"), "error");
        CHECK(json::parse(at(content, "text").asString()).kind() == Value::Kind::object);
        CHECK(at(content, "text").asString() == canonical(structured));
        return structured;
    }

    void initialize() {
        const HttpResponse response =
            post(rpc(Value(0), "initialize",
                     Value(Object{{"protocolVersion", Value("2025-06-18")},
                                  {"capabilities", Value(Object{})},
                                  {"clientInfo", Value(Object{{"name", Value("test")}, {"version", Value("1")}})}})),
                 false);
        REQUIRE(response.status == 200);
        const auto header = response.headers.find("Mcp-Session-Id");
        REQUIRE(header != response.headers.end());
        sessionHeader = header->second;
    }

    Fixture& f;
    std::string sessionHeader;
    int nextId = 100;
};

ServerOptions trusted() {
    ServerOptions options = manualOptions();
    options.mcpScope = McpScope::trusted;
    return options;
}

Value commandsArray() {
    Array out;
    for (const std::string& name : command::commandNames()) {
        out.push_back(Value(name));
    }
    return Value(std::move(out));
}

// command::commandCascades() as command.list returns it (m5b-engine-buses-sends).
Value cascadesObject() {
    Object out;
    for (const auto& [name, types] : command::commandCascades()) {
        Array list;
        for (const std::string& type : types) {
            list.push_back(Value(type));
        }
        out.emplace_back(name, Value(std::move(list)));
    }
    return Value(std::move(out));
}

}  // namespace

TEST_CASE("initialize assigns an Mcp-Session-Id and reports the build", "[protocol][mcp]") {
    Fixture f;
    Mcp mcp(f);
    const HttpResponse response =
        mcp.post(Mcp::rpc(Value(1), "initialize", Value(Object{{"protocolVersion", Value("2025-06-18")}})), false);
    REQUIRE(response.status == 200);
    const auto header = response.headers.find("Mcp-Session-Id");
    REQUIRE(header != response.headers.end());
    CHECK(header->second.rfind("mcp_", 0) == 0);
    CHECK(header->second.size() == 4 + 32);
    const Value body = json::parse(response.body);
    CHECK(at(body, "jsonrpc").asString() == "2.0");
    CHECK(at(body, "id").asNumber() == 1);
    const Value& result = at(body, "result");
    CHECK(at(result, "protocolVersion").asString() == "2025-06-18");
    CHECK(at(at(result, "capabilities"), "tools").kind() == Value::Kind::object);
    CHECK(at(at(result, "serverInfo"), "name").asString() == protocol::buildInfo().name);
    CHECK(at(at(result, "serverInfo"), "version").asString() == protocol::buildInfo().version);

    // A second initialize gets another session.
    const HttpResponse again = mcp.post(Mcp::rpc(Value(2), "initialize", Value(Object{})), false);
    CHECK(again.headers.at("Mcp-Session-Id") != header->second);
}

TEST_CASE("requests need a known Mcp-Session-Id; notifications get 202", "[protocol][mcp]") {
    Fixture f;
    Mcp mcp(f);
    CHECK(mcp.post(Mcp::rpc(Value(1), "tools/list"), false).status == 400);
    mcp.sessionHeader = "mcp_" + std::string(32, '0');
    CHECK(mcp.post(Mcp::rpc(Value(1), "tools/list")).status == 404);

    mcp.initialize();
    const HttpResponse note = mcp.post(R"({"jsonrpc":"2.0","method":"notifications/initialized"})");
    CHECK(note.status == 202);
    CHECK(note.body.empty());
    CHECK(at(mcp.call(Value("p"), "ping"), "result").asObject().empty());
}

TEST_CASE("the bearer token, the Origin and the HTTP method are checked", "[protocol][mcp]") {
    Fixture f;
    Mcp mcp(f);
    HttpRequest r = mcp.request(Mcp::rpc(Value(1), "initialize"), false);
    r.headers.erase("authorization");
    CHECK(mcp.send(r).status == 401);
    CHECK(f.transport.http(r).status == 401);
    r = mcp.request(Mcp::rpc(Value(1), "initialize"), false);
    r.headers["origin"] = "http://evil.example";
    CHECK(mcp.send(r).status == 403);
    r = mcp.request("", false);
    r.method = "GET";
    CHECK(mcp.send(r).status == 405);
}

TEST_CASE("JSON-RPC errors: parse error, bad envelope, unknown method, unknown tool", "[protocol][mcp]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    const auto code = [&](const std::string& body) {
        const HttpResponse response = mcp.post(body);
        INFO(response.body);
        REQUIRE(response.status == 200);
        const Value parsed = json::parse(response.body);
        return at(at(parsed, "error"), "code").asNumber();
    };
    CHECK(code("{not json") == -32700);
    CHECK(code(R"([1,2])") == -32600);
    CHECK(code(R"({"jsonrpc":"1.0","id":1,"method":"ping"})") == -32600);
    CHECK(code(R"({"jsonrpc":"2.0","id":{},"method":"ping"})") == -32600);
    CHECK(code(R"({"jsonrpc":"2.0","id":1,"method":"resources/list"})") == -32601);
    CHECK(code(Mcp::rpc(Value(2), "tools/call", Value(Object{{"name", Value("nope")}}))) == -32602);
    CHECK(code(Mcp::rpc(Value(3), "tools/call",
                        Value(Object{{"name", Value("list_commands")}, {"arguments", Value(3)}}))) == -32602);
}

// m5-plugin-registry (Protocol v0 item 21): an agent must not choose what code
// loads, so the registry methods are no tool and an MCP request naming them is refused.
TEST_CASE("plugin.registry and plugin.approve are not MCP tools", "[protocol][mcp][plugin]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    const Value tools = at(at(mcp.call(Value(1), "tools/list"), "result"), "tools");
    for (const Value& tool : tools.asArray()) {
        const std::string name = at(tool, "name").asString();
        INFO(name);
        CHECK(name.find("registry") == std::string::npos);
        CHECK(name.find("approve_plugin") == std::string::npos);
        CHECK(name.find("plugin_approve") == std::string::npos);
    }
    const auto error = [&](const std::string& body) {
        const HttpResponse response = mcp.post(body);
        INFO(response.body);
        REQUIRE(response.status == 200);
        return at(at(json::parse(response.body), "error"), "code").asNumber();
    };
    for (const char* name : {"plugin.registry", "plugin.approve", "plugin_registry", "plugin_approve", "approve_plugin"}) {
        INFO(name);
        CHECK(error(Mcp::rpc(Value(2), "tools/call",
                             Value(Object{{"name", Value(name)},
                                          {"arguments", Value(Object{{"format", Value("clap")},
                                                                     {"path", Value("/x.clap")},
                                                                     {"approved", Value(true)}})}}))) == -32602);
        CHECK(error(Mcp::rpc(Value(3), name, Value(Object{}))) == -32601);
    }
}

TEST_CASE("tools/list returns the 36 tools with input schemas", "[protocol][mcp]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    const Value tools = at(at(mcp.call(Value(1), "tools/list"), "result"), "tools");
    std::vector<std::string> names;
    for (const Value& tool : tools.asArray()) {
        names.push_back(at(tool, "name").asString());
        CHECK_FALSE(at(tool, "description").asString().empty());
        const Value& schema = at(tool, "inputSchema");
        CHECK(at(schema, "type").asString() == "object");
        CHECK(at(schema, "properties").kind() == Value::Kind::object);
    }
    CHECK(names == kTools);
}

TEST_CASE("list_commands returns the registry as text and structured content", "[protocol][mcp]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    const Value result = mcp.tool("list_commands");
    CHECK_FALSE(at(result, "isError").asBool());
    const Value expected = Value(Object{{"commands", commandsArray()}, {"cascades", cascadesObject()}});
    const Value& content = at(result, "content").asArray().at(0);
    CHECK(at(content, "type").asString() == "text");
    CHECK(at(content, "text").asString() == canonical(expected));
    CHECK(canonical(at(result, "structuredContent")) == canonical(expected));

    const Value capabilities = mcp.ok("describe_capabilities");
    CHECK(at(capabilities, "scope").asString() == "propose");
    CHECK(at(mcp.ok("inspect_session"), "revision").asString() == "r1");
}

TEST_CASE("a trusted tool under the default propose scope is scope_denied and runs nothing", "[protocol][mcp]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    const Value plan = mcp.ok("submit_plan", Value(Object{{"steps", Value(Array{trackAdd("trk_a")})}}));
    const std::string hash = at(plan, "hash").asString();

    for (const auto& [name, arguments] :
         std::vector<std::pair<std::string, Value>>{{"approve_plan", Value(Object{{"plan", Value(hash)}})},
                                                    {"apply_plan", Value(Object{{"plan", Value(hash)}})},
                                                    {"rollback_plan", Value(Object{{"plan", Value(hash)}})},
                                                    {"merge_proposal", Value(Object{{"branch", Value("p1")}})},
                                                    {"execute", Value(Object{{"commands", Value(Array{trackAdd("x")})}})},
                                                    {"open_session", Value(Object{{"path", Value("x")}})}}) {
        INFO(name);
        CHECK(at(mcp.error(name, arguments), "code").asString() == "scope_denied");
    }
    CHECK(at(mcp.ok("plan_status", Value(Object{{"plan", Value(hash)}})), "state").asString() == "validated");
    CHECK(f.session.history().revisions().size() == 1);

    // Not cached: the same JSON-RPC id answers again from the scope check.
    const std::string body = Mcp::rpc(Value(7), "tools/call",
                                      Value(Object{{"name", Value("approve_plan")},
                                                   {"arguments", Value(Object{{"plan", Value(hash)}})}}));
    CHECK(mcp.post(body).body == mcp.post(body).body);
    CHECK(at(mcp.ok("plan_status", Value(Object{{"plan", Value(hash)}})), "state").asString() == "validated");
    // propose-scope tools that only read or branch work.
    CHECK(at(mcp.ok("reject_plan", Value(Object{{"plan", Value(hash)}})), "state").asString() == "rejected");
}

TEST_CASE("under the trusted scope approve_plan and execute run", "[protocol][mcp]") {
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    const std::string hash =
        at(mcp.ok("submit_plan", Value(Object{{"steps", Value(Array{trackAdd("trk_a")})}})), "hash").asString();
    CHECK(at(mcp.ok("approve_plan", Value(Object{{"plan", Value(hash)}})), "state").asString() == "approved");
    CHECK(at(at(mcp.ok("apply_plan", Value(Object{{"plan", Value(hash)}})), "revision"), "cause").asString() ==
          "plan");
    CHECK(at(mcp.ok("describe_capabilities"), "scope").asString() == "trusted");
}

TEST_CASE("a retried JSON-RPC id returns the identical response and executes once", "[protocol][mcp]") {
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    const std::string body =
        Mcp::rpc(Value(9), "tools/call",
                 Value(Object{{"name", Value("execute")},
                              {"arguments", Value(Object{{"commands", Value(Array{trackAdd("trk_a")})}})}}));
    const HttpResponse first = mcp.post(body);
    const HttpResponse second = mcp.post(body);
    CHECK(first.status == 200);
    CHECK(second.body == first.body);
    CHECK(f.session.history().revisions().size() == 2);

    // A string id "9" is another request.
    const std::string other =
        Mcp::rpc(Value("9"), "tools/call",
                 Value(Object{{"name", Value("execute")},
                              {"arguments", Value(Object{{"commands", Value(Array{trackAdd("trk_b")})}})}}));
    CHECK(mcp.post(other).body != first.body);
    CHECK(f.session.history().revisions().size() == 3);

    // Another MCP session with the same id does not collide.
    Mcp second_client(f);
    second_client.initialize();
    const std::string third =
        Mcp::rpc(Value(9), "tools/call",
                 Value(Object{{"name", Value("execute")},
                              {"arguments", Value(Object{{"commands", Value(Array{trackAdd("trk_c")})}})}}));
    CHECK(second_client.post(third).body != first.body);
    CHECK(f.session.history().revisions().size() == 4);
}

TEST_CASE("a tool error is isError with the protocol error object and its data", "[protocol][mcp]") {
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    mcp.ok("execute", Value(Object{{"commands", Value(Array{trackAdd("trk_a")})}}));
    const Value gain = Value(Object{{"op", Value("track.set_gain")}, {"trackId", Value("trk_a")},
                                    {"gainMilliDb", Value(-600)}});
    const std::string hash = at(mcp.ok("submit_plan", Value(Object{{"steps", Value(Array{gain})}})), "hash").asString();
    const Value other = Value(Object{{"op", Value("track.set_gain")}, {"trackId", Value("trk_a")},
                                     {"gainMilliDb", Value(-100)}});
    mcp.ok("execute", Value(Object{{"commands", Value(Array{other})}}));

    const Value error = mcp.error("approve_plan", Value(Object{{"plan", Value(hash)}}));
    CHECK(at(error, "code").asString() == "plan_stale");
    CHECK_FALSE(at(error, "message").asString().empty());
    CHECK(at(at(error, "data"), "plan").asString() == hash);
    REQUIRE(at(at(error, "data"), "changedEntities").asArray().size() == 1);
    CHECK(at(at(at(error, "data"), "changedEntities").asArray()[0], "ref").asString() == "track:trk_a");

    // A failing command carries step.
    const Value bad = mcp.error("execute", Value(Object{{"commands", Value(Array{trackAdd("trk_z"), trackAdd("trk_z")})}}));
    CHECK(at(bad, "code").asString() == "already_exists");
    CHECK(at(bad, "step").asNumber() == 1);
}

TEST_CASE("every tool maps onto its protocol method", "[protocol][mcp]") {
    // With no audition port, no openSession and an unknown job, each tool
    // still reaches its method: the answer is that method's own error.
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    const std::string none = "sha256:" + std::string(64, '0');
    CHECK(at(mcp.error("plan_status", Value(Object{{"plan", Value(none)}})), "code").asString() == "not_found");
    CHECK(at(mcp.error("approve_plan", Value(Object{{"plan", Value(none)}})), "code").asString() == "not_found");
    CHECK(at(mcp.error("reject_plan", Value(Object{{"plan", Value(none)}})), "code").asString() == "not_found");
    CHECK(at(mcp.error("apply_plan", Value(Object{{"plan", Value(none)}})), "code").asString() == "not_found");
    CHECK(at(mcp.error("rollback_plan", Value(Object{{"plan", Value(none)}})), "code").asString() == "not_found");
    CHECK(at(mcp.error("propose_plan", Value(Object{{"plan", Value(none)}})), "code").asString() == "not_found");
    CHECK(at(mcp.error("audition", Value(Object{{"side", Value("main")}})), "code").asString() ==
          "audition_unavailable");
    CHECK(at(mcp.error("merge_proposal", Value(Object{{"branch", Value("p1")}})), "code").asString() == "not_found");
    CHECK(at(mcp.error("discard_proposal", Value(Object{{"branch", Value("p1")}})), "code").asString() ==
          "not_found");
    CHECK(at(mcp.error("job_status", Value(Object{{"jobId", Value("job_1")}})), "code").asString() == "not_found");
    CHECK(at(mcp.error("render", Value(Object{{"name", Value("a/b")}})), "code").asString() == "invalid_params");
    CHECK(at(mcp.error("open_session", Value(Object{{"path", Value("x")}})), "code").asString() == "not_supported");
    CHECK(at(mcp.ok("save_session"), "revision").asString() == "r1");
}

TEST_CASE("MCP clients hold their own credential: the UI token and the MCP token do not cross", "[protocol][mcp]") {
    // Spec, Security rules: a propose-scope agent must not reach plan.approve
    // by authenticating the WebSocket with the token it was given.
    Fixture f;
    const std::string& ui = f.server.token();
    const std::string& agent = f.server.mcpToken();
    CHECK(agent.size() == 64);
    CHECK(agent.find_first_not_of("0123456789abcdef") == std::string::npos);
    CHECK(agent != ui);

    // The UI token is refused on /v0/mcp.
    Mcp mcp(f);
    HttpRequest r = mcp.request(Mcp::rpc(Value(1), "initialize"), false);
    r.headers["authorization"] = "Bearer " + ui;
    CHECK(mcp.send(r).status == 401);
    CHECK(f.transport.http(r).status == 401);

    // The MCP token authenticates no WebSocket, realtime or plain HTTP route.
    const std::string authFrame =
        canonical(Value(Object{{"type", Value("auth")}, {"token", Value(agent)}, {"events", Value(true)}}));
    auto command = f.transport.connect();
    REQUIRE(command.connection.has_value());
    f.transport.deliver(*command.connection, authFrame);
    REQUIRE(f.transport.sent(*command.connection).size() == 1);
    CHECK(errorCode(json::parse(f.transport.sent(*command.connection)[0])) == "invalid_token");
    CHECK(f.transport.closed(*command.connection));
    auto realtime = f.transport.connectRealtime();
    REQUIRE(realtime.connection.has_value());
    f.transport.deliver(*realtime.connection, authFrame);
    CHECK(f.transport.closed(*realtime.connection));
    CHECK(f.transport.http(HttpRequest{"GET", "/v0/health", {{"authorization", "Bearer " + agent}}, {}}).status ==
          401);

    // So plan.approve stays out of the propose-scope agent's reach.
    mcp.initialize();
    const std::string hash =
        at(mcp.ok("submit_plan", Value(Object{{"steps", Value(Array{trackAdd("trk_a")})}})), "hash").asString();
    CHECK(at(mcp.error("approve_plan", Value(Object{{"plan", Value(hash)}})), "code").asString() == "scope_denied");
    CHECK(at(mcp.ok("plan_status", Value(Object{{"plan", Value(hash)}})), "state").asString() == "validated");
}

TEST_CASE("an MCP call queued behind session.open is session_mismatch, not cached, and its retry runs",
          "[protocol][mcp][session]") {
    // Spec, Protocol v0 item 5: session_mismatch is never cached and may be
    // retried with the same requestId; an MCP retry keeps its requestId.
    std::optional<session::Session> opened;
    ServerOptions options = manualOptions();
    options.openSession = [&](const std::filesystem::path& path) -> session::Session& {
        opened.emplace(session::Session::open(path));
        return *opened;
    };
    Fixture f(std::move(options));
    const std::filesystem::path bundle = f.dir.bundle().parent_path() / "Other.siann";
    {
        session::Session other = session::Session::create(bundle, model::Document::create("Other", 44'100), "tester",
                                                          "2026-11-04T00:00:00Z");
        other.commit({command::Command::fromJson(trackAdd("trk_other"))}, "tester", "2026-11-04T00:00:01Z");
    }
    Mcp mcp(f);
    mcp.initialize();
    const ConnectionId ui = f.authed();

    // One pump: the UI's session.open, then the agent's inspect_session,
    // queued under the old sessionId.
    const std::u8string text = bundle.u8string();
    f.transport.deliver(ui, f.request("open_1", "session.open",
                                      Value(Object{{"path", Value(std::string(text.begin(), text.end()))}})));
    const std::string body = Mcp::rpc(
        Value(5), "tools/call", Value(Object{{"name", Value("inspect_session")}, {"arguments", Value(Object{})}}));
    std::optional<HttpResponse> late;
    f.server.handleMcp(mcp.request(body), [&late](HttpResponse response) { late = std::move(response); });
    REQUIRE_FALSE(late.has_value());
    CHECK(f.server.pump() == 2);
    REQUIRE(late.has_value());
    const Value lateResult = at(json::parse(late->body), "result");
    REQUIRE(at(lateResult, "isError").asBool());
    CHECK(at(at(at(lateResult, "structuredContent"), "error"), "code").asString() == "session_mismatch");

    // The retry with the same JSON-RPC id runs against the session now served.
    const HttpResponse retried = mcp.post(body);
    INFO(retried.body);
    const Value retriedResult = at(json::parse(retried.body), "result");
    REQUIRE_FALSE(at(retriedResult, "isError").asBool());
    REQUIRE(opened.has_value());
    CHECK(at(at(retriedResult, "structuredContent"), "documentHash").asString() ==
          hash::formatHash(opened->history().head().envelope.documentHash));
    CHECK(at(at(retriedResult, "structuredContent"), "revisions").asNumber() == 2);
}

TEST_CASE("the transport and device tools reach their methods with the same params and results",
          "[protocol][mcp][transport]") {
    RecordingPort port;
    Fixture f(withTransport(port, McpScope::trusted));
    Mcp mcp(f);
    mcp.initialize();

    const Value played = mcp.ok("play");
    CHECK(at(played, "playing").asBool());
    CHECK(at(played, "position").asString() == "0");
    const Value located = mcp.ok("locate", Value(Object{{"frames", Value("48000")}}));
    CHECK(at(located, "position").asString() == "48000");
    CHECK(port.position == 48'000);
    CHECK_FALSE(at(mcp.ok("stop"), "playing").asBool());
    CHECK(at(at(mcp.ok("engine_status"), "device"), "id").asString() == "fake");
    const Value listed = mcp.ok("list_devices");
    const auto& devices = at(listed, "devices").asArray();
    REQUIRE(devices.size() == 1);
    CHECK(at(devices[0], "id").asString() == "fake");
    CHECK(at(devices[0], "current").asBool());
    CHECK(at(mcp.ok("select_device", Value(Object{{"id", Value("fake")}})), "id").asString() == "fake");
    CHECK(port.calls == std::vector<std::string>{"play", "locate", "stop", "select"});
    CHECK(port.selected == std::vector<std::string>{"fake"});

    // The method's own errors.
    CHECK(at(mcp.error("locate", Value(Object{{"frames", Value("-1")}})), "code").asString() == "invalid_params");
    port.refusal = "not_found";
    CHECK(at(mcp.error("select_device", Value(Object{{"id", Value("nope")}})), "code").asString() == "not_found");
    CHECK(port.selected.back() == "nope");
}

TEST_CASE("without a transport port the transport tools answer not_supported", "[protocol][mcp][transport]") {
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    for (const char* name : {"play", "stop", "engine_status", "list_devices"}) {
        INFO(name);
        CHECK(at(mcp.error(name), "code").asString() == "not_supported");
    }
    CHECK(at(mcp.error("locate", Value(Object{{"frames", Value("0")}})), "code").asString() == "not_supported");
    CHECK(at(mcp.error("select_device", Value(Object{{"id", Value("fake")}})), "code").asString() == "not_supported");
}

TEST_CASE("play under propose is allowed and a port's no_device is the tool's error", "[protocol][mcp][transport]") {
    RecordingPort port;
    port.refusal = "no_device";
    Fixture f(withTransport(port, McpScope::propose));
    Mcp mcp(f);
    mcp.initialize();
    for (const char* name : {"play", "stop"}) {
        INFO(name);
        const Value error = mcp.error(name);
        CHECK(at(error, "code").asString() == "no_device");
        CHECK(at(error, "message").asString() == "refused");
    }
    CHECK(at(mcp.error("locate", Value(Object{{"frames", Value("0")}})), "code").asString() == "no_device");
    CHECK(port.calls == std::vector<std::string>{"play", "stop", "locate"});
}

TEST_CASE("a propose client's select_device is scope_denied and runs nothing", "[protocol][mcp][transport]") {
    RecordingPort port;
    Fixture f(withTransport(port, McpScope::propose));
    Mcp mcp(f);
    mcp.initialize();
    CHECK(at(mcp.error("select_device", Value(Object{{"id", Value("fake")}})), "code").asString() == "scope_denied");
    CHECK(port.selected.empty());
    CHECK(port.calls.empty());
    // The propose tools around it run.
    CHECK(at(mcp.ok("list_devices"), "devices").asArray().size() == 1);
    CHECK(at(at(mcp.ok("engine_status"), "device"), "id").asString() == "fake");
    CHECK(at(mcp.ok("play"), "playing").asBool());
}

// m5b-engine-record: record_arm and record wrap record.arm and transport.record
// in the trusted scope only; the propose scope gains no tool.
namespace {

class ArmingPort final : public protocol::RecordPort {
public:
    protocol::RecordState arm(const std::string& trackId, bool armed) override {
        calls.push_back("arm");
        if (armed) {
            state.armed = {trackId};
        } else {
            state.armed.clear();
        }
        return state;
    }
    protocol::TransportState record(bool enabled) override {
        calls.push_back("record");
        state.recording = enabled;
        protocol::TransportState out{enabled, 0, false, {}};
        out.recording = enabled;
        out.armed = state.armed;
        return out;
    }
    protocol::RecordState recordState() const override { return state; }
    std::vector<protocol::PendingTake> pendingTakes() const override { return {}; }
    protocol::RecoverResult recoverTake(const std::string&, bool, const std::optional<std::string>&, std::string,
                                        std::string) override {
        calls.push_back("recover");
        return {};
    }
    protocol::RecordState state;
    std::vector<std::string> calls;
};

ServerOptions withRecorder(protocol::TransportPort& transport, protocol::RecordPort& record, McpScope scope) {
    ServerOptions options = withTransport(transport, scope);
    options.recordPort = &record;
    return options;
}

}  // namespace

TEST_CASE("record_arm and record need the trusted scope", "[protocol][mcp][record]") {
    RecordingPort transport;
    ArmingPort port;
    SECTION("propose") {
        Fixture f(withRecorder(transport, port, McpScope::propose));
        Mcp mcp(f);
        mcp.initialize();
        CHECK(at(mcp.error("record_arm", Value(Object{{"trackId", Value("trk_1")}, {"armed", Value(true)}})), "code")
                  .asString() == "scope_denied");
        CHECK(at(mcp.error("record", Value(Object{{"enabled", Value(true)}})), "code").asString() == "scope_denied");
        CHECK(port.calls.empty());
    }
    SECTION("trusted") {
        Fixture f(withRecorder(transport, port, McpScope::trusted));
        Mcp mcp(f);
        mcp.initialize();
        const Value armed = mcp.ok("record_arm", Value(Object{{"trackId", Value("trk_1")}, {"armed", Value(true)}}));
        CHECK(at(armed, "armed").asArray().size() == 1);
        const Value recording = mcp.ok("record", Value(Object{{"enabled", Value(true)}}));
        CHECK(at(recording, "recording").asBool());
        CHECK(port.calls == std::vector<std::string>{"arm", "record"});
    }
}

// m5b-engine-record (security review): stop and locate end a running recording
// and commit it, and a propose agent cannot start one, so it cannot end one
// either: while recording they are scope_denied under propose and reach no port.
// Stopped, they run as before; a trusted credential ends the recording.
TEST_CASE("a propose client cannot end a recording with stop or locate", "[protocol][mcp][record][scope]") {
    RecordingPort transport;
    ArmingPort port;
    SECTION("propose, while recording") {
        Fixture f(withRecorder(transport, port, McpScope::propose));
        Mcp mcp(f);
        mcp.initialize();
        port.state.recording = true;
        CHECK(at(mcp.error("stop"), "code").asString() == "scope_denied");
        CHECK(at(mcp.error("locate", Value(Object{{"frames", Value("0")}})), "code").asString() == "scope_denied");
        CHECK(transport.calls.empty());
        CHECK(port.state.recording);
        // What does not end it still runs.
        CHECK(at(at(mcp.ok("engine_status"), "device"), "id").asString() == "fake");
        mcp.ok("set_click", Value(Object{{"enabled", Value(true)}}));
    }
    SECTION("propose, stopped") {
        Fixture f(withRecorder(transport, port, McpScope::propose));
        Mcp mcp(f);
        mcp.initialize();
        mcp.ok("stop");
        mcp.ok("locate", Value(Object{{"frames", Value("0")}}));
        CHECK(transport.calls == std::vector<std::string>{"stop", "locate"});
    }
    SECTION("trusted, while recording") {
        Fixture f(withRecorder(transport, port, McpScope::trusted));
        Mcp mcp(f);
        mcp.initialize();
        port.state.recording = true;
        mcp.ok("locate", Value(Object{{"frames", Value("0")}}));
        mcp.ok("stop");
        CHECK(transport.calls == std::vector<std::string>{"locate", "stop"});
    }
}

TEST_CASE("recording adds no tool to the propose scope", "[protocol][mcp][record]") {
    std::vector<std::string> propose;
    for (const auto& tool : protocol::detail::mcpTools()) {
        if (tool.scope == McpScope::propose) {
            propose.emplace_back(tool.name);
        }
    }
    CHECK(propose == kProposeTools);
}

// m5b-protocol-parity: list_plans and preview_plan wrap plan.list and
// plan.preview one to one in the propose scope (both only read).
TEST_CASE("list_plans and preview_plan wrap plan.list and plan.preview under propose",
          "[protocol][mcp][plans][parity]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    const ConnectionId ui = f.authed();
    CHECK(canonical(mcp.ok("list_plans")) == R"({"plans":[]})");

    const std::string hash =
        at(mcp.ok("submit_plan", Value(Object{{"steps", Value(Array{trackAdd("trk_a")})}})), "hash").asString();
    const Value listed = mcp.ok("list_plans");
    REQUIRE(at(listed, "plans").asArray().size() == 1);
    CHECK(at(at(listed, "plans").asArray()[0], "hash").asString() == hash);
    CHECK(canonical(listed) == canonical(f.ok(ui, "plan.list")));

    const Value plan = Value(Object{{"plan", Value(hash)}});
    const Value preview = mcp.ok("preview_plan", plan);
    CHECK(at(preview, "revision").asString() == "r1");
    CHECK(canonical(preview) == canonical(f.ok(ui, "plan.preview", plan)));
    CHECK(f.session.history().revisions().size() == 1);

    // The method's own errors.
    const std::string none = "sha256:" + std::string(64, '0');
    CHECK(at(mcp.error("preview_plan", Value(Object{{"plan", Value(none)}})), "code").asString() == "not_found");
    CHECK(at(mcp.error("preview_plan"), "code").asString() == "invalid_params");
    // A step that fails at the head answers its error with the step; the plan is unchanged.
    f.ok(ui, "command.execute", Value(Object{{"commands", Value(Array{trackAdd("trk_a")})}}));
    const Value failed = mcp.error("preview_plan", plan);
    CHECK(at(failed, "code").asString() == "already_exists");
    CHECK(at(failed, "step").asNumber() == 0);
    CHECK(at(at(mcp.ok("list_plans"), "plans").asArray()[0], "state").asString() == "validated");
}

// m5b-protocol-parity: undo and redo move main's head, so they need trusted.
TEST_CASE("undo and redo are scope_denied under propose and run nothing", "[protocol][mcp][parity]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    const ConnectionId ui = f.authed();
    f.ok(ui, "command.execute", Value(Object{{"commands", Value(Array{trackAdd("trk_a")})}}));
    REQUIRE(f.session.history().revisions().size() == 2);
    const std::string head = at(mcp.ok("inspect_session"), "revision").asString();

    for (const char* name : {"undo", "redo"}) {
        INFO(name);
        CHECK(at(mcp.error(name), "code").asString() == "scope_denied");
        // Not cached: the same JSON-RPC id answers again from the scope check.
        const std::string body =
            Mcp::rpc(Value(7), "tools/call", Value(Object{{"name", Value(name)}, {"arguments", Value(Object{})}}));
        CHECK(mcp.post(body).body == mcp.post(body).body);
    }
    CHECK(f.session.history().revisions().size() == 2);
    CHECK(at(mcp.ok("inspect_session"), "revision").asString() == head);
    // The UI is not scoped: its session.undo still runs.
    CHECK(at(at(f.ok(ui, "session.undo"), "revision"), "cause").asString() == "undo");
}

TEST_CASE("under the trusted scope undo and redo move main's head as session.undo and session.redo do",
          "[protocol][mcp][parity]") {
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    const ConnectionId ui = f.authed();
    CHECK(at(mcp.error("undo"), "code").asString() == "nothing_to_undo");
    CHECK(at(mcp.error("redo"), "code").asString() == "nothing_to_redo");
    mcp.ok("execute", Value(Object{{"commands", Value(Array{trackAdd("trk_a")})}}));
    const std::string added = at(mcp.ok("inspect_session"), "revision").asString();

    const Value undone = mcp.ok("undo");
    CHECK(at(at(undone, "revision"), "cause").asString() == "undo");
    const std::string afterUndo = at(mcp.ok("inspect_session"), "revision").asString();
    CHECK(afterUndo != added);
    CHECK(at(f.ok(ui, "session.inspect"), "revision").asString() == afterUndo);
    CHECK(at(mcp.error("undo"), "code").asString() == "nothing_to_undo");

    const Value redone = mcp.ok("redo");
    CHECK(at(at(redone, "revision"), "cause").asString() == "redo");
    CHECK(at(mcp.ok("inspect_session"), "revision").asString() != afterUndo);
    CHECK(f.session.history().revisions().size() == 4);
    CHECK(at(mcp.error("redo"), "code").asString() == "nothing_to_redo");
}

// m5-ui-engine-loop-click (Protocol v0 item 26): set_cycle and set_click wrap
// transport.set_cycle and transport.set_click one to one in the propose scope.
TEST_CASE("set_cycle and set_click wrap their methods one to one under propose", "[protocol][mcp][transport][cycle]") {
    RecordingPort port;
    Fixture f(withTransport(port, McpScope::propose));
    Mcp mcp(f);
    mcp.initialize();
    const ConnectionId ui = f.authed();

    const Value cycled = mcp.ok("set_cycle", Value(Object{{"enabled", Value(true)}}));
    CHECK(at(cycled, "cycle").asBool());
    CHECK(at(cycled, "position").asString() == "0");
    CHECK_FALSE(at(at(cycled, "click"), "enabled").asBool());
    const Value direct = f.ok(ui, "transport.set_cycle", Value(Object{{"enabled", Value(true)}}));
    CHECK(canonical(direct) == canonical(cycled));

    const Value clicked =
        mcp.ok("set_click", Value(Object{{"enabled", Value(true)}, {"gainMilliDb", Value(-6000)}}));
    CHECK(at(at(clicked, "click"), "enabled").asBool());
    CHECK(at(at(clicked, "click"), "gainMilliDb").asNumber() == -6'000);
    CHECK(at(at(mcp.ok("set_click", Value(Object{{"enabled", Value(false)}})), "click"), "gainMilliDb").asNumber() ==
          -6'000);
    CHECK(port.calls == std::vector<std::string>{"set_cycle", "set_cycle", "set_click", "set_click"});

    // The method's own errors, no_device included.
    CHECK(at(mcp.error("set_cycle", Value(Object{{"enabled", Value(1)}})), "code").asString() == "invalid_params");
    CHECK(at(mcp.error("set_click", Value(Object{{"enabled", Value(true)}, {"gainMilliDb", Value(5)}})), "code")
              .asString() == "invalid_params");
    port.refusal = "no_device";
    CHECK(at(mcp.error("set_cycle", Value(Object{{"enabled", Value(false)}})), "code").asString() == "no_device");
    CHECK(at(mcp.error("set_click", Value(Object{{"enabled", Value(false)}})), "code").asString() == "no_device");
}

// m5b-engine-punch-count-in (Protocol v0 item 34): set_punch, set_preroll and
// set_count_in wrap their methods one to one in the propose scope.
TEST_CASE("set_punch, set_preroll and set_count_in wrap their methods one to one under propose",
          "[protocol][mcp][transport][punch]") {
    RecordingPort port;
    Fixture f(withTransport(port, McpScope::propose));
    Mcp mcp(f);
    mcp.initialize();
    const ConnectionId ui = f.authed();

    const Value punched = mcp.ok("set_punch", Value(Object{{"in", Value(true)}, {"out", Value(true)}}));
    CHECK(at(at(punched, "punch"), "in").asBool());
    CHECK(at(at(punched, "punch"), "out").asBool());
    const Value direct = f.ok(ui, "transport.set_punch", Value(Object{{"in", Value(true)}, {"out", Value(true)}}));
    CHECK(canonical(direct) == canonical(punched));

    const Value prerolled = mcp.ok("set_preroll", Value(Object{{"enabled", Value(true)}, {"bars", Value(2)}}));
    CHECK(at(at(prerolled, "preroll"), "enabled").asBool());
    CHECK(at(at(prerolled, "preroll"), "bars").asNumber() == 2);
    const Value counted = mcp.ok("set_count_in", Value(Object{{"enabled", Value(true)}}));
    CHECK(at(at(counted, "countIn"), "enabled").asBool());
    CHECK(at(at(counted, "countIn"), "bars").asNumber() == 2);
    CHECK(port.calls == std::vector<std::string>{"set_punch", "set_punch", "set_preroll", "set_count_in"});

    // The method's own errors, no_device included.
    CHECK(at(mcp.error("set_preroll", Value(Object{{"enabled", Value(true)}, {"bars", Value(9)}})), "code")
              .asString() == "invalid_params");
    CHECK(at(mcp.error("set_punch", Value(Object{{"in", Value(true)}})), "code").asString() == "invalid_params");
    port.refusal = "no_device";
    CHECK(at(mcp.error("set_count_in", Value(Object{{"enabled", Value(false)}})), "code").asString() == "no_device");
}

TEST_CASE("without a transport port set_cycle and set_click answer not_supported", "[protocol][mcp][transport][cycle]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    CHECK(at(mcp.error("set_cycle", Value(Object{{"enabled", Value(true)}})), "code").asString() == "not_supported");
    CHECK(at(mcp.error("set_click", Value(Object{{"enabled", Value(true)}})), "code").asString() == "not_supported");
}

// m5b-engine-project-media (Protocol v0 item 27): both methods read or write paths
// on the user's disk, so the propose scope never gets them.
namespace {

std::string utf8Path(const std::filesystem::path& path) {
    const std::u8string text = path.u8string();
    return std::string(text.begin(), text.end());
}

}  // namespace

TEST_CASE("import_media and create_session are scope_denied under propose and run under trusted",
          "[protocol][mcp][media]") {
    for (const McpScope scope : {McpScope::propose, McpScope::trusted}) {
        INFO(protocol::mcpScopeName(scope));
        std::optional<session::Session> created;
        int createCalls = 0;
        ServerOptions options = manualOptions();
        options.mcpScope = scope;
        options.jobs.workerThread = false;
        options.createSession = [&](const std::filesystem::path& path, const std::string& name,
                                    std::int64_t rate) -> session::Session& {
            ++createCalls;
            created.emplace(session::Session::create(path, model::Document::create(name, rate), "tester",
                                                     "2026-11-14T00:00:00Z"));
            return *created;
        };
        Fixture f(std::move(options));
        Mcp mcp(f);
        mcp.initialize();

        const std::filesystem::path wav = f.dir.bundle().parent_path() / "tone.wav";
        media::AudioBuffer tone;
        tone.info = media::AudioInfo{1, 48'000, 480};
        tone.samples.assign(480, 0.125f);
        io::writeFileAtomic(wav, media::encodeWavFloat32(tone));
        const std::filesystem::path target = f.dir.bundle().parent_path() / "New.siann";
        const Value importArgs(Object{{"path", Value(utf8Path(wav))}, {"clientImportId", Value("imp-1")}});
        const Value createArgs(Object{{"path", Value(utf8Path(target))}});

        if (scope == McpScope::propose) {
            CHECK(at(mcp.error("import_media", importArgs), "code").asString() == "scope_denied");
            CHECK(at(mcp.error("create_session", createArgs), "code").asString() == "scope_denied");
            CHECK(f.server.runJobs() == 0);
            CHECK(createCalls == 0);
            CHECK_FALSE(std::filesystem::exists(target));
            CHECK(f.session.history().revisions().size() == 1);
            continue;
        }
        const Value queued = mcp.ok("import_media", importArgs);
        CHECK(at(queued, "kind").asString() == "media.import");
        CHECK(at(queued, "state").asString() == "queued");
        CHECK(f.server.runJobs() == 1);
        f.server.pump();
        const Value status = mcp.ok("job_status", Value(Object{{"jobId", at(queued, "jobId")}}));
        CHECK(at(status, "state").asString() == "done");
        CHECK(at(at(status, "result"), "mediaId").asString() == "med_1");
        CHECK(f.session.history().revisions().size() == 2);

        const Value made = mcp.ok("create_session", createArgs);
        CHECK(at(made, "revision").asString() == "r1");
        CHECK(createCalls == 1);
        CHECK(std::filesystem::exists(target / "session.json"));
    }
}

TEST_CASE("tools/list in the trusted scope describes import_media and create_session", "[protocol][mcp][media]") {
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    const Value tools = at(at(mcp.call(Value(1), "tools/list"), "result"), "tools");
    std::vector<std::string> required;
    for (const Value& tool : tools.asArray()) {
        const std::string name = at(tool, "name").asString();
        if (name != "import_media" && name != "create_session") {
            continue;
        }
        for (const Value& key : at(at(tool, "inputSchema"), "required").asArray()) {
            required.push_back(name + "." + key.asString());
        }
    }
    CHECK(required == std::vector<std::string>{"create_session.path", "import_media.path",
                                               "import_media.clientImportId"});
}

// m5b-engine-master: the master gain needs no tool of its own; execute (trusted)
// and a plan carry master.set_gain, and list_commands names it.
TEST_CASE("execute and a plan carry master.set_gain; list_commands names it", "[protocol][mcp][master]") {
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    const Value setMaster = Value(Object{{"op", Value("master.set_gain")}, {"gainMilliDb", Value(-6000)}});
    const Value executed = mcp.ok("execute", Value(Object{{"commands", Value(Array{setMaster})}}));
    CHECK(at(at(executed, "revision"), "diff").asArray().at(0).asString() == "master:master");
    REQUIRE(f.head().document.master() != nullptr);
    CHECK(f.head().document.master()->gain.milliDb == -6000);

    const Value back = Value(Object{{"op", Value("master.set_gain")}, {"gainMilliDb", Value(0)}});
    const std::string hash = at(mcp.ok("submit_plan", Value(Object{{"steps", Value(Array{back})}})), "hash").asString();
    mcp.ok("approve_plan", Value(Object{{"plan", Value(hash)}}));
    CHECK(at(at(mcp.ok("apply_plan", Value(Object{{"plan", Value(hash)}})), "revision"), "cause").asString() == "plan");
    CHECK(f.head().document.master() == nullptr);

    bool listed = false;
    const Value commands = mcp.tool("list_commands");  // kept: the loop reads into it
    for (const Value& name : at(at(commands, "structuredContent"), "commands").asArray()) {
        listed = listed || name.asString() == "master.set_gain";
    }
    CHECK(listed);
}

// m5b-engine-monitoring (Protocol v0 item 33): track.set_monitor is a command,
// so execute carries it and no tool of its own exists.
TEST_CASE("execute carries track.set_monitor; list_commands names it and no tool is added",
          "[protocol][mcp][monitor]") {
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    mcp.ok("execute", Value(Object{{"commands", Value(Array{trackAdd("trk_a")})}}));
    const Value monitor = Value(Object{{"op", Value("track.set_monitor")}, {"trackId", Value("trk_a")},
                                       {"monitor", Value("input")}});
    const Value executed = mcp.ok("execute", Value(Object{{"commands", Value(Array{monitor})}}));
    CHECK(at(at(executed, "revision"), "diff").asArray().at(0).asString() == "track:trk_a");
    CHECK(f.head().document.track("trk_a")->monitor == model::MonitorMode::input);

    bool listed = false;
    const Value commands = mcp.tool("list_commands");
    for (const Value& name : at(at(commands, "structuredContent"), "commands").asArray()) {
        listed = listed || name.asString() == "track.set_monitor";
    }
    CHECK(listed);
    const Value tools = at(at(mcp.call(Value(5), "tools/list"), "result"), "tools");
    for (const Value& tool : tools.asArray()) {
        CHECK(at(tool, "name").asString().find("monitor") == std::string::npos);
    }
}

// m5b-engine-markers: markers need no tool of their own; execute (trusted) runs
// marker.add, submit_plan (propose) carries a marker step, list_commands names them.
TEST_CASE("execute runs marker.add, submit_plan carries a marker step; list_commands names them",
          "[protocol][mcp][markers]") {
    {
        Fixture f(trusted());
        Mcp mcp(f);
        mcp.initialize();
        const Value add = Value(Object{{"op", Value("marker.add")}, {"markerId", Value("mk_1")},
                                       {"position", Value("48000")}, {"name", Value("Intro")}});
        const Value executed = mcp.ok("execute", Value(Object{{"commands", Value(Array{add})}}));
        CHECK(at(at(executed, "revision"), "diff").asArray().at(0).asString() == "marker:mk_1");
        REQUIRE(f.head().document.marker("mk_1") != nullptr);
        CHECK(f.head().document.marker("mk_1")->name == "Intro");
    }
    Fixture f;  // the default propose scope
    Mcp mcp(f);
    mcp.initialize();
    const Value add = Value(Object{{"op", Value("marker.add")}, {"markerId", Value("mk_2")},
                                   {"position", Value("0")}, {"length", Value("96000")}});
    const Value plan = mcp.ok("submit_plan", Value(Object{{"steps", Value(Array{add})}}));
    const auto& writeSet = at(plan, "writeSet").asArray();
    REQUIRE(writeSet.size() == 1);
    CHECK(at(writeSet[0], "type").asString() == "marker");
    CHECK(at(writeSet[0], "id").asString() == "mk_2");
    CHECK(at(writeSet[0], "hash").isNull());
    CHECK(f.head().document.marker("mk_2") == nullptr);  // a plan is not applied by submitting it

    std::vector<std::string> names;
    const Value commands = mcp.tool("list_commands");  // kept: the loop reads into it
    for (const Value& name : at(at(commands, "structuredContent"), "commands").asArray()) {
        names.push_back(name.asString());
    }
    for (const char* name : {"marker.add", "marker.move", "marker.rename", "marker.remove"}) {
        CHECK(std::find(names.begin(), names.end(), name) != names.end());
    }
}

// m5b-engine-plan-metadata (spec, "Plans", decisions of 2026-11-15; Protocol v0
// items 15 and 29; docs/schemas/protocol-mcp-v0.md): submit_plan's title and
// intent, the actor from initialize's clientInfo.name, and DELETE /v0/mcp.

namespace {

// initialize with `clientInfo` (absent when null); returns the session header.
std::string initializeAs(Mcp& mcp, const Value& clientInfo) {
    Object params{{"protocolVersion", Value("2025-06-18")}, {"capabilities", Value(Object{})}};
    if (!clientInfo.isNull()) {
        params.emplace_back("clientInfo", clientInfo);
    }
    const HttpResponse response = mcp.post(Mcp::rpc(Value(0), "initialize", Value(std::move(params))), false);
    REQUIRE(response.status == 200);
    mcp.sessionHeader = response.headers.at("Mcp-Session-Id");
    return mcp.sessionHeader;
}

Value clientNamed(Value name) {
    return Value(Object{{"name", std::move(name)}, {"version", Value("1.0")}});
}

Value gainStep(const std::string& track, int milliDb) {
    return Value(Object{{"op", Value("track.set_gain")}, {"trackId", Value(track)}, {"gainMilliDb", Value(milliDb)}});
}

}  // namespace

TEST_CASE("tools/list: submit_plan takes a title of 200 and an intent of 2000 at most", "[protocol][mcp][metadata]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    const Value tools = at(at(mcp.call(Value(1), "tools/list"), "result"), "tools");
    const Value* schema = nullptr;
    for (const Value& tool : tools.asArray()) {
        if (at(tool, "name").asString() == "submit_plan") {
            schema = &at(tool, "inputSchema");
        }
    }
    REQUIRE(schema != nullptr);
    const Value& properties = at(*schema, "properties");
    CHECK(at(at(properties, "title"), "type").asString() == "string");
    CHECK(at(at(properties, "title"), "minLength").asNumber() == 1);
    CHECK(at(at(properties, "title"), "maxLength").asNumber() == 200);
    CHECK(at(at(properties, "intent"), "type").asString() == "string");
    CHECK(at(at(properties, "intent"), "maxLength").asNumber() == 2000);
    CHECK(properties.find("actor") == nullptr);
    CHECK_FALSE(at(*schema, "additionalProperties").asBool());
}

// m5b-engine-agent-requests (Protocol v0 item 32): the agent's side of a request.
TEST_CASE("tools/list: next_request and answer_request are propose tools; submit_plan takes a request",
          "[protocol][mcp][requests]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    const Value tools = at(at(mcp.call(Value(1), "tools/list"), "result"), "tools");
    const auto schemaOf = [&](const std::string& name) -> Value {
        for (const Value& tool : tools.asArray()) {
            if (at(tool, "name").asString() == name) {
                return at(tool, "inputSchema");
            }
        }
        FAIL("no tool " << name);
        return Value();
    };
    for (const auto& tool : protocol::detail::mcpTools()) {
        if (tool.name == "next_request") {
            CHECK(tool.method == "agent.next_request");
            CHECK(tool.scope == McpScope::propose);
        }
        if (tool.name == "answer_request") {
            CHECK(tool.method == "agent.answer_request");
            CHECK(tool.scope == McpScope::propose);
        }
    }

    const Value next = schemaOf("next_request");
    const Value& wait = at(at(next, "properties"), "waitMs");
    CHECK(at(wait, "type").asString() == "integer");
    CHECK(at(wait, "minimum").asNumber() == 0);
    CHECK(next.find("required") == nullptr);
    CHECK_FALSE(at(next, "additionalProperties").asBool());

    const Value answer = schemaOf("answer_request");
    const Value& properties = at(answer, "properties");
    CHECK(at(at(properties, "request"), "type").asString() == "string");
    CHECK(at(at(properties, "plan"), "type").asString() == "string");
    CHECK(at(at(properties, "message"), "type").asString() == "string");
    CHECK(at(at(properties, "message"), "maxLength").asNumber() == 4000);
    CHECK(at(at(properties, "decline"), "const").asBool());
    CHECK(canonical(at(answer, "required")) == R"(["request"])");
    CHECK_FALSE(at(answer, "additionalProperties").asBool());

    const Value submit = schemaOf("submit_plan");
    CHECK(at(at(at(submit, "properties"), "request"), "type").asString() == "string");
    CHECK(canonical(at(submit, "required")) == R"(["steps"])");
}

TEST_CASE("submit_plan stores title, intent and the actor from clientInfo.name", "[protocol][mcp][metadata]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    Mcp mcp(f);
    initializeAs(mcp, clientNamed(Value("mix-assistant")));

    const Value plan = mcp.ok("submit_plan", Value(Object{{"steps", Value(Array{gainStep("trk_a", -600)})},
                                                          {"title", Value("Lower the drums")},
                                                          {"intent", Value("They mask the vocal.")}}));
    CHECK(at(plan, "title").asString() == "Lower the drums");
    CHECK(at(plan, "intent").asString() == "They mask the vocal.");
    CHECK(canonical(at(plan, "actor")) == R"({"kind":"mcp","name":"mix-assistant"})");
    const Value status = mcp.ok("plan_status", Value(Object{{"plan", at(plan, "hash")}}));
    CHECK(canonical(at(status, "actor")) == R"({"kind":"mcp","name":"mix-assistant"})");
    CHECK(at(status, "title").asString() == "Lower the drums");
    // The UI sees the same actor.
    CHECK(canonical(at(f.ok(c, "plan.status", Value(Object{{"plan", at(plan, "hash")}})), "actor")) ==
          R"({"kind":"mcp","name":"mix-assistant"})");

    // An actor in the tool arguments is refused and nothing is stored.
    const Value refused = mcp.error(
        "submit_plan", Value(Object{{"steps", Value(Array{gainStep("trk_a", -300)})},
                                    {"actor", Value(Object{{"kind", Value("ui")}, {"name", Value("forged")}})}}));
    CHECK(at(refused, "code").asString() == "invalid_params");
    CHECK(at(f.ok(c, "plan.list"), "plans").asArray().size() == 1);
    // A title over the limit is invalid_plan_metadata.
    const Value tooLong = mcp.error("submit_plan", Value(Object{{"steps", Value(Array{gainStep("trk_a", -300)})},
                                                                {"title", Value(std::string(201, 't'))}}));
    CHECK(at(tooLong, "code").asString() == "invalid_plan_metadata");
    CHECK(at(f.ok(c, "plan.list"), "plans").asArray().size() == 1);
}

TEST_CASE("the MCP actor's name: the default without clientInfo, sanitised otherwise", "[protocol][mcp][metadata]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    int gain = 0;
    const auto actorFor = [&](const Value& clientInfo) {
        Mcp mcp(f);
        initializeAs(mcp, clientInfo);
        const Value plan = mcp.ok("submit_plan", Value(Object{{"steps", Value(Array{gainStep("trk_a", --gain)})}}));
        return canonical(at(plan, "actor"));
    };
    CHECK(actorFor(Value(nullptr)) == R"({"kind":"mcp","name":"MCP client"})");
    CHECK(actorFor(Value(Object{{"version", Value("1")}})) == R"({"kind":"mcp","name":"MCP client"})");
    CHECK(actorFor(clientNamed(Value(42))) == R"({"kind":"mcp","name":"MCP client"})");
    CHECK(actorFor(clientNamed(Value(" \t\n"))) == R"({"kind":"mcp","name":"MCP client"})");
    CHECK(actorFor(clientNamed(Value("  claude\x1b[31m-code\r\n"))) == R"({"kind":"mcp","name":"claude[31m-code"})");
    // Bidi formatting (U+202E RLO, U+2066 LRI, U+200F RLM, U+061C ALM) and line
    // separators (U+2028, U+2029) are removed too, so the name cannot reorder
    // what is shown after it.
    CHECK(actorFor(clientNamed(Value("evil\xE2\x80\xAE" "doc.exe" "\xE2\x81\xA6" "x" "\xE2\x80\x8F\xD8\x9C"))) ==
          R"({"kind":"mcp","name":"evildoc.exex"})");
    CHECK(actorFor(clientNamed(Value("two\xE2\x80\xA8" "lines" "\xE2\x80\xA9"))) == R"({"kind":"mcp","name":"twolines"})");
    CHECK(actorFor(clientNamed(Value("\xE2\x80\xAE \xE2\x80\xAE"))) == R"({"kind":"mcp","name":"MCP client"})");
    // CJK and emoji are kept.
    CHECK(actorFor(clientNamed(Value("\xE9\xBC\x93 \xF0\x9F\xA5\x81"))) ==
          std::string(R"({"kind":"mcp","name":")") + "\xE9\xBC\x93 \xF0\x9F\xA5\x81" + R"("})");
    // Cut to 64 bytes at a character boundary: 21 three-byte characters are 63 bytes.
    std::string wide;
    for (int i = 0; i < 30; ++i) {
        wide += "\xE9\xBC\x93";
    }
    std::string cut;
    for (int i = 0; i < 21; ++i) {
        cut += "\xE9\xBC\x93";
    }
    CHECK(actorFor(clientNamed(Value(wide))) == R"({"kind":"mcp","name":")" + cut + R"("})");
}

TEST_CASE("DELETE /v0/mcp ends the session; without the header it is 400", "[protocol][mcp][agents]") {
    Fixture f;
    Mcp mcp(f);
    const std::string session = initializeAs(mcp, clientNamed(Value("mix-assistant")));
    CHECK(at(mcp.call(Value("p"), "ping"), "result").asObject().empty());

    HttpRequest without = mcp.request("", false);
    without.method = "DELETE";
    CHECK(mcp.send(without).status == 400);
    HttpRequest unknown = mcp.request("", false);
    unknown.method = "DELETE";
    unknown.headers["mcp-session-id"] = "mcp_" + std::string(32, '0');
    CHECK(mcp.send(unknown).status == 404);
    // The UI token does not end an MCP session.
    HttpRequest wrongToken = mcp.request("");
    wrongToken.method = "DELETE";
    wrongToken.headers["authorization"] = "Bearer " + f.server.token();
    CHECK(mcp.send(wrongToken).status == 401);

    HttpRequest end = mcp.request("");
    end.method = "DELETE";
    const HttpResponse ended = mcp.send(end);
    CHECK(ended.status == 204);
    CHECK(ended.body.empty());
    CHECK(mcp.post(Mcp::rpc(Value("p2"), "ping")).status == 404);
    CHECK(mcp.send(end).status == 404);
    CHECK(mcp.sessionHeader == session);
}

// m5b-engine-buses-sends: list_commands passes command.list's cascades through.
TEST_CASE("list_commands passes the cascades through", "[protocol][mcp][buses]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    const Value listed = mcp.ok("list_commands");
    CHECK(at(listed, "commands").kind() == Value::Kind::array);
    const Value& cascades = at(listed, "cascades");
    REQUIRE(cascades.find("bus.remove") != nullptr);
    CHECK(canonical(at(cascades, "bus.remove")) ==
          canonical(Value(Array{Value("bus"), Value("plugin_slot"), Value("root"), Value("send"), Value("track")})));
    CHECK(canonical(at(cascades, "track.remove")) ==
          canonical(Value(Array{Value("clip"), Value("plugin_slot"), Value("root"), Value("send")})));
    CHECK(cascades.asObject().size() == 2);
}

// m5b-bridge-native-client (spec, siann-protocol item 14): rollback_plan wraps
// plan.rollback one to one, so it takes the plan hash or the revision id of a
// plan an earlier engine process applied.
TEST_CASE("rollback_plan takes a plan hash or a revision id", "[protocol][mcp][plans][rollback]") {
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    const Value tools = at(at(mcp.call(Value(1), "tools/list"), "result"), "tools");
    bool listed = false;
    for (const Value& tool : tools.asArray()) {
        if (at(tool, "name").asString() != "rollback_plan") {
            continue;
        }
        listed = true;
        const Value& schema = at(tool, "inputSchema");
        CHECK(at(at(at(schema, "properties"), "plan"), "type").asString() == "string");
        CHECK(at(at(at(schema, "properties"), "revision"), "type").asString() == "string");
        CHECK(schema.find("required") == nullptr);
    }
    CHECK(listed);

    const Value plan = mcp.ok("submit_plan", Value(Object{{"steps", Value(Array{trackAdd("trk_a")})}}));
    const std::string hash = at(plan, "hash").asString();
    mcp.ok("approve_plan", Value(Object{{"plan", Value(hash)}}));
    const std::string revision =
        at(at(mcp.ok("apply_plan", Value(Object{{"plan", Value(hash)}})), "revision"), "id").asString();

    CHECK(at(mcp.error("rollback_plan", Value(Object{})), "code").asString() == "invalid_params");
    CHECK(at(mcp.error("rollback_plan", Value(Object{{"plan", Value(hash)}, {"revision", Value(revision)}})), "code")
              .asString() == "invalid_params");
    const Value rolled = mcp.ok("rollback_plan", Value(Object{{"revision", Value(revision)}}));
    CHECK(at(at(rolled, "revision"), "cause").asString() == "rollback");
    CHECK(at(mcp.ok("plan_status", Value(Object{{"plan", Value(hash)}})), "state").asString() == "rolled_back");
}

// m5b-engine-clip-fades: no new method, so no new tool; execute carries
// clip.set_fade and list_commands names it.
TEST_CASE("execute carries clip.set_fade and list_commands names it", "[protocol][mcp][fades]") {
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    mcp.ok("execute", Value(Object{{"commands", Value(Array{trackAdd("trk_a"), mediaAdd("med_a"),
                                                            clipPlace("clp_a", "trk_a", "med_a", 0)})}}));
    const Value fade = Value(Object{{"op", Value("clip.set_fade")},
                                    {"clipId", Value("clp_a")},
                                    {"fadeIn", Value(Object{{"length", Value("480")}, {"curve", Value("linear")}})}});
    const Value executed = mcp.ok("execute", Value(Object{{"commands", Value(Array{fade})}}));
    CHECK(at(at(executed, "revision"), "diff").asArray().at(0).asString() == "clip:clp_a");
    CHECK(f.head().document.clip("clp_a")->fadeIn.length == 480);

    bool listed = false;
    const Value commands = mcp.tool("list_commands");  // kept: the loop reads into it
    for (const Value& name : at(at(commands, "structuredContent"), "commands").asArray()) {
        listed = listed || name.asString() == "clip.set_fade";
    }
    CHECK(listed);
}

// m5b-engine-track-notes: no new method, so no new tool. Under the propose scope
// submit_plan takes a track.set_notes step; under the trusted scope execute
// carries it; list_commands names it.
TEST_CASE("submit_plan and execute carry track.set_notes and list_commands names it", "[protocol][mcp][notes]") {
    const std::string notes = "Verse: double it.\n\xE5\x89\xAF\xE6\xAD\x8C louder";
    const Value step = Value(Object{{"op", Value("track.set_notes")}, {"trackId", Value("trk_a")}, {"notes", Value(notes)}});
    {
        Fixture f;
        const ConnectionId user = f.authed();
        f.commit(user, Array{trackAdd("trk_a")});
        Mcp mcp(f);
        mcp.initialize();
        const Value plan = mcp.ok("submit_plan", Value(Object{{"steps", Value(Array{step})}}));
        CHECK(at(plan, "state").asString() == "validated");
        REQUIRE(at(plan, "writeSet").asArray().size() == 1);
        CHECK(at(at(plan, "writeSet").asArray()[0], "id").asString() == "trk_a");
        // The user approves over the protocol; the agent proposes it as a branch.
        f.ok(user, "plan.approve", Value(Object{{"plan", at(plan, "hash")}}));
        const Value proposed = mcp.ok("propose_plan", Value(Object{{"plan", at(plan, "hash")}}));
        CHECK(at(proposed, "branch").kind() == Value::Kind::string);
        CHECK_FALSE(f.head().document.track("trk_a")->notes.has_value());  // main did not move
        bool listed = false;
        const Value commands = mcp.tool("list_commands");  // kept: the loop reads into it
        for (const Value& name : at(at(commands, "structuredContent"), "commands").asArray()) {
            listed = listed || name.asString() == "track.set_notes";
        }
        CHECK(listed);
    }
    Fixture f(trusted());
    Mcp mcp(f);
    mcp.initialize();
    mcp.ok("execute", Value(Object{{"commands", Value(Array{trackAdd("trk_a")})}}));
    const Value executed = mcp.ok("execute", Value(Object{{"commands", Value(Array{step})}}));
    CHECK(at(at(executed, "revision"), "diff").asArray().at(0).asString() == "track:trk_a");
    CHECK(*f.head().document.track("trk_a")->notes == notes);
    const Value refused = mcp.error(
        "execute", Value(Object{{"commands", Value(Array{Value(Object{{"op", Value("track.set_notes")},
                                                                      {"trackId", Value("trk_a")},
                                                                      {"notes", Value(std::string(16'385, 'a'))}})})}}));
    CHECK(at(refused, "code").asString() == "invalid_notes");
}

// m5b-engine-load-loudness (Protocol v0 item 31): resetting the user's loudness
// meter is a display aid, not session state and nothing a plan needs, so no tool
// maps to it; the adapter lists the exclusion with its reason.
TEST_CASE("meter.reset_loudness is no MCP tool and the adapter lists its exclusion", "[protocol][mcp][loudness]") {
    for (const protocol::detail::McpTool& tool : protocol::detail::mcpTools()) {
        INFO(tool.name);
        CHECK(tool.method != "meter.reset_loudness");
        CHECK(std::string(tool.name).find("loudness") == std::string::npos);
    }
    const auto& exclusions = protocol::detail::mcpExclusions();
    const auto excluded = std::find_if(exclusions.begin(), exclusions.end(), [](const auto& exclusion) {
        return exclusion.method == "meter.reset_loudness";
    });
    REQUIRE(excluded != exclusions.end());
    CHECK_FALSE(excluded->reason.empty());

    RecordingPort port;
    Fixture f(withTransport(port, McpScope::trusted));
    Mcp mcp(f);
    mcp.initialize();
    for (const char* name : {"meter.reset_loudness", "reset_loudness", "meter_reset_loudness"}) {
        INFO(name);
        const HttpResponse response =
            mcp.post(Mcp::rpc(Value(2), "tools/call", Value(Object{{"name", Value(name)}, {"arguments", Value(Object{})}})));
        REQUIRE(response.status == 200);
        CHECK(at(at(json::parse(response.body), "error"), "code").asNumber() == -32602);
    }
}

TEST_CASE("engine_status passes the DSP load through", "[protocol][mcp][load]") {
    RecordingPort port;
    Fixture f(withTransport(port, McpScope::propose));
    Mcp mcp(f);
    mcp.initialize();
    const Value status = mcp.ok("engine_status");
    CHECK(at(at(status, "load"), "average").asNumber() == 0.125);
    CHECK(at(at(status, "load"), "peak").asNumber() == 0.5);
}
