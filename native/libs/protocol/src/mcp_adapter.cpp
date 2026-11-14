#include "mcp_adapter.hpp"

#include <algorithm>
#include <optional>
#include <random>
#include <utility>

#include "siann/hash/jcs.hpp"
#include "siann/protocol/about.hpp"

namespace siann::protocol::detail {

namespace {

using json::Object;
using json::Value;

constexpr std::string_view kMcpProtocolVersion = "2025-06-18";

// JSON-RPC 2.0 error codes.
constexpr int kParseError = -32700;
constexpr int kInvalidRequest = -32600;
constexpr int kMethodNotFound = -32601;
constexpr int kInvalidParams = -32602;
constexpr int kServerError = -32000;

constexpr std::string_view kEmpty = R"({"type":"object","properties":{},"additionalProperties":false})";
constexpr std::string_view kPlanOnly =
    R"({"type":"object","properties":{"plan":{"type":"string","description":"the plan hash, sha256:<hex>"}},"required":["plan"],"additionalProperties":false})";
constexpr std::string_view kBranchOnly =
    R"({"type":"object","properties":{"branch":{"type":"string","description":"a proposal branch, p<n>"}},"required":["branch"],"additionalProperties":false})";

const std::vector<McpTool> kTools = {
    {"list_commands", "command.list", McpScope::propose, "Lists the names of the registered commands.", kEmpty},
    {"describe_capabilities", "engine.capabilities", McpScope::propose,
     "Describes the engine: build, scope, commands, protocol methods, features and limits.", kEmpty},
    {"inspect_session", "session.inspect", McpScope::propose,
     "Returns main's head revision, document hash, revision count, open proposal branches and the side heard.",
     kEmpty},
    {"submit_plan", "plan.submit", McpScope::propose,
     "Submits commands as a plan for review; returns the validated siann.plan.v1 with its hash.",
     R"({"type":"object","properties":{"steps":{"type":"array","items":{"type":"object"},"minItems":1,"description":"commands {op, ...}"},"readSet":{"type":"array","items":{"type":"string"},"description":"entities read, <type>:<id>"},"baseRevision":{"type":"string","description":"defaults to main's head"}},"required":["steps"],"additionalProperties":false})"},
    {"plan_status", "plan.status", McpScope::propose,
     "Returns a plan with the entities that changed since its base (stale) and its proposal branch.", kPlanOnly},
    {"approve_plan", "plan.approve", McpScope::trusted,
     "Approves a plan, or with steps a sub-plan of those step indexes (the original is rejected).",
     R"({"type":"object","properties":{"plan":{"type":"string"},"steps":{"type":"array","items":{"type":"integer","minimum":0}}},"required":["plan"],"additionalProperties":false})"},
    {"reject_plan", "plan.reject", McpScope::propose, "Rejects a plan with an optional note.",
     R"({"type":"object","properties":{"plan":{"type":"string"},"note":{"type":"string"}},"required":["plan"],"additionalProperties":false})"},
    {"apply_plan", "plan.apply", McpScope::trusted, "Applies an approved plan to main as one revision.", kPlanOnly},
    {"rollback_plan", "plan.rollback", McpScope::trusted,
     "Rolls back an applied plan with an inverse revision (rollback_conflict lists changed entities).", kPlanOnly},
    {"propose_plan", "plan.propose", McpScope::propose,
     "Applies an approved plan onto a new proposal branch instead of main.", kPlanOnly},
    {"audition", "audition.hear", McpScope::propose, "Hears main or an open proposal branch.",
     R"({"type":"object","properties":{"side":{"type":"string","description":"main or a branch p<n>"}},"required":["side"],"additionalProperties":false})"},
    {"merge_proposal", "proposal.merge", McpScope::trusted, "Merges a proposal branch into main.", kBranchOnly},
    {"discard_proposal", "proposal.discard", McpScope::propose, "Discards a proposal branch.", kBranchOnly},
    {"execute", "command.execute", McpScope::trusted, "Executes commands on main as one revision.",
     R"({"type":"object","properties":{"commands":{"type":"array","items":{"type":"object"},"minItems":1}},"required":["commands"],"additionalProperties":false})"},
    {"job_status", "job.status", McpScope::propose, "Returns a job's state and, when done, its result.",
     R"({"type":"object","properties":{"jobId":{"type":"string"}},"required":["jobId"],"additionalProperties":false})"},
    {"render", "render.start", McpScope::propose,
     "Starts an offline render of main's head to renders/<name>.wav; returns the job.",
     R"({"type":"object","properties":{"name":{"type":"string","pattern":"^[A-Za-z0-9._-]{1,64}$"},"start":{"type":"string","description":"first sample, decimal"},"frames":{"type":"string","description":"frame count, decimal"}},"required":["name"],"additionalProperties":false})"},
    {"open_session", "session.open", McpScope::trusted, "Opens another session bundle and serves it.",
     R"({"type":"object","properties":{"path":{"type":"string","description":"the bundle directory"}},"required":["path"],"additionalProperties":false})"},
    {"save_session", "session.save", McpScope::propose, "Writes the session checkpoint for main's head.", kEmpty},
    {"play", "transport.play", McpScope::propose, "Starts the transport; returns {playing, position, cycle, click}.", kEmpty},
    {"stop", "transport.stop", McpScope::propose, "Stops the transport; returns {playing, position, cycle, click}.", kEmpty},
    {"locate", "transport.locate", McpScope::propose, "Moves the playhead; returns {playing, position, cycle, click}.",
     R"({"type":"object","properties":{"frames":{"type":"string","description":"session frames, decimal"}},"required":["frames"],"additionalProperties":false})"},
    {"set_cycle", "transport.set_cycle", McpScope::propose,
     "Turns cycle playback between the locators on or off; returns {playing, position, cycle, click}.",
     R"({"type":"object","properties":{"enabled":{"type":"boolean"}},"required":["enabled"],"additionalProperties":false})"},
    {"set_click", "transport.set_click", McpScope::propose,
     "Turns the metronome on or off, optionally with its gain; returns {playing, position, cycle, click}.",
     R"({"type":"object","properties":{"enabled":{"type":"boolean"},"gainMilliDb":{"type":"integer","minimum":-60000,"maximum":0,"description":"default -12000; omitted keeps the current gain"}},"required":["enabled"],"additionalProperties":false})"},
    {"engine_status", "engine.status", McpScope::propose,
     "Returns the device (or deviceError), playing, the driver's timing counters and the plugin instances.", kEmpty},
    {"list_devices", "engine.devices", McpScope::propose,
     "Lists the audio devices the engine can open: {id, type, name, isDefault, current}.", kEmpty},
    {"select_device", "engine.select_device", McpScope::trusted,
     "Closes the running audio device and opens another one; returns the device engine_status reports.",
     R"({"type":"object","properties":{"id":{"type":"string","description":"a device id from list_devices"}},"required":["id"],"additionalProperties":false})"},
};

std::string randomHex(std::size_t bytes) {
    static constexpr char kDigits[] = "0123456789abcdef";
    std::random_device device;
    std::uniform_int_distribution<unsigned> byte(0, 255);
    std::string out;
    for (std::size_t i = 0; i < bytes; ++i) {
        const unsigned b = byte(device);
        out.push_back(kDigits[b >> 4]);
        out.push_back(kDigits[b & 0xF]);
    }
    return out;
}

HttpResponse reply(int status, std::string body, Headers headers = {}) {
    return HttpResponse{status, "application/json", std::move(body), std::move(headers)};
}

std::string rpcResult(const Value& id, Value result) {
    return jcs::canonicalize(
        Value(Object{{"jsonrpc", Value("2.0")}, {"id", id}, {"result", std::move(result)}}));
}

std::string rpcError(const Value& id, int code, const std::string& message, std::optional<Value> data = {}) {
    Object error{{"code", Value(static_cast<double>(code))}, {"message", Value(message)}};
    if (data) {
        error.emplace_back("data", std::move(*data));
    }
    return jcs::canonicalize(Value(Object{{"jsonrpc", Value("2.0")}, {"id", id}, {"error", Value(std::move(error))}}));
}

// A tool call's result from the protocol response text.
Value toolResult(const std::string& responseText) {
    Value response = json::parse(responseText);
    const Value* ok = response.find("ok");
    if (ok != nullptr && ok->kind() == Value::Kind::boolean && ok->asBool()) {
        const Value* result = response.find("result");
        Value structured = result != nullptr ? *result : Value(Object{});
        return Value(Object{{"content", Value(json::Array{Value(Object{{"type", Value("text")},
                                                                         {"text", Value(jcs::canonicalize(structured))}})})},
                            {"structuredContent", structured},
                            {"isError", Value(false)}});
    }
    const Value* found = response.find("error");
    Value error = found != nullptr ? *found
                                   : Value(Object{{"code", Value("internal_error")}, {"message", Value("no error")}});
    return Value(Object{{"content", Value(json::Array{Value(Object{{"type", Value("text")},
                                                                     {"text", Value(jcs::canonicalize(error))}})})},
                        {"structuredContent", Value(Object{{"error", error}})},
                        {"isError", Value(true)}});
}

}  // namespace

const std::vector<McpTool>& mcpTools() {
    return kTools;
}

McpAdapter::McpAdapter(Submit submit) : submit_(std::move(submit)) {}

void McpAdapter::handle(const HttpRequest& request, const std::function<void(HttpResponse)>& complete) {
    const Value nullId(nullptr);
    std::optional<Value> parsed;
    try {
        parsed = json::parse(request.body);
    } catch (const json::ParseError&) {
    }
    if (!parsed) {
        complete(reply(200, rpcError(nullId, kParseError, "the body is not JSON")));
        return;
    }
    if (parsed->kind() != Value::Kind::object) {
        complete(reply(200, rpcError(nullId, kInvalidRequest, "the body is one JSON-RPC request object")));
        return;
    }
    const Value* version = parsed->find("jsonrpc");
    const Value* idMember = parsed->find("id");
    const Value* methodMember = parsed->find("method");
    const Value* paramsMember = parsed->find("params");
    const bool idOk = idMember == nullptr || idMember->kind() == Value::Kind::string ||
                      idMember->kind() == Value::Kind::number;
    const Value id = idMember != nullptr && idOk ? *idMember : nullId;
    if (version == nullptr || version->kind() != Value::Kind::string || version->asString() != "2.0" || !idOk ||
        methodMember == nullptr || methodMember->kind() != Value::Kind::string ||
        (paramsMember != nullptr && paramsMember->kind() != Value::Kind::object)) {
        complete(reply(200, rpcError(id, kInvalidRequest, "not a JSON-RPC 2.0 request")));
        return;
    }
    const std::string& method = methodMember->asString();
    const Value params = paramsMember != nullptr ? *paramsMember : Value(Object{});
    const bool notification = idMember == nullptr;

    if (method == "initialize") {
        if (notification) {
            complete(reply(202, ""));
            return;
        }
        const std::string session = "mcp_" + randomHex(16);
        {
            std::lock_guard lock(mutex_);
            sessions_.insert(session);
        }
        const BuildInfo& build = buildInfo();
        complete(reply(200,
                       rpcResult(id, Value(Object{{"protocolVersion", Value(std::string(kMcpProtocolVersion))},
                                                  {"capabilities", Value(Object{{"tools", Value(Object{})}})},
                                                  {"serverInfo", Value(Object{{"name", Value(build.name)},
                                                                              {"version", Value(build.version)}})}})),
                       Headers{{"Mcp-Session-Id", session}}));
        return;
    }

    auto header = request.headers.find("mcp-session-id");
    if (header == request.headers.end()) {
        complete(reply(400, rpcError(nullId, kInvalidRequest, "the Mcp-Session-Id header is required; initialize first")));
        return;
    }
    const std::string session = header->second;
    {
        std::lock_guard lock(mutex_);
        if (sessions_.count(session) == 0) {
            complete(reply(404, rpcError(nullId, kInvalidRequest, "unknown MCP session; initialize again")));
            return;
        }
    }
    if (notification) {
        complete(reply(202, ""));
        return;
    }
    if (method == "ping") {
        complete(reply(200, rpcResult(id, Value(Object{}))));
        return;
    }
    if (method == "tools/list") {
        json::Array tools;
        for (const McpTool& tool : kTools) {
            tools.push_back(Value(Object{{"name", Value(std::string(tool.name))},
                                         {"description", Value(std::string(tool.description))},
                                         {"inputSchema", json::parse(tool.inputSchema)}}));
        }
        complete(reply(200, rpcResult(id, Value(Object{{"tools", Value(std::move(tools))}}))));
        return;
    }
    if (method != "tools/call") {
        complete(reply(200, rpcError(id, kMethodNotFound, "unknown method")));
        return;
    }

    const Value* name = params.find("name");
    const auto tool = name != nullptr && name->kind() == Value::Kind::string
                          ? std::find_if(kTools.begin(), kTools.end(),
                                         [&](const McpTool& entry) { return entry.name == name->asString(); })
                          : kTools.end();
    if (tool == kTools.end()) {
        complete(reply(200, rpcError(id, kInvalidParams, "unknown tool")));
        return;
    }
    const Value* arguments = params.find("arguments");
    if (arguments != nullptr && arguments->kind() != Value::Kind::object) {
        complete(reply(200, rpcError(id, kInvalidParams, "arguments must be an object")));
        return;
    }
    // The scope is the credential's and is checked by the server on the
    // command thread (scope_denied, not cached), not here.
    const std::string requestId = session + "/" + jcs::canonicalize(id);
    const bool queued = submit_(requestId, std::string(tool->method), arguments != nullptr ? *arguments : Value(Object{}),
                                [complete, id](const std::string& responseText) {
                                    complete(reply(200, rpcResult(id, toolResult(responseText))));
                                });
    if (!queued) {
        complete(reply(200, rpcError(id, kServerError, "the command inbox is full; retry",
                                     Value(Object{{"code", Value("queue_full")}}))));
    }
}

}  // namespace siann::protocol::detail
