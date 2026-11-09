#include "siann/protocol/protocol_server.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <ctime>
#include <deque>
#include <exception>
#include <filesystem>
#include <map>
#include <mutex>
#include <optional>
#include <string_view>
#include <random>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "jobs.hpp"
#include "mcp_adapter.hpp"
#include "request_inbox.hpp"
#include "siann/protocol/about.hpp"
#include "siann/protocol/read_model.hpp"
#include "siann/command/command.hpp"
#include "siann/command/plan.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/session/journal.hpp"

namespace siann::protocol {

namespace {

using json::Array;
using json::decimal;
using json::Object;
using json::Value;

// WebSocket close code 1008: policy violation (RFC 6455, section 7.4.1).
constexpr int kClosePolicy = 1008;

std::string randomHex(std::size_t bytes) {
    static constexpr char kDigits[] = "0123456789abcdef";
    std::random_device device;
    std::uniform_int_distribution<unsigned> byte(0, 255);
    std::string out;
    out.reserve(bytes * 2);
    for (std::size_t i = 0; i < bytes; ++i) {
        const unsigned b = byte(device);
        out.push_back(kDigits[b >> 4]);
        out.push_back(kDigits[b & 0xF]);
    }
    return out;
}

// A second 32-byte secret that differs from `other`.
std::string distinctHex(const std::string& other) {
    std::string out = randomHex(32);
    while (out == other) {
        out = randomHex(32);
    }
    return out;
}

// Compares secrets without an early exit on the first differing byte.
bool sameSecret(std::string_view a, std::string_view b) noexcept {
    if (a.size() != b.size()) {
        return false;
    }
    unsigned char diff = 0;
    for (std::size_t i = 0; i < a.size(); ++i) {
        diff = static_cast<unsigned char>(diff | (static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i])));
    }
    return diff == 0;
}

std::string nowUtc() {
    const std::time_t t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buffer;
}

const Value* stringMember(const Value& object, std::string_view key) {
    const Value* member = object.find(key);
    return member != nullptr && member->kind() == Value::Kind::string ? member : nullptr;
}

// Length of the well-formed UTF-8 sequence at text[pos] (RFC 3629: no
// overlong forms, no surrogates, nothing above U+10FFFF), or 0.
std::size_t utf8Length(std::string_view text, std::size_t pos) noexcept {
    const auto byte = [&](std::size_t i) { return static_cast<unsigned char>(text[pos + i]); };
    const unsigned char first = byte(0);
    if (first < 0x80) {
        return 1;
    }
    std::size_t length = 0;
    unsigned char low = 0x80;
    unsigned char high = 0xBF;
    if (first >= 0xC2 && first <= 0xDF) {
        length = 2;
    } else if (first >= 0xE0 && first <= 0xEF) {
        length = 3;
        low = first == 0xE0 ? 0xA0 : 0x80;
        high = first == 0xED ? 0x9F : 0xBF;
    } else if (first >= 0xF0 && first <= 0xF4) {
        length = 4;
        low = first == 0xF0 ? 0x90 : 0x80;
        high = first == 0xF4 ? 0x8F : 0xBF;
    } else {
        return 0;
    }
    if (pos + length > text.size() || byte(1) < low || byte(1) > high) {
        return 0;
    }
    for (std::size_t i = 2; i < length; ++i) {
        if (byte(i) < 0x80 || byte(i) > 0xBF) {
            return 0;
        }
    }
    return length;
}

// Messages can carry bytes that are not UTF-8 (an exception's what() with a
// Windows path in the ANSI code page); canonical JSON would throw on them.
// Each offending byte becomes U+FFFD.
std::string validUtf8(std::string_view text) {
    std::string out;
    out.reserve(text.size());
    std::size_t pos = 0;
    while (pos < text.size()) {
        const std::size_t length = utf8Length(text, pos);
        if (length == 0) {
            out += "\xEF\xBF\xBD";
            ++pos;
        } else {
            out.append(text.substr(pos, length));
            pos += length;
        }
    }
    return out;
}

// {code, message, step?, data?}; data carries the structured details of
// plan_stale, rollback_conflict, branch_conflict and audition_budget_exceeded.
Value errorValue(const std::string& code, const std::string& message, std::optional<std::size_t> step = {},
                 std::optional<Value> data = {}) {
    Object error{{"code", Value(validUtf8(code))}, {"message", Value(validUtf8(message))}};
    if (step) {
        error.emplace_back("step", Value(static_cast<double>(*step)));
    }
    if (data) {
        error.emplace_back("data", std::move(*data));
    }
    return Value(std::move(error));
}

std::string failure(Value requestId, const std::string& code, const std::string& message,
                    std::optional<std::size_t> step = {}, std::optional<Value> data = {}) {
    return jcs::canonicalize(Value(Object{{"requestId", std::move(requestId)},
                                          {"ok", Value(false)},
                                          {"error", errorValue(code, message, step, std::move(data))}}));
}

std::string success(const std::string& requestId, Value result) {
    return jcs::canonicalize(
        Value(Object{{"requestId", Value(requestId)}, {"ok", Value(true)}, {"result", std::move(result)}}));
}

Value revisionJson(const command::Revision& revision) {
    Array diff;
    for (const auto& entry : revision.diff) {
        diff.push_back(Value(std::string(model::entityTypeName(entry.entity.type)) + ":" + entry.entity.id));
    }
    Object out = session::envelopeToJson(revision.envelope).asObject();
    out.emplace_back("diff", Value(std::move(diff)));
    if (revision.target) {
        out.emplace_back("target", Value(*revision.target));
    }
    return Value(std::move(out));
}

HttpResponse jsonResponse(int status, std::string body) {
    return HttpResponse{status, "application/json", std::move(body), {}};
}

std::string httpError(const std::string& code, const std::string& message) {
    return jcs::canonicalize(Value(Object{{"ok", Value(false)}, {"error", errorValue(code, message)}}));
}

struct Pending {
    ConnectionId connection = 0;
    std::string requestId;
    std::string sessionId;  // the session the request named
    std::string method;
    Value params;
    std::optional<std::string> expectedRevision;  // checked against the head before the method runs
    // MCP: receives the response text instead of a connection.
    std::function<void(const std::string&)> done;
    // MCP: the scope of the credential the request came with (mcpToken
    // carries ServerOptions::mcpScope). Empty: the UI (token), unscoped.
    std::optional<McpScope> scope;
};

struct Connection {
    bool authenticated = false;
    bool realtime = false;  // opened on kRealtimePath: binary frames only
};

// The methods engine.capabilities lists, in this order.
const std::vector<std::string_view> kMethods = {
    "session.inspect", "session.sync",    "session.fetch",   "session.undo",      "session.redo",
    "session.save",    "session.open",    "command.execute", "command.list",      "engine.about",
    "engine.capabilities", "plan.submit", "plan.status",     "plan.approve",      "plan.reject",
    "plan.apply",      "plan.rollback",   "plan.propose",    "proposal.merge",    "proposal.discard",
    "audition.hear",   "render.start",    "job.status",      "transport.play",    "transport.stop",
    "transport.locate", "engine.status", "plugin.instantiate", "plugin.open_editor", "plugin.close_editor",
    "plugin.set_parameter",
};

