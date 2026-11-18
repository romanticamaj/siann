#include "mcp_adapter.hpp"

#include <algorithm>
#include <optional>
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
     "Submits commands as a plan for review, optionally with a title and an intent shown to the user; returns the "
     "validated siann.plan.v1 with its hash and the actor the engine recorded.",
     R"({"type":"object","properties":{"steps":{"type":"array","items":{"type":"object"},"minItems":1,"description":"commands {op, ...}"},"readSet":{"type":"array","items":{"type":"string"},"description":"entities read, <type>:<id>"},"baseRevision":{"type":"string","description":"defaults to main's head"},"title":{"type":"string","minLength":1,"maxLength":200,"description":"one line, at most 200 UTF-8 bytes, no control, bidi formatting or line separator characters; not part of the plan hash"},"intent":{"type":"string","minLength":1,"maxLength":2000,"description":"why, at most 2000 UTF-8 bytes; tab, LF and CR are the only control characters allowed, no bidi formatting or line separator characters; not part of the plan hash"},"request":{"type":"string","description":"an open request from next_request (arq_<hex>) this plan answers; not part of the plan hash"}},"required":["steps"],"additionalProperties":false})"},
    {"plan_status", "plan.status", McpScope::propose,
     "Returns a plan with the entities that changed since its base (stale) and its proposal branch.", kPlanOnly},
    {"approve_plan", "plan.approve", McpScope::trusted,
     "Approves a plan, or with steps a sub-plan of those step indexes (the original is rejected).",
     R"({"type":"object","properties":{"plan":{"type":"string"},"steps":{"type":"array","items":{"type":"integer","minimum":0}}},"required":["plan"],"additionalProperties":false})"},
    {"reject_plan", "plan.reject", McpScope::propose, "Rejects a plan with an optional note; under the propose scope only a plan this agent submitted.",
     R"({"type":"object","properties":{"plan":{"type":"string"},"note":{"type":"string"}},"required":["plan"],"additionalProperties":false})"},
    {"apply_plan", "plan.apply", McpScope::trusted, "Applies an approved plan to main as one revision.", kPlanOnly},
    {"rollback_plan", "plan.rollback", McpScope::trusted,
     "Rolls back an applied plan with an inverse revision, by its hash or by the revision it was applied at "
     "(exactly one; rollback_conflict lists changed entities).",
     R"({"type":"object","properties":{"plan":{"type":"string","description":"the plan hash, sha256:<hex>"},"revision":{"type":"string","description":"the plan or branch-merge revision on main, r<n>, for a plan an earlier engine process applied"}},"additionalProperties":false})"},
    {"propose_plan", "plan.propose", McpScope::propose,
     "Applies an approved plan onto a new proposal branch instead of main.", kPlanOnly},
    {"audition", "audition.hear", McpScope::propose, "Hears main or an open proposal branch.",
     R"({"type":"object","properties":{"side":{"type":"string","description":"main or a branch p<n>"}},"required":["side"],"additionalProperties":false})"},
    {"merge_proposal", "proposal.merge", McpScope::trusted, "Merges a proposal branch into main.", kBranchOnly},
    {"discard_proposal", "proposal.discard", McpScope::propose, "Discards a proposal branch; under the propose scope only one this agent proposed or of its own plan.", kBranchOnly},
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
     "Returns the device (or deviceError), playing, the driver's timing counters, the DSP load and the plugin "
     "instances.",
     kEmpty},
    {"list_devices", "engine.devices", McpScope::propose,
     "Lists the audio devices the engine can open: {id, type, name, isDefault, current, inputChannels, "
     "outputChannels}.",
     kEmpty},
    {"select_device", "engine.select_device", McpScope::trusted,
     "Closes the running audio device and opens another one, with an input when inputId names one; returns the "
     "device engine_status reports.",
     R"({"type":"object","properties":{"id":{"type":"string","description":"a device id from list_devices"},"inputId":{"type":"string","description":"a device id from list_devices with inputs; omitted, no input"}},"required":["id"],"additionalProperties":false})"},
    // m5b-engine-record: recording writes to the user's disk and commits a
    // revision, so both are trusted.
    {"record_arm", "record.arm", McpScope::trusted,
     "Arms or disarms a track for recording (engine state, no revision); returns {recording, armed, takes}.",
     R"({"type":"object","properties":{"trackId":{"type":"string"},"armed":{"type":"boolean"}},"required":["trackId","armed"],"additionalProperties":false})"},
    {"record", "transport.record", McpScope::trusted,
     "Starts recording the armed tracks at the playhead, or ends the recording and commits it as one revision; "
     "returns {playing, position, cycle, click, recording, armed}.",
     R"({"type":"object","properties":{"enabled":{"type":"boolean"}},"required":["enabled"],"additionalProperties":false})"},
    // m5b-engine-project-media (Protocol v0 item 27): both touch paths on the user's disk.
    {"create_session", "session.create", McpScope::trusted,
     "Creates an empty session bundle at an absolute path that does not exist, at the device's sample rate, and "
     "serves it.",
     R"({"type":"object","properties":{"path":{"type":"string","description":"absolute path of the new bundle directory"},"name":{"type":"string","description":"the session name; default: the path's stem"}},"required":["path"],"additionalProperties":false})"},
    {"import_media", "media.import", McpScope::trusted,
     "Imports a WAV or FLAC file into the media pool as a job (converted to the session rate); poll job_status.",
     R"({"type":"object","properties":{"path":{"type":"string","description":"absolute path of the audio file"},"clientImportId":{"type":"string","minLength":1,"maxLength":128,"description":"chosen by the client; a repeat answers the first job"}},"required":["path","clientImportId"],"additionalProperties":false})"},
    // m5b-protocol-parity: the plan review reads, so an agent previews its plan as
    // the reviewer will see it; undo and redo move main's head, so they are trusted.
    {"list_plans", "plan.list", McpScope::propose,
     "Lists every plan of the session in submission order, each as plan_status returns it.", kEmpty},
    {"preview_plan", "plan.preview", McpScope::propose,
     "Returns what apply_plan would produce now at main's head ({revision, documentHash, stale, entities} with "
     "each entity before and after), committing nothing.",
     kPlanOnly},
    {"undo", "session.undo", McpScope::trusted, "Undoes main's last revision with a new undo revision.", kEmpty},
    {"redo", "session.redo", McpScope::trusted, "Redoes the revision the last undo undid.", kEmpty},
    // m5b-engine-agent-requests (Protocol v0 item 32): the agent's side of a
    // request from the user. A request executes nothing; a plan the user
    // approves stays the only way into the document, so both are propose.
    {"next_request", "agent.next_request", McpScope::propose,
     "Waits for the next request the user sent this agent and returns it, now taken: {request: {id, text, context: "
     "{selection, locators, cursor, headRevision}, ...}}, or {request: null} when none arrived within waitMs "
     "(at most the engine's agentRequestWaitMs). Call it again to keep listening.",
     R"({"type":"object","properties":{"waitMs":{"type":"integer","minimum":0,"description":"how long to wait for a request, in ms; 0 answers at once; capped at limits.agentRequestWaitMs"}},"additionalProperties":false})"},
    {"answer_request", "agent.answer_request", McpScope::propose,
     "Answers a request with a plan this agent submitted, or with a message, or declines it (exactly one form); "
     "submit_plan with request answers it too.",
     R"({"type":"object","properties":{"request":{"type":"string","description":"the request id, arq_<hex>"},"plan":{"type":"string","description":"the hash of a plan this agent submitted"},"message":{"type":"string","minLength":1,"maxLength":4000,"description":"1 to 4000 characters; tab, LF and CR are the only control characters allowed, no bidi formatting or line separator characters"},"decline":{"const":true,"description":"declines the request, with an optional message"}},"required":["request"],"additionalProperties":false})"},
};

