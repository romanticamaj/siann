// The MCP adapter (docs/schemas/protocol-mcp-v0.md) through the thread-free
// seam ProtocolServer::handleMcp: the response arrives at once or from
// pump() on the test thread.

#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "support/protocol_fixture.hpp"
#include "siann/command/command.hpp"
#include "siann/hash/sha256.hpp"
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
    "locate",         "set_cycle",             "set_click",       "engine_status", "list_devices",
    "select_device",
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
    protocol::EngineStatus status() const override {
        protocol::EngineStatus out;
        out.device = protocol::DeviceInfo{"fake", 48'000, 256, 256, 256};
        out.cycle = cycle;
        out.click = click;
        return out;
    }
    protocol::TransportState current() const { return {false, position, cycle, click}; }
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

TEST_CASE("tools/list returns the 26 tools with input schemas", "[protocol][mcp]") {
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
    const Value expected = Value(Object{{"commands", commandsArray()}});
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

// m5-plan-review (Protocol v0 item 25): plan.list and plan.preview serve the
// review UI; an agent knows its plans, so they are no tool in v0.
TEST_CASE("plan.list and plan.preview are not MCP tools", "[protocol][mcp][plans]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    const Value tools = at(at(mcp.call(Value(1), "tools/list"), "result"), "tools");
    for (const Value& tool : tools.asArray()) {
        const std::string name = at(tool, "name").asString();
        INFO(name);
        CHECK(name.find("list_plans") == std::string::npos);
        CHECK(name.find("plan_list") == std::string::npos);
        CHECK(name.find("preview") == std::string::npos);
    }
    for (const char* name : {"plan.list", "plan.preview", "list_plans", "preview_plan"}) {
        INFO(name);
        const HttpResponse response =
            mcp.post(Mcp::rpc(Value(2), "tools/call", Value(Object{{"name", Value(name)}, {"arguments", Value(Object{})}})));
        REQUIRE(response.status == 200);
        CHECK(at(at(json::parse(response.body), "error"), "code").asNumber() == -32602);
    }
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

TEST_CASE("without a transport port set_cycle and set_click answer not_supported", "[protocol][mcp][transport][cycle]") {
    Fixture f;
    Mcp mcp(f);
    mcp.initialize();
    CHECK(at(mcp.error("set_cycle", Value(Object{{"enabled", Value(true)}})), "code").asString() == "not_supported");
    CHECK(at(mcp.error("set_click", Value(Object{{"enabled", Value(true)}})), "code").asString() == "not_supported");
}