// PluginHost's capability flags, in the order engine.capabilities lists them.
const std::vector<std::string_view> kPluginFlags = {
    "sampleAccurateParameters", "midiInput", "midiOutput", "sidechain", "variableLatency", "editor",
};

std::string_view changeName(model::DiffEntry::Change change) noexcept {
    switch (change) {
        case model::DiffEntry::Change::added: return "added";
        case model::DiffEntry::Change::removed: return "removed";
        case model::DiffEntry::Change::modified: return "modified";
    }
    return "modified";
}

std::string utf8(const std::filesystem::path& path) {
    const std::u8string text = path.u8string();
    return std::string(text.begin(), text.end());
}

std::filesystem::path fromUtf8(const std::string& text) {
    return std::filesystem::path(std::u8string(text.begin(), text.end()));
}

Value stringArray(const std::vector<std::string>& items) {
    Array out;
    for (const std::string& item : items) {
        out.push_back(Value(item));
    }
    return Value(std::move(out));
}

Value commandNamesJson() {
    return stringArray(command::commandNames());
}

// Params. Each throws ProtocolError invalid_params.
const std::string& requireString(const Value& params, std::string_view key, std::string_view method) {
    const Value* member = stringMember(params, key);
    if (member == nullptr) {
        throw ProtocolError("invalid_params", std::string(method) + " needs a string " + std::string(key));
    }
    return member->asString();
}

std::optional<std::string> optionalString(const Value& params, std::string_view key, std::string_view method) {
    const Value* member = params.find(key);
    if (member == nullptr) {
        return std::nullopt;
    }
    if (member->kind() != Value::Kind::string) {
        throw ProtocolError("invalid_params", std::string(method) + ": " + std::string(key) + " must be a string");
    }
    return member->asString();
}

// A non-negative decimal integer in a string (sample positions are strings).
std::optional<std::int64_t> optionalCount(const Value& params, std::string_view key, std::string_view method) {
    const std::optional<std::string> text = optionalString(params, key, method);
    if (!text) {
        return std::nullopt;
    }
    const bool digits = !text->empty() && text->size() <= 18 &&
                        std::all_of(text->begin(), text->end(), [](char c) { return c >= '0' && c <= '9'; });
    if (!digits) {
        throw ProtocolError("invalid_params",
                            std::string(method) + ": " + std::string(key) + " must be a decimal integer string");
    }
    return std::stoll(*text);
}

std::int64_t requireCount(const Value& params, std::string_view key, std::string_view method) {
    const std::optional<std::int64_t> count = optionalCount(params, key, method);
    if (!count) {
        throw ProtocolError("invalid_params",
                            std::string(method) + " needs a decimal integer string " + std::string(key));
    }
    return *count;
}

std::vector<command::Command> commandList(const Value& params, std::string_view key, std::string_view method) {
    const Value* list = params.find(key);
    if (list == nullptr || list->kind() != Value::Kind::array || list->asArray().empty()) {
        throw ProtocolError("invalid_params", std::string(method) + " needs a non-empty " + std::string(key) + " array");
    }
    std::vector<command::Command> commands;
    const auto& items = list->asArray();
    for (std::size_t i = 0; i < items.size(); ++i) {
        try {
            commands.push_back(command::Command::fromJson(items[i]));
        } catch (const command::CommandError& e) {
            throw command::CommandError(e.code(), e.what(), i);
        }
    }
    return commands;
}

Value transportStateJson(const TransportState& state) {
    return Value(Object{{"playing", Value(state.playing)}, {"position", decimal(state.position)}});
}

Value deviceJson(const std::optional<DeviceInfo>& device) {
    if (!device) {
        return Value(nullptr);
    }
    return Value(Object{{"id", Value(device->id)},
                        {"sampleRate", Value(static_cast<double>(device->sampleRate))},
                        {"bufferFrames", Value(device->bufferFrames)},
                        {"inputLatencyFrames", Value(device->inputLatencyFrames)},
                        {"outputLatencyFrames", Value(device->outputLatencyFrames)}});
}

Value engineStatusJson(const EngineStatus& status) {
    Object out{{"device", deviceJson(status.device)},
               {"playing", Value(status.playing)},
               {"xruns", decimal(status.xruns)},
               {"maxCallbackMicros", Value(status.maxCallbackMicros)},
               {"unmeasuredCallbacks", decimal(status.unmeasuredCallbacks)},
               {"underruns", decimal(status.underruns)},
               {"srcUnderruns", decimal(status.srcUnderruns)}};
    if (status.deviceError) {
        out.emplace_back("deviceError", errorValue(status.deviceError->code, status.deviceError->message));
    }
    return Value(std::move(out));
}

Value capabilityJson(const PluginCapabilityFlags& flags) {
    return Value(Object{{"sampleAccurateParameters", Value(flags.sampleAccurateParameters)},
                        {"midiInput", Value(flags.midiInput)},
                        {"midiOutput", Value(flags.midiOutput)},
                        {"sidechain", Value(flags.sidechain)},
                        {"variableLatency", Value(flags.variableLatency)},
                        {"editor", Value(flags.editor)}});
}

template <typename T>
Value decimalOrNull(const std::optional<T>& value) {
    return value ? decimal(static_cast<std::uint64_t>(*value)) : Value(nullptr);
}

Value pluginStatusJson(const PluginStatus& plugin) {
    Object out{{"slotId", Value(plugin.slotId)},
               {"trackId", Value(plugin.trackId)},
               {"format", Value(plugin.format)},
               {"uid", Value(plugin.uid)},
               {"state", Value(plugin.running ? "running" : "missing")},
               {"capabilities", plugin.capabilities ? capabilityJson(*plugin.capabilities) : Value(nullptr)},
               {"latencyFrames", plugin.latencyFrames ? Value(*plugin.latencyFrames) : Value(nullptr)},
               {"tailFrames", plugin.tailFrames ? Value(*plugin.tailFrames) : Value(nullptr)},
               {"callbacks", decimalOrNull(plugin.callbacks)},
               {"xruns", decimalOrNull(plugin.xruns)},
               {"maxCallbackMicros", plugin.maxCallbackMicros ? Value(*plugin.maxCallbackMicros) : Value(nullptr)},
               {"unmeasuredCallbacks", decimalOrNull(plugin.unmeasuredCallbacks)},
               {"midiOutputOverflows", decimalOrNull(plugin.midiOutputOverflows)},
               {"midiOutputSysex", decimalOrNull(plugin.midiOutputSysex)}};
    if (plugin.error) {
        out.emplace_back("error", errorValue(plugin.error->first, plugin.error->second));
    }
    return Value(std::move(out));
}

Value editorJson(const PluginEditorState& editor) {
    return Value(Object{{"slotId", Value(editor.slotId)},
                        {"editorOpen", Value(editor.editorOpen)},
                        {"nativeHandle", Value(std::to_string(editor.nativeHandle))}});
}

Value descriptorJson(const PluginDescriptorInfo& descriptor) {
    return Value(Object{{"format", Value(descriptor.format)},
                        {"uid", Value(descriptor.uid)},
                        {"name", Value(descriptor.name)},
                        {"path", Value(descriptor.path)}});
}

