#include "siann/protocol/protocol_server.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <ctime>
#include <deque>
#include <exception>
#include <filesystem>
#include <initializer_list>
#include <map>
#include <mutex>
#include <optional>
#include <string_view>
#include <random>
#include <set>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include "agent_registry.hpp"
#include "agent_requests.hpp"
#include "jobs.hpp"
#include "mcp_adapter.hpp"
#include "request_inbox.hpp"
#include "siann/protocol/about.hpp"
#include "siann/protocol/read_model.hpp"
#include "siann/command/command.hpp"
#include "siann/command/plan.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/hash/merkle.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/media/peaks.hpp"
#include "siann/model/display_text.hpp"
#include "siann/session/journal.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/takes.hpp"

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
    // Not a request: the connection closed. The command thread ends its
    // gestures after the requests it queued before the close.
    bool closed = false;
    // m5b-engine-plan-metadata, set by the server, never from the request: the
    // client's sanitised name (the UI's auth frame client.name, the MCP
    // session's clientInfo.name) for the actor of a plan it submits, and for an
    // MCP tool call its agent and the tool's name (the agent's lastAction).
    std::string clientName{};
    std::string agentId{};
    std::string tool{};
};

// An open fader gesture (Protocol v0 item 24): who holds it and since when it
// was last renewed. Command thread only.
struct Lease {
    ConnectionId owner = 0;
    GestureTarget target;
    double startValue = 0.0;
    std::chrono::steady_clock::time_point renewed{};
};

std::string leaseKey(const GestureTarget& target) {
    return target.ref() + "/" + target.param;
}

Value targetJson(const GestureTarget& target) {
    return Value(Object{{"ref", Value(target.ref())}, {"param", Value(target.param)}});
}

// {target: {ref: "track:<id>", param}}, {target: {ref: "master:master",
// param: "gain"}} (m5b-engine-master), {target: {ref: "bus:<id>", param:
// "gain"}} or {target: {ref: "send:<id>", param: "level"}}
// (m5b-engine-buses-sends). Throws ProtocolError invalid_params.
GestureTarget requireTarget(const Value& params, std::string_view method) {
    const Value* target = params.find("target");
    if (target == nullptr || target->kind() != Value::Kind::object) {
        throw ProtocolError("invalid_params", std::string(method) + " needs a target object {ref, param}");
    }
    const Value* ref = stringMember(*target, "ref");
    const std::optional<model::EntityRef> parsed = ref != nullptr ? parseRef(ref->asString()) : std::nullopt;
    const bool isMaster = parsed && parsed->type == model::EntityType::master && parsed->id == model::kMasterId;
    const bool isMix = parsed && (parsed->type == model::EntityType::bus || parsed->type == model::EntityType::send) &&
                       hash::isValidEntityId(parsed->id);
    if (!parsed || (parsed->type != model::EntityType::track && !isMaster && !isMix)) {
        throw ProtocolError("invalid_params", std::string(method) +
                                                  ": target.ref must be \"track:<id>\", \"master:master\", "
                                                  "\"bus:<id>\" or \"send:<id>\"");
    }
    const Value* param = stringMember(*target, "param");
    if (isMaster) {
        if (param == nullptr || param->asString() != "gain") {
            throw ProtocolError("invalid_params", std::string(method) + ": the master target's param is gain");
        }
        return GestureTarget::masterGain();
    }
    if (parsed->type == model::EntityType::bus) {
        if (param == nullptr || param->asString() != "gain") {
            throw ProtocolError("invalid_params", std::string(method) + ": a bus target's param is gain");
        }
        return GestureTarget::busGain(parsed->id);
    }
    if (parsed->type == model::EntityType::send) {
        if (param == nullptr || param->asString() != "level") {
            throw ProtocolError("invalid_params", std::string(method) + ": a send target's param is level");
        }
        return GestureTarget::sendLevel(parsed->id);
    }
    if (param == nullptr ||
        (param->asString() != "gain" && param->asString() != "pan" && param->asString() != "mute")) {
        throw ProtocolError("invalid_params", std::string(method) + ": target.param must be gain, pan or mute");
    }
    return GestureTarget::track(parsed->id, param->asString());
}

// The value in the entity's units: a number, and 0 or 1 for mute.
std::optional<double> gestureValue(const Value& params, std::string_view method, const GestureTarget& target,
                                   bool required) {
    const Value* value = params.find("value");
    if (value == nullptr && !required) {
        return std::nullopt;
    }
    if (value == nullptr || value->kind() != Value::Kind::number) {
        throw ProtocolError("invalid_params", std::string(method) + " needs a number value");
    }
    const double number = value->asNumber();
    if (target.param == "mute" && number != 0.0 && number != 1.0) {
        throw ProtocolError("invalid_params", std::string(method) + ": a mute value is 0 or 1");
    }
    return number;
}

// Methods that are never cached: running one again changes nothing (latest wins).
bool uncachedMethod(std::string_view method) noexcept {
    return method == "gesture.update" || method == "gesture.hold";
}

struct Connection {
    bool authenticated = false;
    bool realtime = false;  // opened on kRealtimePath: binary frames only
    std::string clientName{};  // the auth frame's client.name, sanitised
};

// plan.submit's params (spec, "Plans", decisions of 2026-11-15): anything else,
// an actor above all, is invalid_params. `request` links the plan to an agent
// request (m5b-engine-agent-requests); it is not part of the plan.
constexpr std::string_view kPlanSubmitParams[] = {"steps", "readSet", "baseRevision", "title", "intent", "request"};

// Protocol v0 item 32 (Scopes v0, credential-bound methods): the user's side of
// an agent request is the UI credential's, the agent's side the MCP credential's.
bool uiOnlyMethod(std::string_view method) noexcept {
    return method == "agent.request" || method == "agent.cancel_request" || method == "agent.requests";
}

bool mcpOnlyMethod(std::string_view method) noexcept {
    return method == "agent.next_request" || method == "agent.answer_request";
}

// Refuses any param not in `allowed` (invalid_params).
void onlyParams(const Value& params, std::initializer_list<std::string_view> allowed, std::string_view method) {
    for (const auto& member : params.asObject()) {
        if (std::find(allowed.begin(), allowed.end(), member.first) == allowed.end()) {
            throw ProtocolError("invalid_params", std::string(method) + ": unknown param " + member.first);
        }
    }
}

// agent.request's selection: {tracks?: [id], clips?: [id]}, each id of the ID
// shape, at most detail::kSelectionMaxIds per list; both lists, empty when absent.
Value selectionJson(const Value& params, std::string_view method) {
    Array tracks;
    Array clips;
    if (const Value* given = params.find("selection")) {
        if (given->kind() != Value::Kind::object) {
            throw ProtocolError("invalid_params", std::string(method) + ": selection must be {tracks?, clips?}");
        }
        for (const auto& [key, list] : given->asObject()) {
            if (key != "tracks" && key != "clips") {
                throw ProtocolError("invalid_params", std::string(method) + ": unknown selection member " + key);
            }
            if (list.kind() != Value::Kind::array || list.asArray().size() > detail::kSelectionMaxIds) {
                throw ProtocolError("invalid_params",
                                    std::string(method) + ": selection." + key + " is an array of at most 256 ids");
            }
            for (const Value& id : list.asArray()) {
                if (id.kind() != Value::Kind::string || !hash::isValidEntityId(id.asString())) {
                    throw ProtocolError("invalid_params", std::string(method) + ": selection ids are [A-Za-z0-9_-]{1,64}");
                }
            }
            (key == "tracks" ? tracks : clips) = list.asArray();
        }
    }
    return Value(Object{{"tracks", Value(std::move(tracks))}, {"clips", Value(std::move(clips))}});
}

// The title or intent param: absent, or a string (invalid_plan_metadata otherwise;
// the limits are command::checkPlanMetadata's).
std::optional<std::string> planMetadataString(const Value& params, std::string_view key) {
    const Value* value = params.find(key);
    if (value == nullptr) {
        return std::nullopt;
    }
    if (value->kind() != Value::Kind::string) {
        throw command::CommandError("invalid_plan_metadata", "plan.submit: " + std::string(key) + " must be a string");
    }
    return value->asString();
}