// The methods the engine serves that no tool wraps, each with its reason
// (m5b-protocol-parity). Every method of kMethods is a tool's method or one of
// these, never both (protocol_parity_test, test/protocol-parity.test.js);
// docs/schemas/protocol-mcp-v0.md, "Methods without a tool", lists them in this order.
const std::vector<McpExclusion> kNotMcp = {
    {"engine.about", "its content is the about object of describe_capabilities"},
    {"gesture.begin", "a pointer lease of a UI, not an agent's verb; agents change values through commands and plans"},
    {"gesture.update", "a pointer lease of a UI, not an agent's verb; agents change values through commands and plans"},
    {"gesture.hold", "a pointer lease of a UI, not an agent's verb; agents change values through commands and plans"},
    {"gesture.end", "a pointer lease of a UI, not an agent's verb; agents change values through commands and plans"},
    {"gesture.cancel", "a pointer lease of a UI, not an agent's verb; agents change values through commands and plans"},
    {"plugin.registry", "approving what code loads is the user's decision (Protocol v0 item 21)"},
    {"plugin.approve", "approving what code loads is the user's decision (Protocol v0 item 21)"},
    {"plugin.open_editor", "a plugin editor needs a desktop window"},
    {"plugin.close_editor", "a plugin editor needs a desktop window"},
    {"plugin.instantiate", "agents reach plugins through plan steps (plugin.insert and the plugin commands)"},
    {"plugin.set_parameter",
     "a live parameter of a running instance, not journaled; no command sets a plugin parameter, so agents have "
     "no path to plugin parameters in v0"},
    {"session.sync", "read-model replication for UI clients; inspect_session serves agents"},
    {"session.fetch", "read-model replication for UI clients; inspect_session serves agents"},
    {"record.recover_take",
     "accepting or trashing a take a crash left is the user's decision about files on their disk; the UI offers "
     "it from pendingTakes"},
    {"meter.reset_loudness",
     "restarts the integrated value of the user's loudness meter: a display aid, not session state, and "
     "nothing a plan needs; an agent measures loudness from a render"},
    {"agent.request", "the user's side of an agent request (Protocol v0 item 32); the agent takes it with next_request"},
    {"agent.cancel_request",
     "the user's side of an agent request (Protocol v0 item 32); the agent takes it with next_request"},
    {"agent.requests", "the user's side of an agent request (Protocol v0 item 32); the agent takes it with next_request"},
};

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