// The slt_<n> above every slt_<n> any revision of the history holds, so an id
// a plugin.remove or an undo freed is never handed out again (Jobs v0,
// plugins): the live instance table may still pin it for a retiring graph.
std::string nextSlotId(const command::History& history) {
    std::uint64_t highest = 0;
    for (const command::Revision& revision : history.revisions()) {
        for (const model::PluginSlot* slot : revision.document.allPluginSlots()) {
            const std::string& id = slot->id;
            if (id.size() <= 4 || id.compare(0, 4, "slt_") != 0 || id.size() > 4 + 19) {
                continue;
            }
            const bool digits = std::all_of(id.begin() + 4, id.end(), [](char c) { return c >= '0' && c <= '9'; });
            if (digits) {
                highest = std::max<std::uint64_t>(highest, std::stoull(id.substr(4)));
            }
        }
    }
    return "slt_" + std::to_string(highest + 1);
}

// ^[A-Za-z0-9._-]{1,64}$ and not "." or "..": a file name, never a path.
bool validRenderName(const std::string& name) {
    if (name.empty() || name.size() > 64 || name == "." || name == "..") {
        return false;
    }
    return std::all_of(name.begin(), name.end(), [](char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' ||
               c == '-';
    });
}

}  // namespace

struct ProtocolServer::Impl {
    Impl(Transport& t, session::Session& s, ServerOptions o)
        : transport(t),
          session(&s),
          options(std::move(o)),
          token(randomHex(32)),
          mcpToken(distinctHex(token)),
          sessionId("ses_" + randomHex(16)),
          inbox(options.inboxCapacity),
          events(t, sessionId,
                 StreamPosition{0, s.history().head().envelope.id,
                                hash::formatHash(s.history().head().envelope.documentHash), json::Value()},
                 options.events),
          readModel(options.syncChunkEntities),
          realtime(t, options.realtime),
          jobs(options.jobs.workerThread),
          mcp([this](std::string requestId, std::string method, Value params,
                     std::function<void(const std::string&)> done) {
              return submitMcp(std::move(requestId), std::move(method), std::move(params), std::move(done));
          }) {
        if (!options.clock) {
            options.clock = nowUtc;
        }
    }

    Transport& transport;
    session::Session* session;  // command thread; session.open replaces it
    ServerOptions options;
    const std::string token;     // the UI: WebSocket, realtime, plain HTTP
    const std::string mcpToken;  // MCP clients: /v0/mcp only, under options.mcpScope
    std::string sessionId;  // written on the command thread under `mutex`
    std::uint16_t port = 0;
    detail::RequestInbox<Pending> inbox;
    EventStream events;
    ReadModel readModel;
    RealtimeChannel realtime;
    detail::JobRunner jobs;
    detail::McpAdapter mcp;

    std::mutex mutex;                              // guards connections and sessionId
    std::map<ConnectionId, Connection> connections;

    std::mutex pumpMutex;                          // one consumer at a time
    std::unordered_map<std::string, std::string> cache;  // requestId -> response text
    std::deque<std::string> cacheOrder;

    bool started = false;
    std::atomic<bool> running{false};
    std::thread pumpThread;

    std::string currentSessionId() {
        std::lock_guard lock(mutex);
        return sessionId;
    }

    std::optional<HttpResponse> checkOrigin(const HttpRequest& request) const {
        auto origin = request.headers.find("origin");
        if (origin == request.headers.end()) {
            return std::nullopt;
        }
        const auto& allowed = options.allowedOrigins;
        if (std::find(allowed.begin(), allowed.end(), origin->second) != allowed.end()) {
            return std::nullopt;
        }
        // The header bytes are not echoed: they come unchecked from the client
        // and need not be valid UTF-8, which canonical JSON requires.
        return jsonResponse(403, httpError("origin_not_allowed", "this Origin is not allowed"));
    }

    std::optional<HttpResponse> onUpgrade(const HttpRequest& request) const { return checkOrigin(request); }

    // `secret` is token for plain HTTP and mcpToken for /v0/mcp: neither
    // credential opens the other's routes.
    static bool authorized(const HttpRequest& request, const std::string& secret) {
        auto authorization = request.headers.find("authorization");
        return authorization != request.headers.end() && sameSecret(authorization->second, "Bearer " + secret);
    }

    static HttpResponse unauthenticated() {
        return jsonResponse(401, httpError("unauthenticated", "Authorization: Bearer <token> is required"));
    }

    // Any thread: one POST /v0/mcp without blocking.
    void handleMcp(const HttpRequest& request, const std::function<void(HttpResponse)>& complete) {
        if (!authorized(request, mcpToken)) {
            complete(unauthenticated());
            return;
        }
        if (auto rejection = checkOrigin(request)) {
            complete(*rejection);
            return;
        }
        if (request.method != "POST") {
            complete(jsonResponse(405, httpError("method_not_allowed", "POST /v0/mcp only; no SSE stream in v0")));
            return;
        }
        mcp.handle(request, complete);
    }

    // A transport thread: waits for the command thread's answer, bounded by
    // mcpRequestTimeout (the protocol -> command edge of the thread table).
    HttpResponse waitMcp(const HttpRequest& request) {
        struct Slot {
            std::mutex mutex;
            std::condition_variable ready;
            std::optional<HttpResponse> response;
        };
        auto slot = std::make_shared<Slot>();
        handleMcp(request, [slot](HttpResponse response) {
            {
                std::lock_guard lock(slot->mutex);
                slot->response = std::move(response);
            }
            slot->ready.notify_all();
        });
        std::unique_lock lock(slot->mutex);
        if (slot->ready.wait_for(lock, options.mcpRequestTimeout, [&] { return slot->response.has_value(); })) {
            return *slot->response;
        }
        Value id(nullptr);
        try {
            const Value body = json::parse(request.body);
            if (const Value* given = body.find("id")) {
                if (given->kind() == Value::Kind::string || given->kind() == Value::Kind::number) {
                    id = *given;
                }
            }
        } catch (const json::ParseError&) {
        }
        return jsonResponse(
            200, jcs::canonicalize(Value(Object{
                     {"jsonrpc", Value("2.0")},
                     {"id", id},
                     {"error", Value(Object{{"code", Value(-32000)},
                                            {"message", Value("the command thread did not answer in time; retry "
                                                              "with the same id")},
                                            {"data", Value(Object{{"code", Value("request_timeout")}})}})}})));
    }

    HttpResponse onHttp(const HttpRequest& request) {
        if (request.path == kMcpPath) {
            return waitMcp(request);
        }
        if (!authorized(request, token)) {
            return unauthenticated();
        }
        if (request.method == "GET" && request.path == "/v0/health") {
            return jsonResponse(200, R"({"ok":true})");
        }
        // Method and path are not echoed, for the same reason as the Origin.
        return jsonResponse(404, httpError("not_found", "no route for this method and path"));
    }

    // Any thread: an MCP tool call into the inbox, under the current session.
    bool submitMcp(std::string requestId, std::string method, Value params,
                   std::function<void(const std::string&)> done) {
        return inbox.tryPush(Pending{0, std::move(requestId), currentSessionId(), std::move(method), std::move(params),
                                     std::nullopt, std::move(done), options.mcpScope});
    }

    void onOpen(ConnectionId connection, const std::string& path) {
        std::lock_guard lock(mutex);
        connections[connection] = Connection{false, path == kRealtimePath};
    }