// The methods engine.capabilities lists, in this order.
const std::vector<std::string_view> kMethods = {
    "session.inspect", "session.sync",    "session.fetch",   "session.undo",      "session.redo",
    "session.save",    "session.open",    "command.execute", "command.list",      "engine.about",
    "engine.capabilities", "plan.submit", "plan.status",     "plan.approve",      "plan.reject",
    "plan.apply",      "plan.rollback",   "plan.propose",    "proposal.merge",    "proposal.discard",
    "audition.hear",   "render.start",    "job.status",      "transport.play",    "transport.stop",
    "transport.locate", "engine.status", "plugin.instantiate", "plugin.open_editor", "plugin.close_editor",
    "plugin.set_parameter", "plugin.registry", "plugin.approve", "engine.devices", "engine.select_device",
    "gesture.begin",   "gesture.update",  "gesture.hold",    "gesture.end",       "gesture.cancel",
    "plan.list",       "plan.preview",    "transport.set_cycle", "transport.set_click",
    "transport.set_punch", "transport.set_preroll", "transport.set_count_in",
    "record.arm",      "transport.record", "record.recover_take",
    "session.create",  "media.import",    "meter.reset_loudness",
    "agent.request",   "agent.cancel_request", "agent.requests", "agent.next_request", "agent.answer_request",
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

// command.list's cascades (m5b-engine-buses-sends): command name -> the sorted
// entity types it may remove or change besides its target.
Value commandCascadesJson() {
    Object out;
    for (const auto& [name, types] : command::commandCascades()) {
        out.emplace_back(name, stringArray(types));
    }
    return Value(std::move(out));
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

Value clickJson(const ClickState& click) {
    return Value(Object{{"enabled", Value(click.enabled)}, {"gainMilliDb", Value(click.gainMilliDb)}});
}

Value punchJson(const PunchState& punch) {
    return Value(Object{{"in", Value(punch.in)}, {"out", Value(punch.out)}});
}

Value barsJson(const BarsState& state) {
    return Value(Object{{"enabled", Value(state.enabled)}, {"bars", Value(state.bars)}});
}

Value transportStateJson(const TransportState& state) {
    return Value(Object{{"playing", Value(state.playing)},
                        {"position", decimal(state.position)},
                        {"cycle", Value(state.cycle)},
                        {"click", clickJson(state.click)},
                        {"recording", Value(state.recording)},
                        {"armed", stringArray(state.armed)},
                        {"punch", punchJson(state.punch)},
                        {"preroll", barsJson(state.preroll)},
                        {"countIn", barsJson(state.countIn)}});
}

bool requireBool(const Value& params, std::string_view key, std::string_view method) {
    const Value* value = params.find(key);
    if (value == nullptr || value->kind() != Value::Kind::boolean) {
        throw ProtocolError("invalid_params", std::string(method) + " needs a boolean " + std::string(key));
    }
    return value->asBool();
}

// transport.set_click's optional gainMilliDb: an integer in the click's range.
std::optional<std::int32_t> optionalClickGain(const Value& params) {
    const Value* value = params.find("gainMilliDb");
    if (value == nullptr) {
        return std::nullopt;
    }
    if (value->kind() != Value::Kind::number || std::floor(value->asNumber()) != value->asNumber() ||
        value->asNumber() < ClickState::kMinGainMilliDb || value->asNumber() > ClickState::kMaxGainMilliDb) {
        throw ProtocolError("invalid_params", "transport.set_click: gainMilliDb must be an integer in [-60000, 0]");
    }
    return static_cast<std::int32_t>(value->asNumber());
}

// transport.set_preroll's and set_count_in's optional bars (Protocol v0 item 34):
// an integer in [1, 8].
std::optional<std::int32_t> optionalBars(const Value& params, std::string_view method) {
    const Value* value = params.find("bars");
    if (value == nullptr) {
        return std::nullopt;
    }
    if (value->kind() != Value::Kind::number || std::floor(value->asNumber()) != value->asNumber() ||
        value->asNumber() < BarsState::kMinBars || value->asNumber() > BarsState::kMaxBars) {
        throw ProtocolError("invalid_params", std::string(method) + ": bars must be an integer in [1, 8]");
    }
    return static_cast<std::int32_t>(value->asNumber());
}

Value deviceJson(const std::optional<DeviceInfo>& device) {
    if (!device) {
        return Value(nullptr);
    }
    Value input(nullptr);
    if (device->input) {
        input = Value(Object{{"id", Value(device->input->id)},
                             {"channels", Value(device->input->channels)},
                             {"latencyFrames", Value(device->input->latencyFrames)}});
    }
    return Value(Object{{"id", Value(device->id)},
                        {"sampleRate", Value(static_cast<double>(device->sampleRate))},
                        {"bufferFrames", Value(device->bufferFrames)},
                        {"inputLatencyFrames", Value(device->inputLatencyFrames)},
                        {"outputLatencyFrames", Value(device->outputLatencyFrames)},
                        {"input", std::move(input)}});
}

Value countOrNull(const std::optional<int>& count) {
    return count ? Value(*count) : Value(nullptr);
}

Value devicesJson(const std::vector<DeviceDescription>& devices) {
    Array out;
    for (const DeviceDescription& device : devices) {
        out.push_back(Value(Object{{"id", Value(device.id)},
                                   {"type", Value(device.type)},
                                   {"name", Value(device.name)},
                                   {"isDefault", Value(device.isDefault)},
                                   {"current", Value(device.current)},
                                   {"inputChannels", countOrNull(device.inputChannels)},
                                   {"outputChannels", countOrNull(device.outputChannels)}}));
    }
    return Value(Object{{"devices", Value(std::move(out))}});
}

Value engineStatusJson(const EngineStatus& status) {
    Object out{{"device", deviceJson(status.device)},
               {"playing", Value(status.playing)},
               {"cycle", Value(status.cycle)},
               {"click", clickJson(status.click)},
               {"recording", Value(status.recording)},
               {"armed", stringArray(status.armed)},
               {"punch", punchJson(status.punch)},
               {"preroll", barsJson(status.preroll)},
               {"countIn", barsJson(status.countIn)},
               {"xruns", decimal(status.xruns)},
               {"maxCallbackMicros", Value(status.maxCallbackMicros)},
               {"unmeasuredCallbacks", decimal(status.unmeasuredCallbacks)},
               {"underruns", decimal(status.underruns)},
               {"srcUnderruns", decimal(status.srcUnderruns)},
               {"monitorRoundTripFrames", status.monitorRoundTripFrames
                                              ? Value(static_cast<double>(*status.monitorRoundTripFrames))
                                              : Value(nullptr)},
               // Protocol v0 item 31: fractions of the device period, JSON numbers.
               {"load", Value(Object{{"average", Value(status.load.average)}, {"peak", Value(status.load.peak)}})}};
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
    // The owner: trackId for a track's slot, busId for a bus's (m5b-engine-buses-sends).
    if (!plugin.busId.empty()) {
        out.emplace_back("busId", Value(plugin.busId));
    } else {
        out.emplace_back("trackId", Value(plugin.trackId));
    }
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

// med_<n> above every med_<n> any revision of the history holds (Jobs v0,
// import), as nextSlotId does for slots.
std::string nextMediaId(const command::History& history) {
    std::uint64_t highest = 0;
    for (const command::Revision& revision : history.revisions()) {
        for (const model::Media* entity : revision.document.allMedia()) {
            const std::string& id = entity->id;
            if (id.size() <= 4 || id.compare(0, 4, "med_") != 0 || id.size() > 4 + 19) {
                continue;
            }
            const bool digits = std::all_of(id.begin() + 4, id.end(), [](char c) { return c >= '0' && c <= '9'; });
            if (digits) {
                highest = std::max<std::uint64_t>(highest, std::stoull(id.substr(4)));
            }
        }
    }
    return "med_" + std::to_string(highest + 1);
}

// A path the engine reads or writes on the user's disk (session.create,
// media.import): absolute, and not UNC (\\server\share, \\?\UNC\..., //server).
std::filesystem::path localAbsolutePath(const std::string& text, std::string_view method) {
    const bool unc = text.size() >= 2 && (text[0] == '\\' || text[0] == '/') && (text[1] == '\\' || text[1] == '/');
    const std::filesystem::path path(std::u8string(text.begin(), text.end()));
    if (unc || !path.is_absolute()) {
        throw ProtocolError("invalid_params", std::string(method) + ": path must be an absolute local path, not UNC");
    }
    return path;
}

// ^[A-Za-z0-9._-]{1,64}$ and not "." or "..": a file name, never a path.
// GET /v0/peaks/<sha256 hex> (Protocol v0 item 23).
constexpr std::string_view kPeaksPrefix = "/v0/peaks/";

bool isLowerHex64(std::string_view text) noexcept {
    return text.size() == 64 && std::all_of(text.begin(), text.end(), [](char c) {
               return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
           });
}

// The head's media table as the protocol thread reads it: content hash (hex)
// to the stored file's hash and format, and the bundle that holds them.
struct MediaTable {
    const session::Session* session = nullptr;
    std::string revision;
    std::filesystem::path bundle;
    std::map<std::string, std::pair<hash::Digest, model::MediaFormat>, std::less<>> files;
};

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
          jobs(options.jobs.workerThread, [this] { inbox.wake(); }),
          agents(options.agentsRetained, [this] { return steadyNow(); }, [this] { inbox.wake(); }),
          mcp(
              [this](std::string requestId, std::string method, Value params, detail::McpCaller caller,
                     std::function<void(const std::string&)> done) {
                  return submitMcp(std::move(requestId), std::move(method), std::move(params), std::move(caller),
                                   std::move(done));
              },
              agents),
          agentRequests(options.agentRequestsPerAgent) {
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
    detail::AgentRegistry agents;  // Protocol v0 item 29; its own mutex
    detail::McpAdapter mcp;
    // Protocol v0 item 32: the requests from the user to the agents. Command
    // thread only, under pumpMutex.
    detail::AgentRequestStore agentRequests;

    std::mutex mutex;                              // guards connections and sessionId
    std::map<ConnectionId, Connection> connections;

    // Peaks (Protocol v0 item 23): the head's media table, written by the
    // command thread and read by transport threads, and the job queued for
    // each hash whose pyramid is being computed. Both under peaksMutex.
    std::mutex peaksMutex;
    MediaTable mediaTable;
    std::map<std::string, std::string, std::less<>> peaksJobs;  // hex -> jobId

    std::mutex pumpMutex;                          // one consumer at a time
    std::unordered_map<std::string, std::string> cache;  // requestId -> response text
    std::deque<std::string> cacheOrder;
    // Open gestures by leaseKey(target); command thread, under pumpMutex.
    std::map<std::string, Lease> leases;
    // Closes the inbox could not take (it was full), under `mutex`.
    std::vector<ConnectionId> closedOverflow;
    // media.import's clientImportId -> jobId for the served session; command thread.
    std::map<std::string, std::string, std::less<>> importIds;

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
        if (request.method == "DELETE") {
            mcp.end(request, complete);
            return;
        }
        if (request.method != "POST") {
            complete(jsonResponse(405, httpError("method_not_allowed",
                                                 "POST and DELETE /v0/mcp only; no SSE stream in v0")));
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

    // Command thread: copies the head's media table for the peaks route when
    // the served revision or session changed since the last copy.
    void refreshMediaTable() {
        const command::Revision& head = session->history().head();
        {
            std::lock_guard lock(peaksMutex);
            if (mediaTable.session == session && mediaTable.revision == head.envelope.id) {
                return;
            }
        }
        MediaTable next;
        next.session = session;
        next.revision = head.envelope.id;
        next.bundle = session->bundlePath();
        for (const model::Media* entity : head.document.allMedia()) {
            next.files.emplace(hash::toHex(entity->contentHash), std::pair{entity->contentHash, entity->format});
        }
        std::lock_guard lock(peaksMutex);
        if (mediaTable.bundle != next.bundle) {
            peaksJobs.clear();
        }
        mediaTable = std::move(next);
    }

    // The cached pyramid's bytes when the file parses.
    static std::optional<std::string> cachedPeaks(const std::filesystem::path& file) {
        std::error_code ec;
        if (!std::filesystem::is_regular_file(file, ec)) {
            return std::nullopt;
        }
        try {
            std::string bytes = io::readFile(file);
            media::decodePeaks(bytes);
            return bytes;
        } catch (const std::exception&) {
            return std::nullopt;  // regenerable: rebuilt below
        }
    }

    // A transport thread: GET (and the CORS preflight of) /v0/peaks/<hex>,
    // answered from the cache file or by queueing its computation, never
    // through the command thread.
    HttpResponse onPeaks(const HttpRequest& request) {
        auto origin = request.headers.find("origin");
        const bool hasOrigin = origin != request.headers.end();
        const bool originAllowed =
            !hasOrigin || std::find(options.allowedOrigins.begin(), options.allowedOrigins.end(), origin->second) !=
                              options.allowedOrigins.end();
        const auto cors = [&](HttpResponse response) {
            if (hasOrigin && originAllowed) {
                response.headers["Access-Control-Allow-Origin"] = origin->second;
                response.headers["Vary"] = "Origin";
            }
            return response;
        };
        if (request.method == "OPTIONS") {
            if (!hasOrigin || !originAllowed) {
                return jsonResponse(403, httpError("origin_not_allowed", "this Origin is not allowed"));
            }
            HttpResponse preflight = cors(HttpResponse{204, "text/plain", {}, {}});
            preflight.headers["Access-Control-Allow-Methods"] = "GET";
            preflight.headers["Access-Control-Allow-Headers"] = "authorization";
            preflight.headers["Access-Control-Max-Age"] = "600";
            return preflight;
        }
        if (!authorized(request, token)) {
            return cors(unauthenticated());
        }
        if (!originAllowed) {
            return jsonResponse(403, httpError("origin_not_allowed", "this Origin is not allowed"));
        }
        const std::string_view hex = std::string_view(request.path).substr(kPeaksPrefix.size());
        if (request.method != "GET" || !isLowerHex64(hex)) {
            return cors(jsonResponse(404, httpError("not_found", "no route for this method and path")));
        }
        // The hash names a file only once the served document holds it.
        std::filesystem::path bundle;
        hash::Digest contentHash{};
        model::MediaFormat format = model::MediaFormat::wav;
        {
            std::lock_guard lock(peaksMutex);
            auto entry = mediaTable.files.find(hex);
            if (entry == mediaTable.files.end()) {
                return cors(jsonResponse(404, httpError("not_found", "no media of the served document has this hash")));
            }
            bundle = mediaTable.bundle;
            contentHash = entry->second.first;
            format = entry->second.second;
        }
        std::error_code ec;
        if (!std::filesystem::exists(session::mediaPath(bundle, contentHash, format), ec)) {
            return cors(jsonResponse(404, httpError("media_missing", "the media file of this hash is missing")));
        }
        const std::filesystem::path file = media::peaksPath(bundle, hex);
        const auto served = [&](std::string bytes) {
            return cors(HttpResponse{200, "application/octet-stream", std::move(bytes), {}});
        };
        if (auto bytes = cachedPeaks(file)) {
            return served(std::move(*bytes));
        }
        std::lock_guard lock(peaksMutex);
        auto job = peaksJobs.find(hex);
        if (job != peaksJobs.end()) {
            const std::optional<detail::JobState> state = jobs.state(job->second);
            if (state == detail::JobState::queued || state == detail::JobState::running) {
                return cors(jsonResponse(202, httpError("peaks_pending", "the peak pyramid is being computed; retry")));
            }
            const auto failed = jobs.failure(job->second);
            peaksJobs.erase(job);
            if (failed) {
                return cors(jsonResponse(500, httpError(failed->first, failed->second)));
            }
            // Done since the cache was read above.
            if (auto bytes = cachedPeaks(file)) {
                return served(std::move(*bytes));
            }
        }
        peaksJobs.emplace(std::string(hex), jobs.startPeaks(detail::PeaksRequest{bundle, contentHash, format}));
        return cors(jsonResponse(202, httpError("peaks_pending", "the peak pyramid is being computed; retry")));
    }

    HttpResponse onHttp(const HttpRequest& request) {
        if (request.path == kMcpPath) {
            return waitMcp(request);
        }
        if (request.path.rfind(kPeaksPrefix, 0) == 0) {
            return onPeaks(request);
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
    bool submitMcp(std::string requestId, std::string method, Value params, detail::McpCaller caller,
                   std::function<void(const std::string&)> done) {
        Pending pending{0, std::move(requestId), currentSessionId(), std::move(method), std::move(params),
                        std::nullopt, std::move(done), options.mcpScope};
        pending.clientName = std::move(caller.name);
        pending.agentId = std::move(caller.agentId);
        pending.tool = std::move(caller.tool);
        return inbox.tryPush(std::move(pending));
    }

    void onOpen(ConnectionId connection, const std::string& path) {
        std::lock_guard lock(mutex);
        connections[connection] = Connection{false, path == kRealtimePath};
    }

    void onClose(ConnectionId connection) {
        std::lock_guard lock(mutex);
        const bool known = connections.erase(connection) != 0;
        events.unsubscribe(connection);
        realtime.remove(connection);
        readModel.forget(connection);
        // Its gestures end on the command thread, after its queued requests.
        if (known) {
            Pending closed;
            closed.connection = connection;
            closed.closed = true;
            if (!inbox.tryPush(std::move(closed))) {
                closedOverflow.push_back(connection);
            }
        }
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
            // m5b-engine-plan-metadata: {client: {name}} names the UI client in
            // the actor of its plans; a malformed client is ignored.
            const Value* client = parsed->find("client");
            std::string name = detail::sanitizeClientName(
                client != nullptr && client->kind() == Value::Kind::object ? client->find("name") : nullptr,
                detail::kDefaultUiName);
            // Runs under the connection lock, which also guards sessionId.
            const auto reply = [this](const StreamPosition& current) {
                return jcs::canonicalize(Value(Object{{"type", Value("auth")},
                                                      {"ok", Value(true)},
                                                      {"sessionId", Value(sessionId)},
                                                      {"revision", Value(current.revision)},
                                                      {"documentHash", Value(current.documentHash)},
                                                      {"seq", Value(std::to_string(current.seq))},
                                                      {"meters", current.meters},
                                                      {"pendingTakes", current.pendingTakes},
                                                      {"about", aboutJson()}}));
            };
            std::lock_guard lock(mutex);
            auto it = connections.find(connection);
            if (it == connections.end()) {
                return;
            }
            it->second.authenticated = true;
            it->second.clientName = std::move(name);
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
        Pending pending{connection, requestIdMember->asString(), served, method->asString(),
                        std::move(params), std::move(expectedRevision), {}, std::nullopt};
        pending.clientName = state.clientName;
        if (!inbox.tryPush(std::move(pending))) {
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

    RecordPort& requireRecordPort() const {
        if (options.recordPort == nullptr) {
            throw ProtocolError("not_supported", "this engine host does not record");
        }
        return *options.recordPort;
    }

    // record.recover_take {takeId, accept, trackId?}: the revision that committed
    // the take (on trackId when given), or the take in trash/; a repeat answers
    // the same.
    std::string recordRecoverTake(const Pending& request) {
        const std::string_view method = "record.recover_take";
        RecordPort& recordPort = requireRecordPort();
        const std::string& takeId = requireString(request.params, "takeId", method);
        const bool accept = requireBool(request.params, "accept", method);
        const std::optional<std::string> trackId = optionalString(request.params, "trackId", method);
        const RecoverResult result = recordPort.recoverTake(takeId, accept, trackId, options.actor, options.clock());
        refreshPendingTakes();
        if (accept) {
            if (result.revision == nullptr) {
                throw ProtocolError("internal_error", "the take was accepted without a revision");
            }
            return success(request.requestId, Value(Object{{"revision", revisionJson(*result.revision)}}));
        }
        return success(request.requestId, Value(Object{{"takeId", Value(takeId)}, {"trashed", Value(true)}}));
    }

    // The pending takes the auth reply and session.sync list: the record
    // port's, or without one what the bundle holds. A take whose manifest cannot
    // be read leaves the list as it was.
    void refreshPendingTakes() {
        std::vector<PendingTake> takes;
        try {
            if (options.recordPort != nullptr) {
                takes = options.recordPort->pendingTakes();
            } else {
                for (const session::TakeManifest& manifest : session::pendingTakes(session->bundlePath())) {
                    PendingTake take;
                    take.takeId = manifest.takeId;
                    take.trackId = manifest.trackId;
                    take.channels = manifest.channels;
                    take.sampleRate = manifest.sampleRate;
                    if (manifest.startPosition) {
                        take.startFrame = *manifest.startPosition - manifest.recordOffset;
                    }
                    take.endedBy = manifest.endedBy;
                    take.overflows = manifest.overflows;
                    takes.push_back(std::move(take));
                }
            }
        } catch (const std::exception&) {
            return;
        }
        events.setPendingTakes(pendingTakesJson(takes));
    }

    // A revision the engine host committed itself (a recording's end) reaches
    // subscribers as session.changed, once.
    void publishHeadIfMoved() {
        const command::Revision& head = session->history().head();
        if (head.envelope.id != events.position().revision) {
            events.publishRevision(head);
            refreshMediaTable();
        }
    }

    // The record state as last published (nothing before the first look).
    std::optional<RecordState> publishedRecord_;

    // Command thread, after every request and once per pump: record.changed when
    // the port's record state differs from what was last published. A recording
    // that ended published its commit first, and the pending takes are read again.
    void syncRecordState() {
        if (options.recordPort == nullptr) {
            return;
        }
        RecordState now = options.recordPort->recordState();
        if (!publishedRecord_) {
            publishedRecord_ = std::move(now);
            return;
        }
        if (now == *publishedRecord_) {
            return;
        }
        const bool ended = publishedRecord_->recording && !now.recording;
        publishedRecord_ = now;
        if (ended) {
            publishHeadIfMoved();
            refreshPendingTakes();
        }
        events.publish("record.changed", recordStateJson(now));
    }

    // The propose-scope methods that end a running recording (and commit it).
    static bool endsRecording(const std::string& method) {
        return method == "transport.stop" || method == "transport.locate";
    }

    bool recordingNow() const { return options.recordPort != nullptr && options.recordPort->recordState().recording; }

    // The methods that can end a recording, and with it commit a revision.
    static bool touchesRecording(const std::string& method) {
        return method == "transport.stop" || method == "transport.record" || method == "record.arm" ||
               method == "record.recover_take" || method == "engine.select_device";
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
        Object out = engineStatusJson(requireTransport().status()).asObject();
        if (options.pluginPort != nullptr) {
            Array plugins;
            for (const PluginStatus& plugin : options.pluginPort->plugins()) {
                plugins.push_back(pluginStatusJson(plugin));
            }
            out.emplace_back("plugins", Value(std::move(plugins)));
        }
        // Protocol v0 item 29: the MCP sessions' agents.
        Array agentList;
        for (const detail::AgentView& agent : agents.snapshot()) {
            agentList.push_back(detail::agentJson(agent));
        }
        out.emplace_back("agents", Value(std::move(agentList)));
        return Value(std::move(out));
    }

    // plugin.instantiate (Jobs v0, plugins): a job that runs inside the request
    // on the command thread. Its completion command, plugin.insert, enters the
    // history after the state blob is durable.
    std::string pluginInstantiate(const Pending& request) {
        const std::string_view method = "plugin.instantiate";
        const std::string kind(method);
        PluginPort& plugins = requirePluginPort();
        PluginInstantiateRequest wanted;
        // Exactly one owner, a track or a bus (m5b-engine-buses-sends).
        const std::optional<std::string> trackId = optionalString(request.params, "trackId", method);
        const std::optional<std::string> busId = optionalString(request.params, "busId", method);
        if (trackId.has_value() == busId.has_value()) {
            throw ProtocolError("invalid_params", "plugin.instantiate takes exactly one of trackId or busId");
        }
        wanted.trackId = trackId.value_or("");
        wanted.busId = busId.value_or("");
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
        // Refused where it enters, before any plugin host is reached (Protocol v0 item 21).
        if (const auto refused = model::pluginPathRefusal(wanted.descriptor.path, session->bundlePath())) {
            throw ProtocolError("invalid_params", "plugin.instantiate: the path is refused (" + *refused +
                                                      "): plugins load from registered installs only");
        }
        wanted.stateBlob = optionalString(request.params, "stateBlob", method);
        if (wanted.stateBlob && !model::isStateBlobHash(*wanted.stateBlob)) {
            throw ProtocolError("invalid_params", "plugin.instantiate: stateBlob must be sha256:<64 lowercase hex>");
        }
        const model::Document& head = session->history().head().document;
        if (trackId && head.track(wanted.trackId) == nullptr) {
            throw command::CommandError("not_found", "no track with id " + wanted.trackId);
        }
        if (busId && head.bus(wanted.busId) == nullptr) {
            throw command::CommandError("not_found", "no bus with id " + wanted.busId);
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
        // The name the plugin reports is the plugin's text, not the agent's:
        // stripped of control and display-unsafe characters, never refused.
        PluginDescriptorInfo probed = loaded.descriptor;
        probed.name = model::withoutUnsafeCharacters(probed.name);
        const Value insert(Object{{"op", Value("plugin.insert")},
                                  {busId ? "busId" : "trackId", Value(busId ? wanted.busId : wanted.trackId)},
                                  {"index", Value(static_cast<double>(wanted.index))},
                                  {"slotId", Value(wanted.slotId)},
                                  {"descriptor", descriptorJson(probed)},
                                  {"stateBlob", blob ? Value(*blob) : Value(nullptr)}});
        model::PluginSlot slot;
        slot.id = wanted.slotId;
        slot.trackId = wanted.trackId;
        slot.busId = wanted.busId;
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

    // plugin.registry and plugin.approve (Protocol v0 item 21): which installs may
    // load. No document change; never MCP tools.
    static Value registryEntryJson(const PluginRegistryEntry& entry) {
        return Value(Object{{"format", Value(entry.format)},
                            {"path", Value(entry.path)},
                            {"uid", entry.uid ? Value(*entry.uid) : Value(nullptr)},
                            {"name", Value(entry.name)},
                            {"approved", Value(entry.approved)}});
    }

    std::string pluginRegistry(const Pending& request) {
        PluginPort& plugins = requirePluginPort();
        Array out;
        for (const PluginRegistryEntry& entry : plugins.registry()) {
            out.push_back(registryEntryJson(entry));
        }
        return success(request.requestId, Value(Object{{"plugins", Value(std::move(out))}}));
    }

    std::string pluginApprove(const Pending& request) {
        const std::string_view method = "plugin.approve";
        PluginPort& plugins = requirePluginPort();
        const std::string& format = requireString(request.params, "format", method);
        if (format != "clap" && format != "vst3" && format != "au" && format != "lv2") {
            throw ProtocolError("invalid_params", "plugin.approve: format must be clap, vst3, au or lv2");
        }
        const std::string& path = requireString(request.params, "path", method);
        const Value* approved = request.params.find("approved");
        if (approved == nullptr || approved->kind() != Value::Kind::boolean) {
            throw ProtocolError("invalid_params", "plugin.approve needs a boolean approved");
        }
        // Which plugin of a library holding several (follow-up of PR #70).
        const std::optional<std::string> uid = optionalString(request.params, "uid", method);
        if (uid && uid->empty()) {
            throw ProtocolError("invalid_params", "plugin.approve: uid must not be empty");
        }
        return success(request.requestId, registryEntryJson(plugins.approve(format, path, approved->asBool(), uid)));
    }

    // ---- fader gestures (Protocol v0 item 24, docs/schemas/protocol-gestures-v0.md) ----

    std::chrono::steady_clock::time_point steadyNow() const {
        return options.steadyClock ? options.steadyClock() : std::chrono::steady_clock::now();
    }

    GesturePort& requireGesturePort() const {
        if (options.gesturePort == nullptr) {
            throw ProtocolError("not_supported", "this engine host has no fader gestures");
        }
        return *options.gesturePort;
    }

    // The gesture `request`'s connection holds on `target`, renewed.
    Lease& ownedLease(const Pending& request, const GestureTarget& target) {
        auto it = leases.find(leaseKey(target));
        if (it == leases.end()) {
            throw ProtocolError("no_gesture", "no gesture is open on " + target.ref() + " " + target.param);
        }
        if (it->second.owner != request.connection) {
            throw ProtocolError("gesture_held", "another connection holds a gesture on " + target.ref());
        }
        it->second.renewed = steadyNow();
        return it->second;
    }

    // A revision a gesture committed, on main or on the heard proposal branch.
    void publishCommit(const command::Revision& revision) {
        if (revision.branch) {
            events.publishBranchRevision(revision);
            if (options.auditionPort != nullptr) {
                options.auditionPort->branchCommitted(*revision.branch);
            }
            return;
        }
        events.publishRevision(revision);
        if (options.auditionPort != nullptr) {
            options.auditionPort->mainCommitted();
        }
    }

    void publishEnded(const GestureTarget& target, std::string_view reason, double startValue, double value,
                      const command::Revision* committed) {
        events.publish("gesture.ended",
                       Object{{"target", targetJson(target)},
                              {"reason", Value(std::string(reason))},
                              {"startValue", Value(startValue)},
                              {"value", Value(value)},
                              {"committed", committed != nullptr ? Value(committed->envelope.id) : Value(nullptr)}});
    }

    // Ends a lease through the port, committing its last value. A commit that
    // throws closes it as cancelled, and the exception propagates.
    GestureEnd closeLease(const std::string& key, std::string_view reason) {
        const Lease lease = leases.at(key);
        leases.erase(key);
        GestureEnd end;
        try {
            end = requireGesturePort().end(lease.target, options.actor, options.clock());
        } catch (...) {
            publishEnded(lease.target, "cancelled", lease.startValue, lease.startValue, nullptr);
            throw;
        }
        if (end.revision != nullptr) {
            publishCommit(*end.revision);
        }
        publishEnded(lease.target, reason, end.startValue, end.value, end.revision);
        return end;
    }

    // The lease's end without a requester: failures were published as cancelled.
    void closeQuietly(const std::string& key, std::string_view reason) {
        try {
            closeLease(key, reason);
        } catch (...) {
        }
    }

    // Command thread: leases not renewed for gestureLeaseMs.
    void expireLeases() {
        if (leases.empty()) {
            return;
        }
        const auto now = steadyNow();
        std::vector<std::string> expired;
        for (const auto& [key, lease] : leases) {
            if (now - lease.renewed >= options.gestureLeaseMs) {
                expired.push_back(key);
            }
        }
        for (const std::string& key : expired) {
            closeQuietly(key, "lease_expired");
        }
    }

    // Command thread: a connection closed; its gestures end at once.
    void endConnection(ConnectionId connection) {
        std::vector<std::string> owned;
        for (const auto& [key, lease] : leases) {
            if (lease.owner == connection) {
                owned.push_back(key);
            }
        }
        for (const std::string& key : owned) {
            closeQuietly(key, "disconnected");
        }
    }

    // session.open: the old session's gestures go with its engine, uncommitted.
    void dropLeases() {
        for (const auto& [key, lease] : leases) {
            (void)key;
            publishEnded(lease.target, "cancelled", lease.startValue, lease.startValue, nullptr);
        }
        leases.clear();
    }

    std::string gestureBegin(const Pending& request) {
        const std::string_view method = "gesture.begin";
        GesturePort& gestures = requireGesturePort();
        const GestureTarget target = requireTarget(request.params, method);
        auto it = leases.find(leaseKey(target));
        if (it != leases.end()) {
            if (it->second.owner == request.connection) {
                throw ProtocolError("gesture_open", "this connection already holds a gesture on " + target.ref());
            }
            throw ProtocolError("gesture_held", "another connection holds a gesture on " + target.ref());
        }
        const double startValue = gestures.begin(target);
        leases.emplace(leaseKey(target), Lease{request.connection, target, startValue, steadyNow()});
        return success(request.requestId,
                       Value(Object{{"target", targetJson(target)},
                                    {"startValue", Value(startValue)},
                                    {"leaseMs", Value(static_cast<double>(options.gestureLeaseMs.count()))}}));
    }

    std::string gestureUpdate(const Pending& request) {
        const std::string_view method = "gesture.update";
        GesturePort& gestures = requireGesturePort();
        const GestureTarget target = requireTarget(request.params, method);
        const double value = *gestureValue(request.params, method, target, true);
        ownedLease(request, target);
        gestures.update(target, value);
        return success(request.requestId, Value(Object{}));
    }

    std::string gestureHold(const Pending& request) {
        requireGesturePort();
        ownedLease(request, requireTarget(request.params, "gesture.hold"));
        return success(request.requestId, Value(Object{}));
    }

    std::string gestureEnd(const Pending& request) {
        const std::string_view method = "gesture.end";
        GesturePort& gestures = requireGesturePort();
        const GestureTarget target = requireTarget(request.params, method);
        const std::optional<double> value = gestureValue(request.params, method, target, false);
        ownedLease(request, target);
        if (value) {
            gestures.update(target, *value);
        }
        const GestureEnd end = closeLease(leaseKey(target), "ended");
        return success(request.requestId,
                       Value(Object{{"target", targetJson(target)},
                                    {"startValue", Value(end.startValue)},
                                    {"value", Value(end.value)},
                                    {"revision", end.revision != nullptr ? revisionJson(*end.revision) : Value(nullptr)}}));
    }

    std::string gestureCancel(const Pending& request) {
        GesturePort& gestures = requireGesturePort();
        const GestureTarget target = requireTarget(request.params, "gesture.cancel");
        const Lease lease = ownedLease(request, target);
        leases.erase(leaseKey(target));
        gestures.cancel(target);
        publishEnded(target, "cancelled", lease.startValue, lease.startValue, nullptr);
        return success(request.requestId, Value(Object{}));
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
                                      {"plugins", pluginsFeatureJson()},
                                      {"gestures", Value(options.gesturePort != nullptr)},
                                      {"peaks", Value(true)},
                                      {"locators", Value(true)},
                                      {"cycle", Value(options.transportPort != nullptr)},
                                      {"click", Value(options.transportPort != nullptr)},
                                      {"recording", Value(options.recordPort != nullptr)},
                                      // Protocol v0 item 34: with features.recording.
                                      {"punch", Value(options.recordPort != nullptr)},
                                      {"preroll", Value(options.recordPort != nullptr)},
                                      {"countIn", Value(options.recordPort != nullptr)},
                                      {"monitoring", Value(options.recordPort != nullptr &&
                                                           options.recordPort->monitoringAvailable())},
                                      {"masterGain", Value(true)},
                                      {"buses", Value(true)},
                                      {"sends", Value(true)},
                                      {"clipFades", Value(true)},
                                      {"markers", Value(true)},
                                      {"mediaImport", Value(Object{{"formats", Value(Array{Value("wav"), Value("flac")})}})},
                                      {"planMetadata", Value(true)},
                                      {"agents", Value(options.transportPort != nullptr)},
                                      // Protocol v0 item 31: engine.status load, the SLUD frame and its reset.
                                      {"load", Value(options.transportPort != nullptr)},
                                      {"loudness", Value(options.transportPort != nullptr)},
                                      {"agentRequests", Value(options.transportPort != nullptr)}})},
            {"limits", Value(Object{{"syncChunkEntities", Value(static_cast<double>(options.syncChunkEntities))},
                                    {"inboxCapacity", Value(static_cast<double>(options.inboxCapacity))},
                                    {"idempotencyCapacity", Value(static_cast<double>(options.idempotencyCapacity))},
                                    {"agentIdleMs", Value(static_cast<double>(options.agentIdleMs.count()))},
                                    {"agentsRetained", Value(static_cast<double>(options.agentsRetained))},
                                    {"agentRequestsPerAgent", Value(static_cast<double>(agentRequests.perAgent()))},
                                    {"agentRequestTextChars", Value(static_cast<double>(detail::kRequestTextMaxChars))},
                                    {"agentRequestWaitMs", Value(static_cast<double>(requestWaitLimit().count()))},
                                    {"agentRequestsClosedRetained",
                                     Value(static_cast<double>(detail::kRequestsClosedRetained))}})},
        });
    }

    std::string planSubmit(const Pending& request) {
        const std::string_view method = "plan.submit";
        for (const auto& member : request.params.asObject()) {
            if (std::find(std::begin(kPlanSubmitParams), std::end(kPlanSubmitParams), member.first) ==
                std::end(kPlanSubmitParams)) {
                throw ProtocolError("invalid_params",
                                    member.first == "actor"
                                        ? std::string("plan.submit: the actor is set by the engine, not the request")
                                        : "plan.submit: unknown param " + member.first);
            }
        }
        command::PlanMetadata metadata;
        metadata.title = planMetadataString(request.params, "title");
        metadata.intent = planMetadataString(request.params, "intent");
        command::checkPlanMetadata(metadata);
        // The credential's kind (Pending::scope is set for the MCP token only) and
        // the client's name; never read from the params.
        const bool fromMcp = request.scope.has_value();
        metadata.actor = command::PlanActor{
            fromMcp ? command::PlanActorKind::mcp : command::PlanActorKind::ui,
            !request.clientName.empty()
                ? request.clientName
                : std::string(fromMcp ? detail::kDefaultMcpName : detail::kDefaultUiName)};
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
        // Protocol v0 item 32: the request this plan answers, checked before
        // anything is stored. Only its addressee links a plan to it.
        std::optional<std::string> linked;
        if (const Value* given = request.params.find("request")) {
            if (given->kind() != Value::Kind::string) {
                throw ProtocolError("invalid_params", "plan.submit: request must be a request id");
            }
            if (!fromMcp) {
                throw ProtocolError("invalid_params", "plan.submit: only the agent a request is addressed to answers it");
            }
            const detail::AgentRequest* found = agentRequests.find(given->asString());
            if (found == nullptr) {
                throw ProtocolError("not_found", "no request " + given->asString());
            }
            if (!found->open() || found->agentId != request.agentId) {
                throw ProtocolError("request_not_open", "request " + given->asString() + " is not open for this agent");
            }
            linked = given->asString();
        }
        const std::size_t plansBefore = session->plans().size();
        const command::Plan& plan = session->submitPlan(std::move(steps), std::move(readSet), base, std::move(metadata));
        if (fromMcp && !request.agentId.empty()) {
            planSubmitters_.emplace(*plan.hashText, request.agentId);
            // The plan's actor is fixed by its first submission: an identical
            // resubmission by another agent returns the stored plan and does not
            // make that agent its actor.
            if (session->plans().size() > plansBefore) {
                planActors_.emplace(*plan.hashText, request.agentId);
            }
        }
        if (linked) {
            requestChanged(agentRequests.close(*linked, detail::RequestState::answered, *plan.hashText));
        }
        return success(request.requestId, plan.toJson());
    }

    // Protocol v0 item 32, agent requests. Command thread.

    // A parked agent.next_request and when its wait ends (on steadyClock).
    struct Waiter {
        Pending request;
        std::chrono::steady_clock::time_point deadline{};
    };
    std::map<std::string, Waiter, std::less<>> waiters_;  // by agent id: one per agent
    // (plan hash, agent id) for every plan an agent submitted in this session:
    // the plans agent.answer_request accepts from it.
    std::set<std::pair<std::string, std::string>> planSubmitters_;
    // Plan actors (security fix after m5b-protocol-parity; protocol-mcp-v0.md,
    // "Trust model"): plan hash -> the agent id whose submission stored it, and
    // proposal branch -> the agent id that proposed it. A propose-scoped MCP
    // caller rejects only the plans it is the actor of and discards only the
    // proposals of its plans or the ones it proposed (not_plan_actor otherwise).
    std::map<std::string, std::string, std::less<>> planActors_;
    std::map<command::BranchId, std::string, std::less<>> branchProposers_;

    static bool proposeScoped(const Pending& request) {
        return request.scope.has_value() && *request.scope == McpScope::propose;
    }

    bool actsFor(const Pending& request, const std::string& planHash) const {
        const auto it = planActors_.find(planHash);
        return !request.agentId.empty() && it != planActors_.end() && it->second == request.agentId;
    }

    void requirePlanActor(const Pending& request, const std::string& planHash, std::string_view method) const {
        if (proposeScoped(request) && !actsFor(request, planHash)) {
            throw ProtocolError("not_plan_actor", std::string(method) + ": plan " + planHash +
                                                      " was submitted by another client");
        }
    }

    void requireProposalActor(const Pending& request, const command::BranchId& branch,
                              std::string_view method) const {
        if (!proposeScoped(request)) {
            return;
        }
        const auto proposer = branchProposers_.find(branch);
        if (!request.agentId.empty() && proposer != branchProposers_.end() && proposer->second == request.agentId) {
            return;
        }
        if (const std::optional<std::string> plan = session->plans().proposedPlan(branch);
            plan && actsFor(request, *plan)) {
            return;
        }
        throw ProtocolError("not_plan_actor", std::string(method) + ": branch " + branch +
                                                  " was neither proposed by this agent nor made of its plan");
    }
    // The request states changed since the last publishRequestChanges().
    std::vector<detail::AgentRequest> requestChanges_;

    // ServerOptions::agentRequestWaitMs, clamped to at most mcpRequestTimeout
    // minus 1 s and at least 0, so a parked call is answered before the
    // transport answers request_timeout (item 15).
    std::chrono::milliseconds requestWaitLimit() const {
        using std::chrono::milliseconds;
        const milliseconds ceiling = std::max(options.mcpRequestTimeout - milliseconds(1'000), milliseconds(0));
        return std::max(std::min(options.agentRequestWaitMs, ceiling), milliseconds(0));
    }

    void requestChanged(detail::AgentRequest request) { requestChanges_.push_back(std::move(request)); }

    // agent.request_changed for each change, in order; after the request's
    // plan.changed and before the pump's agent.changed.
    void publishRequestChanges() {
        for (const detail::AgentRequest& request : requestChanges_) {
            events.publish("agent.request_changed", Object{{"request", detail::requestJson(request)}});
        }
        requestChanges_.clear();
    }

    bool agentConnected(const std::string& agentId) const {
        for (const detail::AgentView& agent : agents.snapshot()) {
            if (agent.id == agentId) {
                return agent.connected;
            }
        }
        return false;
    }

    // The context the engine stamps on a request: the UI's selection, and the
    // engine state the client cannot forge.
    Value requestContext(Value selection) const {
        const command::Revision& head = session->history().head();
        std::optional<Value> locators =
            entityJson(head.document, model::EntityRef{model::EntityType::locators, std::string(model::kLocatorsId)});
        return Value(Object{{"selection", std::move(selection)},
                            {"locators", locators ? std::move(*locators) : Value(nullptr)},
                            {"cursor", options.transportPort != nullptr
                                           ? decimal(options.transportPort->status().position)
                                           : Value(nullptr)},
                            {"headRevision", Value(head.envelope.id)}});
    }

    static Value requestResult(const detail::AgentRequest& request) {
        return Value(Object{{"request", detail::requestJson(request)}});
    }

    // agent.request {agentId, text, selection?} (the UI credential).
    std::string agentRequest(const Pending& request) {
        const std::string_view method = "agent.request";
        onlyParams(request.params, {"agentId", "text", "selection"}, method);
        const std::string& agentId = requireString(request.params, "agentId", method);
        const std::string& text = requireString(request.params, "text", method);
        Value selection = selectionJson(request.params, method);
        detail::checkRequestText(text, "agent.request: text");
        if (!agentConnected(agentId)) {
            throw ProtocolError("agent_not_connected", "no connected agent " + agentId);
        }
        const detail::AgentRequest queued =
            agentRequests.queue(agentId, text, requestContext(std::move(selection)), options.clock());
        requestChanged(queued);
        return success(request.requestId, requestResult(queued));
    }

    // agent.cancel_request {request} (the UI credential).
    std::string agentCancelRequest(const Pending& request) {
        const std::string_view method = "agent.cancel_request";
        onlyParams(request.params, {"request"}, method);
        const std::string& id = requireString(request.params, "request", method);
        const detail::AgentRequest* found = agentRequests.find(id);
        if (found == nullptr) {
            throw ProtocolError("not_found", "no request " + id);
        }
        if (!found->open()) {
            throw ProtocolError("request_not_open", "request " + id + " is closed");
        }
        detail::AgentRequest closed = agentRequests.close(id, detail::RequestState::cancelled);
        requestChanged(closed);
        return success(request.requestId, requestResult(closed));
    }

    // agent.requests {} (the UI credential).
    std::string agentRequestList(const Pending& request) const {
        onlyParams(request.params, {}, "agent.requests");
        Array out;
        for (const detail::AgentRequest& entry : agentRequests.list()) {
            out.push_back(detail::requestJson(entry));
        }
        return success(request.requestId, Value(Object{{"requests", Value(std::move(out))}}));
    }

    // agent.answer_request {request, plan} | {request, message} | {request,
    // decline: true, message?} (the MCP credential).
    std::string agentAnswerRequest(const Pending& request) {
        const std::string_view method = "agent.answer_request";
        onlyParams(request.params, {"request", "plan", "message", "decline"}, method);
        const std::string& id = requireString(request.params, "request", method);
        const Value* plan = request.params.find("plan");
        const Value* message = request.params.find("message");
        const Value* decline = request.params.find("decline");
        if (decline != nullptr && (decline->kind() != Value::Kind::boolean || !decline->asBool())) {
            throw ProtocolError("invalid_params", "agent.answer_request: decline must be true");
        }
        const int forms = (plan != nullptr ? 1 : 0) + (decline != nullptr ? 1 : 0) +
                          (message != nullptr && decline == nullptr ? 1 : 0);
        if (forms != 1) {
            throw ProtocolError("invalid_params",
                                "agent.answer_request takes exactly one of plan, message or decline (with a message)");
        }
        if ((plan != nullptr && plan->kind() != Value::Kind::string) ||
            (message != nullptr && message->kind() != Value::Kind::string)) {
            throw ProtocolError("invalid_params", "agent.answer_request: plan and message are strings");
        }
        std::optional<std::string> text;
        if (message != nullptr) {
            detail::checkRequestText(message->asString(), "agent.answer_request: message");
            text = message->asString();
        }
        const detail::AgentRequest* found = agentRequests.find(id);
        if (found == nullptr) {
            throw ProtocolError("not_found", "no request " + id);
        }
        if (!found->open() || found->agentId != request.agentId) {
            throw ProtocolError("request_not_open", "request " + id + " is not open for this agent");
        }
        detail::AgentRequest closed;
        if (plan != nullptr) {
            const std::string& hashText = plan->asString();
            requirePlan(hashText);
            if (planSubmitters_.count({hashText, request.agentId}) == 0) {
                throw ProtocolError("invalid_params", "agent.answer_request: plan " + hashText +
                                                          " was not submitted by this agent");
            }
            closed = agentRequests.close(id, detail::RequestState::answered, hashText);
        } else {
            closed = agentRequests.close(id, decline != nullptr ? detail::RequestState::declined
                                                                : detail::RequestState::answered,
                                         std::nullopt, std::move(text));
        }
        requestChanged(closed);
        return success(request.requestId, requestResult(closed));
    }

    static std::string emptyNext(const Pending& request) {
        return success(request.requestId, Value(Object{{"request", Value(nullptr)}}));
    }

    // A delivering next_request: an action of the agent, and cached under its id.
    void answerTaken(const Pending& request, const detail::AgentRequest& taken) {
        std::string response = success(request.requestId, requestResult(taken));
        requestChanged(taken);
        agents.acted(request.agentId, request.tool, options.clock());
        remember(request.requestId, response);
        deliver(request, response);
    }

    // Answers the agent's parked call with {request: null}, never cached.
    void releaseWaiter(const std::string& agentId) {
        const auto it = waiters_.find(agentId);
        if (it == waiters_.end()) {
            return;
        }
        const Pending held = std::move(it->second.request);
        waiters_.erase(it);
        deliver(held, emptyNext(held));
    }

    void releaseAllWaiters() {
        while (!waiters_.empty()) {
            releaseWaiter(waiters_.begin()->first);
        }
    }

    // agent.next_request {waitMs?} (the MCP credential): delivered at once,
    // empty at once (waitMs 0), or parked until serveWaiters() answers it.
    void nextRequest(const Pending& request) {
        const std::string_view method = "agent.next_request";
        std::chrono::milliseconds wait = requestWaitLimit();
        try {
            onlyParams(request.params, {"waitMs"}, method);
            if (const Value* given = request.params.find("waitMs")) {
                const bool integer = given->kind() == Value::Kind::number && given->asNumber() >= 0 &&
                                     given->asNumber() <= 1e9 && std::floor(given->asNumber()) == given->asNumber();
                if (!integer) {
                    throw ProtocolError("invalid_params", "agent.next_request: waitMs is a non-negative integer");
                }
                wait = std::min(wait, std::chrono::milliseconds(static_cast<std::int64_t>(given->asNumber())));
            }
        } catch (const ProtocolError& e) {
            const std::string response = failure(Value(request.requestId), e.code(), e.what());
            remember(request.requestId, response);
            deliver(request, response);
            return;
        }
        releaseWaiter(request.agentId);
        if (std::optional<detail::AgentRequest> taken = agentRequests.take(request.agentId)) {
            answerTaken(request, *taken);
            publishRequestChanges();
            return;
        }
        if (wait.count() == 0) {
            deliver(request, emptyNext(request));
            return;
        }
        waiters_.insert_or_assign(request.agentId, Waiter{request, steadyNow() + wait});
    }

    // After the requests: a parked call whose agent has a pending request now
    // gets it; one whose wait ended, or whose agent disconnected, gets null.
    void serveWaiters() {
        const auto now = steadyNow();
        for (auto it = waiters_.begin(); it != waiters_.end();) {
            if (std::optional<detail::AgentRequest> taken = agentRequests.take(it->first)) {
                const Pending held = std::move(it->second.request);
                it = waiters_.erase(it);
                answerTaken(held, *taken);
                continue;
            }
            if (now >= it->second.deadline || !agentConnected(it->first)) {
                const Pending held = std::move(it->second.request);
                it = waiters_.erase(it);
                deliver(held, emptyNext(held));
                continue;
            }
            ++it;
        }
    }

    // The open requests of an agent that disconnected (DELETE or idle) or was
    // forgotten expire; a later reconnect does not revive them.
    void expireRequestsOfGoneAgents() {
        const std::vector<detail::AgentView> snapshot = agents.snapshot();
        for (const std::string& agentId : agentRequests.agentsWithOpen()) {
            const auto it = std::find_if(snapshot.begin(), snapshot.end(),
                                         [&](const detail::AgentView& agent) { return agent.id == agentId; });
            if (it == snapshot.end() || !it->connected) {
                for (detail::AgentRequest& expired : agentRequests.expireAgent(agentId)) {
                    requestChanged(std::move(expired));
                }
            }
        }
    }

    // The stale entities of a stored plan at the head, as plan.status reports them.
    Value staleJson(const std::string& planHash) const {
        Array stale;
        for (const command::StaleEntity& entity : session->plans().validate(session->history(), planHash)) {
            stale.push_back(Value(Object{{"ref", Value(formatRef(entity.entity))},
                                         {"change", Value(std::string(changeName(entity.change)))}}));
        }
        return Value(std::move(stale));
    }

    // A stored plan as plan.status and plan.list answer it.
    Value planStatusJson(const command::Plan& plan) const {
        const std::string& planHash = *plan.hashText;
        Object out = plan.toJson().asObject();
        out.emplace_back("stale", staleJson(planHash));
        if (const auto branch = session->plans().proposalBranch(planHash)) {
            out.emplace_back("proposalBranch", Value(*branch));
        }
        return Value(std::move(out));
    }

    std::string planStatus(const Pending& request) {
        const std::string& planHash = requireString(request.params, "plan", "plan.status");
        return success(request.requestId, planStatusJson(requirePlan(planHash)));
    }

    // Protocol v0 item 25: every plan in submission order.
    std::string planList(const Pending& request) const {
        Array plans;
        for (const command::Plan* plan : session->plans().list()) {
            plans.push_back(planStatusJson(*plan));
        }
        return success(request.requestId, Value(Object{{"plans", Value(std::move(plans))}}));
    }

    // Protocol v0 item 25: what plan.apply would produce now, never committed.
    // A failing step throws its CommandError (with the step index).
    std::string planPreview(const Pending& request) const {
        const std::string& planHash = requireString(request.params, "plan", "plan.preview");
        const command::Plan& plan = requirePlan(planHash);
        const command::Revision& head = session->history().head();
        const command::Prepared prepared = command::prepareTransaction(head.document, plan.steps);
        std::vector<model::EntityRef> refs;
        for (const command::EntitySnapshot& entry : plan.writeSet) {
            refs.push_back(entry.ref);
        }
        for (const model::DiffEntry& entry : model::diff(head.document, prepared.result)) {
            refs.push_back(entry.entity);
        }
        // (type name, id) as byte strings, like the plan's entity sets.
        const auto byName = [](const model::EntityRef& a, const model::EntityRef& b) {
            const std::string_view ta = model::entityTypeName(a.type);
            const std::string_view tb = model::entityTypeName(b.type);
            return ta != tb ? ta < tb : a.id < b.id;
        };
        std::sort(refs.begin(), refs.end(), byName);
        refs.erase(std::unique(refs.begin(), refs.end()), refs.end());
        Array entities;
        for (const model::EntityRef& ref : refs) {
            std::optional<Value> before = entityJson(head.document, ref);
            std::optional<Value> after = entityJson(prepared.result, ref);
            entities.push_back(Value(Object{{"ref", Value(formatRef(ref))},
                                            {"before", before ? std::move(*before) : Value(nullptr)},
                                            {"after", after ? std::move(*after) : Value(nullptr)}}));
        }
        return success(request.requestId,
                       Value(Object{{"revision", Value(head.envelope.id)},
                                    {"documentHash", Value(hash::formatHash(head.envelope.documentHash))},
                                    {"stale", staleJson(planHash)},
                                    {"entities", Value(std::move(entities))}}));
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
        const command::Plan& sub = session->approvePlanPartial(planHash, indexes, options.actor, options.clock());
        // The sub-plan carries the parent's actor (Plans, metadata), so its agent stays its actor here too.
        if (const auto parent = planActors_.find(planHash); parent != planActors_.end()) {
            planActors_.emplace(*sub.hashText, std::string(parent->second));
        }
        return success(request.requestId, sub.toJson());
    }

    std::string planPropose(const Pending& request) {
        const std::string& planHash = requireString(request.params, "plan", "plan.propose");
        const command::BranchId branch = session->proposePlan(planHash, options.actor, options.clock());
        // A branch id an earlier proposal used is the new proposal's.
        branchProposers_.erase(branch);
        if (request.scope.has_value() && !request.agentId.empty()) {
            branchProposers_.emplace(branch, request.agentId);
        }
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
        requireProposalActor(request, branch, "proposal.discard");
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
        return serveNew(request, options.openSession(path));
    }

    // session.create (Protocol v0 item 27).
    std::string sessionCreate(const Pending& request) {
        const std::string_view method = "session.create";
        const std::string& pathText = requireString(request.params, "path", method);
        const std::optional<std::string> given = optionalString(request.params, "name", method);
        if (!options.createSession) {
            throw ProtocolError("not_supported", "this engine host cannot create a session");
        }
        const std::filesystem::path path = localAbsolutePath(pathText, method);
        if (given && given->empty()) {
            throw ProtocolError("invalid_params", "session.create: name must not be empty");
        }
        // A name given is refused when it holds a control or display-unsafe
        // character, as session.rename's (spec "siann-model", names); one taken
        // from the folder is stripped of them instead.
        if (given && !model::isDisplaySafeName(*given)) {
            throw ProtocolError("invalid_name",
                                "session.create: name must not hold control characters, bidi formatting "
                                "characters or line separators");
        }
        std::error_code ec;
        if (std::filesystem::exists(std::filesystem::symlink_status(path, ec))) {
            throw ProtocolError("already_exists", "something already exists at this path");
        }
        if (!std::filesystem::is_directory(path.parent_path(), ec)) {
            throw ProtocolError("not_found", "the parent directory of this path does not exist");
        }
        std::string rootName = given.value_or(model::withoutUnsafeCharacters(utf8(path.stem())));
        if (rootName.empty()) {
            rootName = "Untitled";
        }
        // The rate the output device runs at ("Sample rate and media").
        std::int64_t sampleRate = 48'000;
        if (options.transportPort != nullptr) {
            const EngineStatus status = options.transportPort->status();
            if (status.device && status.device->sampleRate > 0) {
                sampleRate = status.device->sampleRate;
            }
        }
        return serveNew(request, options.createSession(path, rootName, sampleRate));
    }

    // After session.open or session.create: serves `next` under a new sessionId
    // (Protocol v0 item 16). Imports into the old session are cancelled.
    std::string serveNew(const Pending& request, session::Session& next) {
        session = &next;
        dropLeases();
        jobs.cancelImports();
        importIds.clear();
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
        // Protocol v0 item 32: a request's context names the old session's
        // entities, so every open one expires; its plans are gone too.
        for (detail::AgentRequest& expired : agentRequests.expireAll()) {
            requestChanged(std::move(expired));
        }
        planSubmitters_.clear();
        planActors_.clear();
        branchProposers_.clear();
        return success(request.requestId,
                       Value(Object{{"sessionId", Value(nextId)},
                                    {"revision", Value(head.envelope.id)},
                                    {"documentHash", Value(hash::formatHash(head.envelope.documentHash))}}));
    }

    // media.import (Jobs v0, import): queues the job; the worker prepares it and
    // finishImports() commits it.
    std::string mediaImport(const Pending& request) {
        const std::string_view method = "media.import";
        const std::string& pathText = requireString(request.params, "path", method);
        const std::string& clientImportId = requireString(request.params, "clientImportId", method);
        if (clientImportId.empty() || clientImportId.size() > 128) {
            throw ProtocolError("invalid_params", "media.import: clientImportId must be 1 to 128 bytes");
        }
        const std::filesystem::path path = localAbsolutePath(pathText, method);
        const auto known = importIds.find(clientImportId);
        if (known != importIds.end()) {
            // The first job's answer; nothing new starts.
            const std::optional<Value> status = jobs.status(known->second);
            return success(request.requestId, Value(Object{{"jobId", Value(known->second)},
                                                           {"kind", Value("media.import")},
                                                           {"state", status ? *status->find("state") : Value("failed")}}));
        }
        detail::ImportRequest job;
        job.bundle = session->bundlePath();
        job.sessionRate = session->history().head().document.root().sampleRate;
        job.path = path;
        job.open = options.openImportSource;
        job.owner = session;
        std::string jobId = jobs.startImport(std::move(job));
        importIds.emplace(clientImportId, jobId);
        return success(request.requestId, Value(Object{{"jobId", Value(std::move(jobId))},
                                                       {"kind", Value("media.import")},
                                                       {"state", Value("queued")}}));
    }

    static Value importResult(const model::Media& entity, const std::string& revision, bool existing) {
        Object out{{"mediaId", Value(entity.id)},
                   {"revision", Value(revision)},
                   {"contentHash", Value(hash::formatHash(entity.contentHash))},
                   {"frames", Value(std::to_string(entity.frames))},
                   {"sampleRate", Value(static_cast<double>(entity.sampleRate))},
                   {"channels", Value(static_cast<double>(entity.channels))},
                   {"converted", Value(entity.originalHash.has_value())}};
        if (entity.name) {
            out.emplace_back("name", Value(*entity.name));
        }
        if (entity.originalHash) {
            out.emplace_back("originalHash", Value(hash::formatHash(*entity.originalHash)));
        }
        if (existing) {
            out.emplace_back("existing", Value(true));
        }
        return Value(std::move(out));
    }

    // Command thread: commits the imports the worker prepared. Content the head
    // already holds answers its media; nothing is committed then.
    void finishImports() {
        for (detail::FinishedImport& finished : jobs.takeFinishedImports()) {
            if (finished.owner != session) {
                session::discardImport(finished.prepared);
                jobs.failImport(finished.jobId, "cancelled", "the session changed before the import's commit");
                continue;
            }
            const command::Revision& head = session->history().head();
            const model::Media* known = nullptr;
            for (const model::Media* entity : head.document.allMedia()) {
                if (entity->contentHash == finished.prepared.contentHash) {
                    known = entity;
                    break;
                }
            }
            if (known != nullptr) {
                Value result = importResult(*known, head.envelope.id, true);
                if (!known->name && model::isValidMediaName(finished.prepared.name)) {
                    Object fields = result.asObject();
                    fields.emplace_back("name", Value(finished.prepared.name));
                    result = Value(std::move(fields));
                }
                jobs.completeImport(finished.jobId, std::move(result));
                continue;
            }
            try {
                // A pointer, not a reference: GCC's -Wdangling-reference.
                const command::Revision* committed = &session::commitImport(
                    *session, finished.prepared, nextMediaId(session->history()), options.actor, options.clock());
                const command::Revision& revision = *committed;
                events.publishRevision(revision);
                if (options.auditionPort != nullptr) {
                    options.auditionPort->mainCommitted();
                }
                const model::Media* added = nullptr;
                for (const model::Media* entity : revision.document.allMedia()) {
                    if (entity->contentHash == finished.prepared.contentHash) {
                        added = entity;
                    }
                }
                jobs.completeImport(finished.jobId, importResult(*added, revision.envelope.id, false));
            } catch (const command::CommandError& e) {
                session::discardImport(finished.prepared);
                jobs.failImport(finished.jobId, e.code(), e.what());
            } catch (const session::SessionError& e) {
                session::discardImport(finished.prepared);
                jobs.failImport(finished.jobId, e.code(), e.what());
            } catch (const std::exception& e) {
                session::discardImport(finished.prepared);
                jobs.failImport(finished.jobId, "internal_error", e.what());
            }
        }
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
            return success(request.requestId,
                           Value(Object{{"commands", commandNamesJson()}, {"cascades", commandCascadesJson()}}));
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
        if (method == "plan.list") {
            return planList(request);
        }
        if (method == "plan.preview") {
            return planPreview(request);
        }
        if (method == "plan.approve") {
            return planApprove(request);
        }
        if (method == "plan.reject") {
            const std::string& planHash = requireString(request.params, "plan", method);
            const std::string note = optionalString(request.params, "note", method).value_or("");
            requirePlan(planHash);
            requirePlanActor(request, planHash, method);
            return success(request.requestId,
                           session->rejectPlan(planHash, options.actor, options.clock(), note).toJson());
        }
        if (method == "plan.apply") {
            return published(request, session->applyPlan(requireString(request.params, "plan", method), options.actor,
                                                         options.clock()));
        }
        if (method == "plan.rollback") {
            // {plan} or {revision}, exactly one (item 14; m5b-bridge-native-client).
            const bool byPlan = request.params.find("plan") != nullptr;
            if (byPlan == (request.params.find("revision") != nullptr)) {
                throw ProtocolError("invalid_params", "plan.rollback: give exactly one of plan and revision");
            }
            if (byPlan) {
                return published(request, session->rollbackPlan(requireString(request.params, "plan", method),
                                                                options.actor, options.clock()));
            }
            return published(request, session->rollbackRevision(requireString(request.params, "revision", method),
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
        if (method == "session.create") {
            return sessionCreate(request);
        }
        if (method == "media.import") {
            return mediaImport(request);
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
        if (method == "transport.set_cycle") {
            TransportPort& transportPort = requireTransport();
            const bool enabled = requireBool(request.params, "enabled", method);
            return success(request.requestId, transportStateJson(transportPort.setCycle(enabled)));
        }
        if (method == "transport.set_click") {
            TransportPort& transportPort = requireTransport();
            const bool enabled = requireBool(request.params, "enabled", method);
            const std::optional<std::int32_t> gain = optionalClickGain(request.params);
            return success(request.requestId, transportStateJson(transportPort.setClick(enabled, gain)));
        }
        if (method == "transport.set_punch") {
            TransportPort& transportPort = requireTransport();
            const bool punchIn = requireBool(request.params, "in", method);
            const bool punchOut = requireBool(request.params, "out", method);
            return success(request.requestId, transportStateJson(transportPort.setPunch(punchIn, punchOut)));
        }
        if (method == "transport.set_preroll" || method == "transport.set_count_in") {
            TransportPort& transportPort = requireTransport();
            const bool enabled = requireBool(request.params, "enabled", method);
            const std::optional<std::int32_t> bars = optionalBars(request.params, method);
            return success(request.requestId,
                           transportStateJson(method == "transport.set_preroll" ? transportPort.setPreroll(enabled, bars)
                                                                                : transportPort.setCountIn(enabled, bars)));
        }
        if (method == "engine.status") {
            return success(request.requestId, engineStatus());
        }
        if (method == "meter.reset_loudness") {
            // Protocol v0 item 31: engine state, no revision, no event, no device needed.
            requireTransport().resetLoudness();
            return success(request.requestId, Value(Object{}));
        }
        if (method == "engine.devices") {
            return success(request.requestId, devicesJson(requireTransport().devices()));
        }
        if (method == "engine.select_device") {
            TransportPort& transportPort = requireTransport();
            const std::string& id = requireString(request.params, "id", method);
            const std::optional<std::string> inputId = optionalString(request.params, "inputId", method);
            return success(request.requestId, deviceJson(inputId ? transportPort.selectDeviceWithInput(id, inputId)
                                                                 : transportPort.selectDevice(id)));
        }
        if (method == "record.arm") {
            RecordPort& recordPort = requireRecordPort();
            const std::string& trackId = requireString(request.params, "trackId", method);
            const bool armed = requireBool(request.params, "armed", method);
            return success(request.requestId, Value(recordStateJson(recordPort.arm(trackId, armed))));
        }
        if (method == "transport.record") {
            RecordPort& recordPort = requireRecordPort();
            const bool enabled = requireBool(request.params, "enabled", method);
            return success(request.requestId, transportStateJson(recordPort.record(enabled)));
        }
        if (method == "record.recover_take") {
            return recordRecoverTake(request);
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
        if (method == "plugin.registry") {
            return pluginRegistry(request);
        }
        if (method == "plugin.approve") {
            return pluginApprove(request);
        }
        if (method == "gesture.begin") {
            return gestureBegin(request);
        }
        if (method == "gesture.update") {
            return gestureUpdate(request);
        }
        if (method == "gesture.hold") {
            return gestureHold(request);
        }
        if (method == "gesture.end") {
            return gestureEnd(request);
        }
        if (method == "gesture.cancel") {
            return gestureCancel(request);
        }
        if (method == "agent.request") {
            return agentRequest(request);
        }
        if (method == "agent.cancel_request") {
            return agentCancelRequest(request);
        }
        if (method == "agent.requests") {
            return agentRequestList(request);
        }
        if (method == "agent.answer_request") {
            return agentAnswerRequest(request);
        }
        return failure(Value(request.requestId), "unknown_method", "unknown method " + request.method);
    }

    // Where a plan stands, to tell a lifecycle transition (plan.changed).
    struct PlanMark {
        std::string hash;
        command::PlanState state = command::PlanState::draft;
        std::optional<command::BranchId> proposalBranch;
    };

    std::vector<PlanMark> planMarks() const {
        std::vector<PlanMark> out;
        for (const command::Plan* plan : session->plans().list()) {
            out.push_back(PlanMark{*plan->hashText, plan->state, session->plans().proposalBranch(*plan->hashText)});
        }
        return out;
    }

    // Command thread: the served plans' marks as of PlanStore generation
    // marksGeneration_. Rebuilt only when the generation moved, so a request
    // that touches no plan (gesture.update, say) costs no O(plans) work.
    std::vector<PlanMark> marks_;
    std::uint64_t marksGeneration_ = 0;  // PlanStore never issues 0

    void refreshMarks() {
        const std::uint64_t generation = session->plans().generation();
        if (generation != marksGeneration_) {
            marks_ = planMarks();
            marksGeneration_ = generation;
        }
    }

    std::optional<command::BranchId> heardSide() const {
        return options.auditionPort != nullptr ? options.auditionPort->heard() : std::nullopt;
    }

    // Command thread, after a request (Protocol v0 item 25): plan.changed for
    // every plan whose state or proposal link the request changed, in
    // submission order (the store only appends, so the marks line up), and
    // audition.changed when the side heard changed. The marks are compared
    // only when the store's generation moved; marks_ hold the plans before
    // the request (execute refreshed them). A session.open serves other
    // plans; only the heard side is compared then.
    void publishLifecycle(const session::Session* servedBefore,
                          const std::optional<command::BranchId>& heardBefore) {
        if (session == servedBefore && session->plans().generation() != marksGeneration_) {
            std::vector<PlanMark> after = planMarks();
            const std::vector<PlanMark>& before = marks_;
            for (std::size_t i = 0; i < after.size(); ++i) {
                const PlanMark& mark = after[i];
                const bool changed = i >= before.size() || before[i].state != mark.state ||
                                     before[i].proposalBranch != mark.proposalBranch;
                if (!changed) {
                    continue;
                }
                Object payload{{"plan", Value(mark.hash)},
                               {"state", Value(std::string(command::planStateName(mark.state)))}};
                if (mark.proposalBranch) {
                    payload.emplace_back("proposalBranch", Value(*mark.proposalBranch));
                }
                // m5b-engine-plan-metadata: the stored plan's metadata and note.
                if (const command::Plan* plan = session->plans().find(mark.hash)) {
                    const Value stored = plan->toJson();
                    for (const char* key : {"title", "intent", "actor", "rejectionNote"}) {
                        if (const Value* field = stored.find(key)) {
                            payload.emplace_back(key, *field);
                        }
                    }
                }
                events.publish("plan.changed", std::move(payload));
            }
            marks_ = std::move(after);
            marksGeneration_ = session->plans().generation();
        }
        const std::optional<command::BranchId> heardAfter = heardSide();
        if (options.auditionPort != nullptr && heardAfter != heardBefore) {
            events.publish("audition.changed", Object{{"heard", Value(heardAfter.value_or("main"))}});
        }
    }

    // The cycle flag, the click (Protocol v0 item 26) and the punch, pre-roll and
    // count-in (item 34), for transport.changed.
    struct TransportFlags {
        bool cycle = false;
        ClickState click;
        PunchState punch;
        BarsState preroll;
        BarsState countIn;
        friend bool operator==(const TransportFlags&, const TransportFlags&) = default;
    };

    std::optional<TransportFlags> transportFlags() const {
        if (options.transportPort == nullptr) {
            return std::nullopt;
        }
        const EngineStatus status = options.transportPort->status();
        return TransportFlags{status.cycle, status.click, status.punch, status.preroll, status.countIn};
    }

    // The methods that can change the flags: the setters, and session.open (the
    // engine takes the opened bundle's cycle and punch flags).
    static bool touchesTransportFlags(const std::string& method) {
        return method == "transport.set_cycle" || method == "transport.set_click" ||
               method == "transport.set_punch" || method == "transport.set_preroll" ||
               method == "transport.set_count_in" || method == "session.open" || method == "session.create";
    }

    // Command thread: runs the request, then publishes the lifecycle events it caused.
    std::string execute(const Pending& request) {
        refreshMarks();
        const session::Session* servedBefore = session;
        const std::optional<command::BranchId> heardBefore = heardSide();
        const bool watchFlags = touchesTransportFlags(request.method);
        const std::optional<TransportFlags> flagsBefore = watchFlags ? transportFlags() : std::nullopt;
        std::string response = run(request);
        publishLifecycle(servedBefore, heardBefore);
        publishRequestChanges();
        if (touchesRecording(request.method) && session == servedBefore) {
            publishHeadIfMoved();
        }
        if (request.method == "session.open") {
            publishedRecord_.reset();  // the new session's state is no change to announce
            refreshPendingTakes();
        }
        syncRecordState();
        if (watchFlags) {
            const std::optional<TransportFlags> flagsAfter = transportFlags();
            if (flagsAfter && flagsAfter != flagsBefore) {
                events.publish("transport.changed", Object{{"cycle", Value(flagsAfter->cycle)},
                                                           {"click", clickJson(flagsAfter->click)},
                                                           {"punch", punchJson(flagsAfter->punch)},
                                                           {"preroll", barsJson(flagsAfter->preroll)},
                                                           {"countIn", barsJson(flagsAfter->countIn)}});
            }
        }
        return response;
    }

    // Command thread: every exception becomes one error response.
    std::string run(const Pending& request) {
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
        } catch (const GesturePortError& e) {
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
        const Value id(request.requestId);
        // Protocol v0 item 32 (Scopes v0, credential-bound methods), whatever
        // the scope: the agent's side is the MCP credential's, the user's side
        // the UI credential's.
        if (!request.scope) {
            if (mcpOnlyMethod(request.method)) {
                return failure(id, "scope_denied", request.method + " is an agent's: the MCP credential only");
            }
            return std::nullopt;
        }
        if (uiOnlyMethod(request.method)) {
            return failure(id, "scope_denied", request.method + " is the user's: the UI credential only");
        }
        if (*request.scope == McpScope::trusted) {
            return std::nullopt;
        }
        for (const detail::McpTool& tool : detail::mcpTools()) {
            if (tool.method == request.method) {
                // A propose credential cannot start a recording, so it cannot end
                // one either: stop and locate end a running recording and commit
                // it (m5b-engine-record), so while one runs they need trusted.
                if (tool.scope == McpScope::propose && endsRecording(request.method) && recordingNow()) {
                    return failure(id, "scope_denied",
                                   std::string(tool.name) + " ends the running recording and needs the trusted scope");
                }
                if (tool.scope == McpScope::propose) {
                    return std::nullopt;
                }
                return failure(id, "scope_denied", std::string(tool.name) + " needs the trusted scope");
            }
        }
        return failure(id, "scope_denied", "no MCP tool runs " + request.method);
    }

    // Command thread, under pumpMutex.
    // Command thread: the agents as last published (agent.changed), by id.
    std::map<std::string, detail::AgentView, std::less<>> agentMarks_;

    // agent.changed for every agent that connected, disconnected, reconnected
    // or acted since the last call (Protocol v0 item 29), in initialize order.
    void publishAgents() {
        std::map<std::string, detail::AgentView, std::less<>> next;
        for (detail::AgentView& agent : agents.snapshot()) {
            const auto before = agentMarks_.find(agent.id);
            if (before == agentMarks_.end() || !(before->second == agent)) {
                events.publish("agent.changed", Object{{"agent", detail::agentJson(agent)}});
            }
            std::string id = agent.id;
            next.emplace(std::move(id), std::move(agent));
        }
        agentMarks_ = std::move(next);
    }

    void handle(std::vector<Pending> requests) {
        expireLeases();
        // A parked next_request keeps its agent connected (Protocol v0 item 32).
        for (const auto& [agentId, waiter] : waiters_) {
            (void)waiter;
            agents.touch(agentId);
        }
        agents.expire(options.agentIdleMs);
        expireRequestsOfGoneAgents();
        for (const auto& request : requests) {
            if (request.closed) {
                endConnection(request.connection);
                continue;
            }
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
            const bool cached = !uncachedMethod(request.method);
            if (cached) {
                auto hit = cache.find(request.requestId);
                if (hit != cache.end()) {
                    deliver(request, hit->second);
                    continue;
                }
            }
            // The long poll answers itself, now or in a later pump; an empty
            // answer is neither cached nor an action (Protocol v0 item 32).
            if (request.method == "agent.next_request") {
                nextRequest(request);
                continue;
            }
            std::string response = execute(request);
            if (!request.agentId.empty()) {
                agents.acted(request.agentId, request.tool, options.clock());
            }
            if (cached) {
                remember(request.requestId, response);
            }
            deliver(request, response);
        }
        std::vector<ConnectionId> overflow;
        {
            std::lock_guard lock(mutex);
            overflow.swap(closedOverflow);
        }
        for (const ConnectionId connection : overflow) {
            endConnection(connection);
        }
        // What the engine host's tick changed since: a take's start, its durable
        // frames, an early end and its commit (m5b-engine-record).
        syncRecordState();
        finishImports();
        refreshMediaTable();
        // A DELETE that arrived during the pump, and the parked calls the
        // requests (or the clock) answered.
        expireRequestsOfGoneAgents();
        serveWaiters();
        publishRequestChanges();
        publishAgents();
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
    impl_->refreshMediaTable();
    impl_->refreshPendingTakes();
    impl_->syncRecordState();  // the state the first record.changed is compared with
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
    {
        // A parked next_request is answered empty, so no transport thread
        // waits on it while the transport stops.
        std::lock_guard lock(impl_->pumpMutex);
        impl_->releaseAllWaiters();
    }
    if (impl_->started) {
        // No transport thread is left waiting on an MCP answer after this.
        impl_->transport.stop();
        impl_->started = false;
    }
    // A running import is interrupted and ends cancelled before the worker joins.
    impl_->jobs.cancelImports();
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
    impl_->refreshMediaTable();
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

std::optional<json::Value> ProtocolServer::jobStatus(const std::string& jobId) const {
    return impl_->jobs.status(jobId);
}

const std::vector<std::string_view>& detail::protocolMethods() {
    return kMethods;
}

}  // namespace siann::protocol