const std::vector<McpExclusion>& mcpExclusions() {
    return kNotMcp;
}

McpAdapter::McpAdapter(Submit submit, AgentRegistry& agents) : submit_(std::move(submit)), agents_(agents) {}

void McpAdapter::end(const HttpRequest& request, const std::function<void(HttpResponse)>& complete) {
    const Value nullId(nullptr);
    auto header = request.headers.find("mcp-session-id");
    if (header == request.headers.end()) {
        complete(reply(400, rpcError(nullId, kInvalidRequest, "the Mcp-Session-Id header is required")));
        return;
    }
    if (!agents_.end(header->second)) {
        complete(reply(404, rpcError(nullId, kInvalidRequest, "unknown MCP session")));
        return;
    }
    complete(reply(204, ""));
}

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
        const Value* clientInfo = params.find("clientInfo");
        const Value* clientInfoName =
            clientInfo != nullptr && clientInfo->kind() == Value::Kind::object ? clientInfo->find("name") : nullptr;
        const std::string session = agents_.connect(sanitizeClientName(clientInfoName, kDefaultMcpName));
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
    const std::optional<AgentRegistry::Caller> caller = agents_.seen(session);
    if (!caller) {
        complete(reply(404, rpcError(nullId, kInvalidRequest, "unknown MCP session; initialize again")));
        return;
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
                                McpCaller{caller->agentId, caller->name, std::string(tool->name)},
                                [complete, id](const std::string& responseText) {
                                    complete(reply(200, rpcResult(id, toolResult(responseText))));
                                });
    if (!queued) {
        complete(reply(200, rpcError(id, kServerError, "the command inbox is full; retry",
                                     Value(Object{{"code", Value("queue_full")}}))));
    }
}

}  // namespace siann::protocol::detail