    void onClose(ConnectionId connection) {
        std::lock_guard lock(mutex);
        connections.erase(connection);
        events.unsubscribe(connection);
        realtime.remove(connection);
        readModel.forget(connection);
    }

    // A realtime connection: one auth frame, then nothing but outgoing binary
    // frames. No text is ever sent on it; refusals are a close with a reason.
    void onRealtimeMessage(ConnectionId connection, bool authenticated, const std::optional<Value>& parsed) {
        if (authenticated) {
            realtime.remove(connection);
            transport.close(connection, kClosePolicy, "binary_only");
            return;
        }
        const bool isObject = parsed && parsed->kind() == Value::Kind::object;
        const Value* type = isObject ? stringMember(*parsed, "type") : nullptr;
        if (type == nullptr || type->asString() != "auth") {
            transport.close(connection, kClosePolicy, "unauthenticated");
            return;
        }
        const Value* given = stringMember(*parsed, "token");
        if (given == nullptr || !sameSecret(given->asString(), token)) {
            transport.close(connection, kClosePolicy, "invalid_token");
            return;
        }
        std::lock_guard lock(mutex);
        auto it = connections.find(connection);
        if (it == connections.end()) {
            return;
        }
        it->second.authenticated = true;
        realtime.add(connection);
    }

    void reject(ConnectionId connection, const std::string& text, const std::string& code) {
        transport.send(connection, text);
        transport.close(connection, kClosePolicy, code);
    }

    void onMessage(ConnectionId connection, const std::string& text) {
        Connection state;
        std::string served;
        {
            std::lock_guard lock(mutex);
            auto it = connections.find(connection);
            if (it == connections.end()) {
                return;
            }
            state = it->second;
            served = sessionId;
        }
        const bool authenticated = state.authenticated;

        std::optional<Value> parsed;
        try {
            parsed = json::parse(text);
        } catch (const json::ParseError&) {
        }
        if (state.realtime) {
            onRealtimeMessage(connection, authenticated, parsed);
            return;
        }
        const bool isObject = parsed && parsed->kind() == Value::Kind::object;
        const Value* requestIdMember = isObject ? stringMember(*parsed, "requestId") : nullptr;
        const Value requestId = requestIdMember != nullptr ? *requestIdMember : Value(nullptr);

        if (!authenticated) {
            const Value* type = isObject ? stringMember(*parsed, "type") : nullptr;
            if (type == nullptr || type->asString() != "auth") {
                reject(connection, failure(requestId, "unauthenticated", "authenticate first: {type:\"auth\", token}"),
                       "unauthenticated");
                return;
            }
            const Value* given = stringMember(*parsed, "token");
            if (given == nullptr || !sameSecret(given->asString(), token)) {
                reject(connection,
                       jcs::canonicalize(Value(Object{{"type", Value("auth")},
                                                      {"ok", Value(false)},
                                                      {"error", errorValue("invalid_token", "wrong token")}})),
                       "invalid_token");
                return;
            }
            const Value* wantsEvents = parsed->find("events");
            const bool subscribe = wantsEvents != nullptr && wantsEvents->kind() == Value::Kind::boolean &&
                                   wantsEvents->asBool();
            // Runs under the connection lock, which also guards sessionId.
            const auto reply = [this](const StreamPosition& current) {
                return jcs::canonicalize(Value(Object{{"type", Value("auth")},
                                                      {"ok", Value(true)},
                                                      {"sessionId", Value(sessionId)},
                                                      {"revision", Value(current.revision)},
                                                      {"documentHash", Value(current.documentHash)},
                                                      {"seq", Value(std::to_string(current.seq))},
                                                      {"meters", current.meters},
                                                      {"about", aboutJson()}}));
            };
            std::lock_guard lock(mutex);
            auto it = connections.find(connection);
            if (it == connections.end()) {
                return;
            }
            it->second.authenticated = true;
            // Under the connection lock, so a close cannot leave an outbox
            // behind; the stream sends the reply before any event.
            if (subscribe) {
                events.subscribe(connection, reply);
            } else {
                transport.send(connection, reply(events.position()));
            }
            return;
        }

        if (!isObject) {
            transport.send(connection, failure(nullptr, "bad_request", "a request is a JSON object"));
            return;
        }
        if (requestIdMember == nullptr) {
            transport.send(connection, failure(nullptr, "bad_request", "a request needs a string requestId"));
            return;
        }
        const Value* targetSession = stringMember(*parsed, "sessionId");
        if (targetSession == nullptr) {
            transport.send(connection, failure(requestId, "bad_request", "a request needs a string sessionId"));
            return;
        }
        const Value* method = stringMember(*parsed, "method");
        if (method == nullptr) {
            transport.send(connection, failure(requestId, "bad_request", "a request needs a string method"));
            return;
        }
        Value params = Value(Object{});
        if (const Value* given = parsed->find("params")) {
            if (given->kind() != Value::Kind::object) {
                transport.send(connection, failure(requestId, "bad_request", "params must be an object"));
                return;
            }
            params = *given;
        }
        std::optional<std::string> expectedRevision;
        if (const Value* expected = parsed->find("expectedRevision")) {
            if (expected->kind() != Value::Kind::string) {
                transport.send(connection, failure(requestId, "bad_request", "expectedRevision must be a string"));
                return;
            }
            expectedRevision = expected->asString();
        }
        if (targetSession->asString() != served) {
            transport.send(connection, failure(requestId, "session_mismatch", "this server serves session " + served));
            return;
        }
        if (!inbox.tryPush(Pending{connection, requestIdMember->asString(), served, method->asString(),
                                   std::move(params), std::move(expectedRevision), {}, std::nullopt})) {
            transport.send(connection, failure(requestId, "queue_full", "the command inbox is full; retry"));
        }
    }

    // Command thread: a revision the method just committed on main. The
    // event goes out after the response (handle() flushes after sending it).
    std::string published(const Pending& request, const command::Revision& revision) {
        std::string response = success(request.requestId, Value(Object{{"revision", revisionJson(revision)}}));
        events.publishRevision(revision);
        if (options.auditionPort != nullptr) {
            options.auditionPort->mainCommitted();
        }
        return response;
    }

    const command::Plan& requirePlan(const std::string& planHash) const {
        const command::Plan* plan = session->plans().find(planHash);
        if (plan == nullptr) {
            throw command::CommandError("not_found", "no plan " + planHash);
        }
        return *plan;
    }

    command::BranchId requireOpenBranch(const Value& params, std::string_view method) const {
        const std::string& branch = requireString(params, "branch", method);
        if (!session->history().isOpen(branch)) {
            throw command::CommandError("not_found", "no open proposal branch " + branch);
        }
        return branch;
    }

    AuditionPort& requirePort() const {
        if (options.auditionPort == nullptr) {
            throw ProtocolError("audition_unavailable", "this engine host has no auditioner");
        }
        return *options.auditionPort;
    }

    TransportPort& requireTransport() const {
        if (options.transportPort == nullptr) {
            throw ProtocolError("not_supported", "this engine host has no transport");
        }
        return *options.transportPort;
    }

    Value inspectJson() const {
        const auto& history = session->history();
        Object out{{"revision", Value(history.head().envelope.id)},
                   {"documentHash", Value(hash::formatHash(history.head().envelope.documentHash))},
                   {"revisions", Value(static_cast<double>(history.revisions().size()))},
                   {"branches", stringArray(history.branches())}};
        if (options.auditionPort != nullptr) {
            out.emplace_back("heard", Value(options.auditionPort->heard().value_or("main")));
        }
        return Value(std::move(out));
    }

    Value pluginsFeatureJson() const {
        if (options.pluginPort == nullptr) {
            return Value(false);
        }
        Array flags;
        for (const std::string_view flag : kPluginFlags) {
            flags.push_back(Value(std::string(flag)));
        }
        return Value(Object{{"formats", stringArray(options.pluginPort->formats())}, {"flags", Value(std::move(flags))}});
    }

    PluginPort& requirePluginPort() const {
        if (options.pluginPort == nullptr) {
            throw ProtocolError("not_supported", "this engine host has no plugin hosts");
        }
        return *options.pluginPort;
    }

    // engine.status, with plugins[] when there is a plugin port.
    Value engineStatus() const {
        Value status = engineStatusJson(requireTransport().status());
        if (options.pluginPort != nullptr) {
            Array plugins;
            for (const PluginStatus& plugin : options.pluginPort->plugins()) {
                plugins.push_back(pluginStatusJson(plugin));
            }
            Object out = status.asObject();
            out.emplace_back("plugins", Value(std::move(plugins)));
            status = Value(std::move(out));
        }
        return status;
    }

    // plugin.instantiate (Jobs v0, plugins): a job that runs inside the request
    // on the command thread. Its completion command, plugin.insert, enters the
    // history after the state blob is durable.
    std::string pluginInstantiate(const Pending& request) {
        const std::string_view method = "plugin.instantiate";
        const std::string kind(method);
        PluginPort& plugins = requirePluginPort();
        PluginInstantiateRequest wanted;
        wanted.trackId = requireString(request.params, "trackId", method);
        const Value* index = request.params.find("index");
        if (index == nullptr || index->kind() != Value::Kind::number || index->asNumber() < 0 ||
            index->asNumber() > 1e9 || index->asNumber() != static_cast<double>(static_cast<std::int64_t>(index->asNumber()))) {
            throw ProtocolError("invalid_params", "plugin.instantiate: index must be a non-negative integer");
        }
        wanted.index = static_cast<std::int64_t>(index->asNumber());
        const Value* descriptor = request.params.find("descriptor");
        if (descriptor == nullptr || descriptor->kind() != Value::Kind::object) {
            throw ProtocolError("invalid_params", "plugin.instantiate needs a descriptor object");
        }
        for (const auto& [key, value] : descriptor->asObject()) {
            (void)value;
            if (key != "format" && key != "path" && key != "uid" && key != "name") {
                throw ProtocolError("invalid_params", "plugin.instantiate: unknown descriptor field " + key);
            }
        }
        wanted.descriptor.format = requireString(*descriptor, "format", method);
        const std::string& format = wanted.descriptor.format;
        if (format != "clap" && format != "vst3" && format != "au" && format != "lv2") {
            throw ProtocolError("invalid_params", "plugin.instantiate: format must be clap, vst3, au or lv2");
        }
        wanted.descriptor.path = optionalString(*descriptor, "path", method).value_or("");
        wanted.descriptor.uid = optionalString(*descriptor, "uid", method).value_or("");
        wanted.descriptor.name = optionalString(*descriptor, "name", method).value_or("");
        if (wanted.descriptor.path.empty() && wanted.descriptor.uid.empty()) {
            throw ProtocolError("invalid_params", "plugin.instantiate: the descriptor needs a path or a uid");
        }
        wanted.stateBlob = optionalString(request.params, "stateBlob", method);
        if (wanted.stateBlob && !model::isStateBlobHash(*wanted.stateBlob)) {
            throw ProtocolError("invalid_params", "plugin.instantiate: stateBlob must be sha256:<64 lowercase hex>");
        }
        const model::Document& head = session->history().head().document;
        if (head.track(wanted.trackId) == nullptr) {
            throw command::CommandError("not_found", "no track with id " + wanted.trackId);
        }
        wanted.slotId = nextSlotId(session->history());

        PluginInstantiateResult loaded;
        try {
            loaded = plugins.instantiate(wanted);
        } catch (const PluginPortError& error) {
            std::string jobId = jobs.recordFailed(kind, error.code(), error.what());
            return success(request.requestId,
                           Value(Object{{"jobId", Value(std::move(jobId))},
                                        {"kind", Value(kind)},
                                        {"state", Value("failed")},
                                        {"error", errorValue(error.code(), error.what())}}));
        }

        // The blob first, durably; then the command that names it.
        std::optional<std::string> blob = wanted.stateBlob;
        if (!blob && loaded.state) {
            const std::string bytes(loaded.state->begin(), loaded.state->end());
            blob = hash::formatHash(hash::sha256(bytes));
            const std::filesystem::path directory = session->bundlePath() / "blobs";
            io::createDirectoriesDurable(directory);
            io::writeFileAtomic(directory / blob->substr(7), bytes);
        }
        const PluginDescriptorInfo& probed = loaded.descriptor;
        const Value insert(Object{{"op", Value("plugin.insert")},
                                  {"trackId", Value(wanted.trackId)},
                                  {"index", Value(static_cast<double>(wanted.index))},
                                  {"slotId", Value(wanted.slotId)},
                                  {"descriptor", descriptorJson(probed)},
                                  {"stateBlob", blob ? Value(*blob) : Value(nullptr)}});
        model::PluginSlot slot;
        slot.id = wanted.slotId;
        slot.trackId = wanted.trackId;
        slot.format = probed.format;
        slot.uid = probed.uid;
        slot.name = probed.name;
        slot.path = probed.path;
        slot.stateBlob = blob;
        const command::Revision* revision = nullptr;
        try {
            revision = &session->commit({command::Command::fromJson(insert)}, options.actor, options.clock());
        } catch (...) {
            plugins.settle(slot, false);
            throw;
        }
        plugins.settle(*revision->document.pluginSlot(wanted.slotId), true);

        Value result(Object{{"revision", Value(revision->envelope.id)},
                            {"slotId", Value(wanted.slotId)},
                            {"descriptor", descriptorJson(probed)},
                            {"stateBlob", blob ? Value(*blob) : Value(nullptr)},
                            {"latencyFrames", Value(loaded.latencyFrames)},
                            {"tailFrames", Value(loaded.tailFrames)},
                            {"capabilities", capabilityJson(loaded.capabilities)}});
        std::string jobId = jobs.recordDone(kind, result);
        std::string response = success(request.requestId, Value(Object{{"jobId", Value(std::move(jobId))},
                                                                         {"kind", Value(kind)},
                                                                         {"state", Value("done")},
                                                                         {"result", std::move(result)}}));
        events.publishRevision(*revision);
        if (options.auditionPort != nullptr) {
            options.auditionPort->mainCommitted();
        }
        return response;
    }

    // plugin.set_parameter (Protocol v0 item 20): no document change, no revision,
    // no event; the value lives in the instance until its state is next captured.
    std::string pluginSetParameter(const Pending& request) {
        const std::string_view method = "plugin.set_parameter";
        PluginPort& plugins = requirePluginPort();
        const std::string& slotId = requireString(request.params, "slotId", method);
        const std::string& paramId = requireString(request.params, "paramId", method);
        const Value* value = request.params.find("value");
        if (value == nullptr || value->kind() != Value::Kind::number || !(value->asNumber() >= 0.0) ||
            value->asNumber() > 1.0) {
            throw ProtocolError("invalid_params", "plugin.set_parameter needs a normalized number value, 0 to 1");
        }
        plugins.setParameter(slotId, paramId, value->asNumber());
        return success(request.requestId, Value(Object{{"slotId", Value(slotId)},
                                                       {"paramId", Value(paramId)},
                                                       {"value", Value(value->asNumber())}}));
    }

    // The render jobs' plugin sets, back on the command thread to be destroyed.
    void returnRenderInstances() {
        for (auto& instances : jobs.takeFinishedPlugins()) {
            if (options.pluginPort != nullptr) {
                options.pluginPort->destroyRenderInstances(std::move(instances));
            }
        }
    }

    Value capabilitiesJson() const {
        Array methods;
        for (const std::string_view name : kMethods) {
            methods.push_back(Value(std::string(name)));
        }
        return Value(Object{
            {"about", aboutJson()},
            {"scope", Value(std::string(mcpScopeName(options.mcpScope)))},
            {"scopes", Value(Array{Value("propose"), Value("trusted")})},
            {"commands", commandNamesJson()},
            {"methods", Value(std::move(methods))},
            {"features", Value(Object{{"plans", Value(true)},
                                      {"proposals", Value(true)},
                                      {"audition", Value(options.auditionPort != nullptr)},
                                      {"transport", Value(options.transportPort != nullptr)},
                                      {"render", Value(true)},
                                      {"plugins", pluginsFeatureJson()}})},
            {"limits", Value(Object{{"syncChunkEntities", Value(static_cast<double>(options.syncChunkEntities))},
                                    {"inboxCapacity", Value(static_cast<double>(options.inboxCapacity))},
                                    {"idempotencyCapacity", Value(static_cast<double>(options.idempotencyCapacity))}})},
        });
    }

    std::string planSubmit(const Pending& request) {
        const std::string_view method = "plan.submit";
        std::vector<command::Command> steps = commandList(request.params, "steps", method);
        std::vector<model::EntityRef> readSet;
        if (const Value* given = request.params.find("readSet")) {
            if (given->kind() != Value::Kind::array) {
                throw ProtocolError("invalid_params", "plan.submit: readSet must be an array of \"<type>:<id>\"");
            }
            for (const Value& entry : given->asArray()) {
                std::optional<model::EntityRef> ref;
                if (entry.kind() == Value::Kind::string) {
                    ref = parseRef(entry.asString());
                }
                if (!ref) {
                    throw ProtocolError("invalid_params", "plan.submit: readSet entries are \"<type>:<id>\"");
                }
                readSet.push_back(*ref);
            }
        }
        const std::string base =
            optionalString(request.params, "baseRevision", method).value_or(session->history().head().envelope.id);
        const command::Plan& plan = session->submitPlan(std::move(steps), std::move(readSet), base);
        return success(request.requestId, plan.toJson());
    }

    std::string planStatus(const Pending& request) {
        const std::string& planHash = requireString(request.params, "plan", "plan.status");
        const command::Plan& plan = requirePlan(planHash);
        Object out = plan.toJson().asObject();
        Array stale;
        for (const command::StaleEntity& entity : session->plans().validate(session->history(), planHash)) {
            stale.push_back(Value(Object{{"ref", Value(formatRef(entity.entity))},
                                         {"change", Value(std::string(changeName(entity.change)))}}));
        }
        out.emplace_back("stale", Value(std::move(stale)));
        if (const auto branch = session->plans().proposalBranch(planHash)) {
            out.emplace_back("proposalBranch", Value(*branch));
        }
        return success(request.requestId, Value(std::move(out)));
    }

    std::string planApprove(const Pending& request) {
        const std::string& planHash = requireString(request.params, "plan", "plan.approve");
        const Value* given = request.params.find("steps");
        if (given == nullptr) {
            return success(request.requestId,
                           session->approvePlan(planHash, options.actor, options.clock()).toJson());
        }
        if (given->kind() != Value::Kind::array) {
            throw ProtocolError("invalid_params", "plan.approve: steps must be an array of step indexes");
        }
        std::vector<std::size_t> indexes;
        for (const Value& entry : given->asArray()) {
            const bool index = entry.kind() == Value::Kind::number && entry.asNumber() >= 0 &&
                               entry.asNumber() <= 1e9 &&
                               entry.asNumber() == static_cast<double>(static_cast<std::size_t>(entry.asNumber()));
            if (!index) {
                throw ProtocolError("invalid_params", "plan.approve: steps are non-negative integers");
            }
            indexes.push_back(static_cast<std::size_t>(entry.asNumber()));
        }
        return success(request.requestId,
                       session->approvePlanPartial(planHash, indexes, options.actor, options.clock()).toJson());
    }

    std::string planPropose(const Pending& request) {
        const std::string& planHash = requireString(request.params, "plan", "plan.propose");
        const command::BranchId branch = session->proposePlan(planHash, options.actor, options.clock());
        const command::Revision& revision = session->history().branchHead(branch);
        std::string response = success(request.requestId, Value(Object{{"branch", Value(branch)},
                                                                         {"revision", revisionJson(revision)}}));
        events.publishBranchRevision(revision);
        if (options.auditionPort != nullptr) {
            options.auditionPort->branchCommitted(branch);
        }
        return response;
    }

    std::string proposalMerge(const Pending& request) {
        const command::BranchId branch = requireOpenBranch(request.params, "proposal.merge");
        // Through the auditioner when there is one, so the sound follows.
        const command::Revision& revision =
            options.auditionPort != nullptr ? options.auditionPort->merge(branch, options.actor, options.clock())
                                            : session->merge(branch, options.actor, options.clock());
        std::string response = success(request.requestId, Value(Object{{"revision", revisionJson(revision)}}));
        events.publishRevision(revision);
        // The envelope's revision is the merge revision, now main's head.
        events.publish("proposal.closed", Object{{"branch", Value(branch)}, {"merged", Value(true)}});
        return response;
    }

    std::string proposalDiscard(const Pending& request) {
        const command::BranchId branch = requireOpenBranch(request.params, "proposal.discard");
        if (options.auditionPort != nullptr) {
            options.auditionPort->discard(branch);
        } else {
            session->discard(branch);
        }
        events.publish("proposal.closed", Object{{"branch", Value(branch)}, {"merged", Value(false)}});
        return success(request.requestId, Value(Object{}));
    }

    std::string auditionHear(const Pending& request) {
        AuditionPort& auditionPort = requirePort();
        const std::string& side = requireString(request.params, "side", "audition.hear");
        if (side == "main") {
            auditionPort.hearMain();
        } else {
            auditionPort.audition(side);
        }
        return success(request.requestId, Value(Object{{"heard", Value(auditionPort.heard().value_or("main"))}}));
    }

    std::string renderStart(const Pending& request) {
        const std::string_view method = "render.start";
        const std::string& name = requireString(request.params, "name", method);
        if (!validRenderName(name)) {
            throw ProtocolError("invalid_params",
                                "render.start: name must match ^[A-Za-z0-9._-]{1,64}$ and not be . or ..");
        }
        const std::int64_t start = optionalCount(request.params, "start", method).value_or(0);
        const std::int64_t frames = optionalCount(request.params, "frames", method).value_or(-1);
        // The head document is immutable: later commits do not change the job.
        const model::Document& document = session->history().head().document;
        // Its own plugin instances, loaded here before the job is queued; the live
        // graph's are never driven by the render (Jobs v0, plugins).
        std::shared_ptr<engine::PluginNodeSource> plugins;
        if (options.pluginPort != nullptr && !document.allPluginSlots().empty()) {
            plugins = options.pluginPort->instantiateForRender(document);
        }
        std::string jobId = jobs.startRender(
            detail::RenderRequest{name, start, frames, document, session->bundlePath(), std::move(plugins)});
        return success(request.requestId, Value(Object{{"jobId", Value(std::move(jobId))},
                                                         {"kind", Value("render")},
                                                         {"state", Value("queued")}}));
    }

    std::string jobStatus(const Pending& request) {
        const std::string& jobId = requireString(request.params, "jobId", "job.status");
        std::optional<Value> status = jobs.status(jobId);
        if (!status) {
            throw ProtocolError("not_found", "no job " + jobId);
        }
        return success(request.requestId, std::move(*status));
    }

    std::string sessionSave(const Pending& request) {
        session->checkpoint();
        return success(request.requestId, Value(Object{{"revision", Value(session->history().head().envelope.id)},
                                                         {"path", Value(utf8(session->bundlePath() / "session.json"))}}));
    }

    std::string sessionOpen(const Pending& request) {
        const std::string& pathText = requireString(request.params, "path", "session.open");
        if (!options.openSession) {
            throw ProtocolError("not_supported", "this engine host cannot open another session");
        }
        const std::filesystem::path path = fromUtf8(pathText);
        std::error_code ec;
        if (!std::filesystem::is_directory(path, ec)) {
            throw ProtocolError("not_found", "no session bundle at this path");
        }
        session::Session& next = options.openSession(path);
        session = &next;
        const command::Revision& head = next.history().head();
        const std::string nextId = "ses_" + randomHex(16);
        {
            // Requests naming the old id are refused from here on; the event
            // and the auth replies agree on the new id.
            std::lock_guard lock(mutex);
            sessionId = nextId;
            events.publishSessionOpened(nextId, head);
        }
        readModel.forgetAll();
        cache.clear();
        cacheOrder.clear();
        return success(request.requestId,
                       Value(Object{{"sessionId", Value(nextId)},
                                    {"revision", Value(head.envelope.id)},
                                    {"documentHash", Value(hash::formatHash(head.envelope.documentHash))}}));
    }

    // Command thread.
    std::string dispatch(const Pending& request) {
        const std::string& method = request.method;
        if (method == "session.inspect") {
            return success(request.requestId, inspectJson());
        }
        if (method == "command.execute") {
            return published(request, session->commit(commandList(request.params, "commands", method), options.actor,
                                                      options.clock()));
        }
        if (method == "session.undo") {
            return published(request, session->undo(options.actor, options.clock()));
        }
        if (method == "session.redo") {
            return published(request, session->redo(options.actor, options.clock()));
        }
        if (method == "session.sync") {
            return success(request.requestId,
                           readModel.sync(request.connection, request.params, session->history(), events.position()));
        }
        if (method == "session.fetch") {
            return success(request.requestId, readModel.fetch(request.params, session->history()));
        }
        if (method == "engine.about") {
            return success(request.requestId, aboutJson());
        }
        if (method == "command.list") {
            return success(request.requestId, Value(Object{{"commands", commandNamesJson()}}));
        }
        if (method == "engine.capabilities") {
            return success(request.requestId, capabilitiesJson());
        }
        if (method == "plan.submit") {
            return planSubmit(request);
        }
        if (method == "plan.status") {
            return planStatus(request);
        }
        if (method == "plan.approve") {
            return planApprove(request);
        }
        if (method == "plan.reject") {
            const std::string& planHash = requireString(request.params, "plan", method);
            const std::string note = optionalString(request.params, "note", method).value_or("");
            return success(request.requestId,
                           session->rejectPlan(planHash, options.actor, options.clock(), note).toJson());
        }
        if (method == "plan.apply") {
            return published(request, session->applyPlan(requireString(request.params, "plan", method), options.actor,
                                                         options.clock()));
        }
        if (method == "plan.rollback") {
            return published(request, session->rollbackPlan(requireString(request.params, "plan", method),
                                                            options.actor, options.clock()));
        }
        if (method == "plan.propose") {
            return planPropose(request);
        }
        if (method == "proposal.merge") {
            return proposalMerge(request);
        }
        if (method == "proposal.discard") {
            return proposalDiscard(request);
        }
        if (method == "audition.hear") {
            return auditionHear(request);
        }
        if (method == "render.start") {
            return renderStart(request);
        }
        if (method == "job.status") {
            return jobStatus(request);
        }
        if (method == "session.save") {
            return sessionSave(request);
        }
        if (method == "session.open") {
            return sessionOpen(request);
        }
        if (method == "transport.play") {
            return success(request.requestId, transportStateJson(requireTransport().play()));
        }
        if (method == "transport.stop") {
            return success(request.requestId, transportStateJson(requireTransport().stop()));
        }
        if (method == "transport.locate") {
            TransportPort& transportPort = requireTransport();
            const std::int64_t frames = requireCount(request.params, "frames", method);
            return success(request.requestId, transportStateJson(transportPort.locate(frames)));
        }
        if (method == "engine.status") {
            return success(request.requestId, engineStatus());
        }
        if (method == "plugin.instantiate") {
            return pluginInstantiate(request);
        }
        if (method == "plugin.open_editor") {
            PluginPort& plugins = requirePluginPort();
            return success(request.requestId, editorJson(plugins.openEditor(requireString(request.params, "slotId", method))));
        }
        if (method == "plugin.close_editor") {
            PluginPort& plugins = requirePluginPort();
            return success(request.requestId,
                           editorJson(plugins.closeEditor(requireString(request.params, "slotId", method))));
        }
        if (method == "plugin.set_parameter") {
            return pluginSetParameter(request);
        }
        return failure(Value(request.requestId), "unknown_method", "unknown method " + request.method);
    }

    // Command thread: every exception becomes one error response.
    std::string execute(const Pending& request) {
        const Value id(request.requestId);
        try {
            if (request.expectedRevision) {
                const std::string& current = session->history().head().envelope.id;
                if (*request.expectedRevision != current) {
                    return failure(id, "revision_mismatch",
                                   "expected revision " + *request.expectedRevision + " but the head is " + current);
                }
            }
            return dispatch(request);
        } catch (const ProtocolError& e) {
            return failure(id, e.code(), e.what());
        } catch (const command::PlanStaleError& e) {
            Array changed;
            for (const command::StaleEntity& entity : e.changedEntities()) {
                changed.push_back(Value(Object{{"ref", Value(formatRef(entity.entity))},
                                               {"change", Value(std::string(changeName(entity.change)))}}));
            }
            return failure(id, e.code(), e.what(), e.step(),
                           Value(Object{{"plan", Value(e.plan())}, {"changedEntities", Value(std::move(changed))}}));
        } catch (const command::RollbackError& e) {
            return failure(id, e.code(), e.what(), e.step(),
                           Value(Object{{"entities", stringArray(e.conflictKeys())}}));
        } catch (const command::BranchConflictError& e) {
            return failure(id, e.code(), e.what(), e.step(), Value(Object{{"entities", stringArray(e.entities())}}));
        } catch (const command::CommandError& e) {
            return failure(id, e.code(), e.what(), e.step());
        } catch (const session::SessionError& e) {
            return failure(id, e.code(), e.what());
        } catch (const AuditionPortError& e) {
            std::optional<Value> data;
            if (const auto& budget = e.budget()) {
                data = Value(Object{{"resource", Value(budget->resource)},
                                    {"needed", Value(std::to_string(budget->needed))},
                                    {"budget", Value(std::to_string(budget->budget))}});
            }
            return failure(id, e.code(), e.what(), std::nullopt, std::move(data));
        } catch (const TransportPortError& e) {
            return failure(id, e.code(), e.what());
        } catch (const PluginPortError& e) {
            return failure(id, e.code(), e.what());
        } catch (const std::exception& e) {
            return failure(id, "internal_error", e.what());
        } catch (...) {
            return failure(id, "internal_error", "the method threw a non-standard exception");
        }
    }

    void remember(const std::string& requestId, const std::string& response) {
        const std::size_t capacity = std::max<std::size_t>(options.idempotencyCapacity, 1);
        while (cacheOrder.size() >= capacity) {
            cache.erase(cacheOrder.front());
            cacheOrder.pop_front();
        }
        cache.emplace(requestId, response);
        cacheOrder.push_back(requestId);
    }

    void deliver(const Pending& request, const std::string& response) {
        if (request.done) {
            request.done(response);
        } else {
            transport.send(request.connection, response);
        }
    }

    // Command thread: scope_denied for an MCP request whose credential's scope
    // does not cover its method (spec, Scopes v0). The scope comes from the
    // credential (Pending::scope), so the check holds whatever the adapter
    // sent; a method no tool maps is denied too.
    std::optional<std::string> scopeDenied(const Pending& request) const {
        if (!request.scope || *request.scope == McpScope::trusted) {
            return std::nullopt;
        }
        const Value id(request.requestId);
        for (const detail::McpTool& tool : detail::mcpTools()) {
            if (tool.method == request.method) {
                if (tool.scope == McpScope::propose) {
                    return std::nullopt;
                }
                return failure(id, "scope_denied", std::string(tool.name) + " needs the trusted scope");
            }
        }
        return failure(id, "scope_denied", "no MCP tool runs " + request.method);
    }

    // Command thread, under pumpMutex.
    void handle(std::vector<Pending> requests) {
        for (const auto& request : requests) {
            // Envelope errors are answered before the cache and never cached
            // (Protocol v0 item 5), so a retry with the same requestId runs.
            // A request queued before a session.open in the same pump still
            // names the old session: session_mismatch, not a cached answer.
            if (request.sessionId != sessionId) {
                deliver(request,
                        failure(Value(request.requestId), "session_mismatch", "this server serves session " + sessionId));
                continue;
            }
            if (auto denied = scopeDenied(request)) {
                deliver(request, *denied);
                continue;
            }
            auto cached = cache.find(request.requestId);
            if (cached != cache.end()) {
                deliver(request, cached->second);
                continue;
            }
            std::string response = execute(request);
            remember(request.requestId, response);
            deliver(request, response);
        }
        events.flush();
    }

    void stopPumpThread() {
        running = false;
        inbox.wake();
        if (pumpThread.joinable()) {
            pumpThread.join();
        }
    }
};

ProtocolServer::ProtocolServer(Transport& transport, session::Session& session, ServerOptions options)
    : impl_(std::make_unique<Impl>(transport, session, std::move(options))) {
    Impl* impl = impl_.get();
    TransportHandlers handlers;
    handlers.onUpgrade = [impl](const HttpRequest& request) { return impl->onUpgrade(request); };
    handlers.onOpen = [impl](ConnectionId connection, const std::string& path) { impl->onOpen(connection, path); };
    handlers.onMessage = [impl](ConnectionId connection, const std::string& text) { impl->onMessage(connection, text); };
    handlers.onClose = [impl](ConnectionId connection) { impl->onClose(connection); };
    handlers.onHttp = [impl](const HttpRequest& request) { return impl->onHttp(request); };
    impl_->transport.setHandlers(std::move(handlers));
}

ProtocolServer::~ProtocolServer() {
    stop();
}

void ProtocolServer::start() {
    if (impl_->started) {
        return;
    }
    impl_->port = impl_->transport.listen(impl_->options.host, impl_->options.port).port;
    impl_->started = true;
    if (impl_->options.pumpThread) {
        impl_->running = true;
        Impl* impl = impl_.get();
        impl_->pumpThread = std::thread([impl] {
            while (impl->running) {
                // A condition wait: wakes on a request or on stop(); the
                // timeout only bounds a missed wake-up.
                auto requests = impl->inbox.waitDrain(std::chrono::milliseconds(250));
                std::lock_guard lock(impl->pumpMutex);
                try {
                    impl->handle(std::move(requests));
                } catch (...) {
                    // execute() answers every exception itself; this only
                    // keeps the thread alive if sending or caching throws
                    // (bad_alloc, say). An exception leaving a thread
                    // function would end the process.
                }
            }
        });
    }
}

void ProtocolServer::stop() {
    impl_->stopPumpThread();
    if (impl_->started) {
        // No transport thread is left waiting on an MCP answer after this.
        impl_->transport.stop();
        impl_->started = false;
    }
    impl_->jobs.stop();
}

std::size_t ProtocolServer::pump() {
    std::lock_guard lock(impl_->pumpMutex);
    auto requests = impl_->inbox.drain();
    const std::size_t count = requests.size();
    impl_->handle(std::move(requests));
    impl_->returnRenderInstances();
    return count;
}

const std::string& ProtocolServer::token() const noexcept {
    return impl_->token;
}

const std::string& ProtocolServer::mcpToken() const noexcept {
    return impl_->mcpToken;
}

const std::string& ProtocolServer::sessionId() const noexcept {
    return impl_->sessionId;
}

std::uint16_t ProtocolServer::port() const noexcept {
    return impl_->port;
}

void ProtocolServer::publishRevision(const command::Revision& revision) {
    impl_->events.publishRevision(revision);
}

EventStream& ProtocolServer::events() noexcept {
    return impl_->events;
}

RealtimeChannel& ProtocolServer::realtime() noexcept {
    return impl_->realtime;
}

std::string_view mcpScopeName(McpScope scope) noexcept {
    return scope == McpScope::trusted ? "trusted" : "propose";
}

session::Session& ProtocolServer::session() noexcept {
    return *impl_->session;
}

void ProtocolServer::handleMcp(const HttpRequest& request, std::function<void(HttpResponse)> complete) {
    impl_->handleMcp(request, complete);
}

std::size_t ProtocolServer::runJobs() {
    return impl_->jobs.runQueued();
}

bool ProtocolServer::waitJob(const std::string& jobId, std::chrono::milliseconds timeout) {
    return impl_->jobs.wait(jobId, timeout);
}

}  // namespace siann::protocol
