// plugin.instantiate, plugin.open_editor, plugin.close_editor, engine.status
// plugins[] and render.start's own instances (spec, Protocol v0 item 19;
// "Commands and jobs", Jobs v0, plugins; m4-plugin-node), on a fake PluginPort.
// The engine's real port is tested in apps/engine/tests.

#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/protocol/plugin_port.hpp"
#include "siann/protocol/transport_port.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::PluginEditorState;
using protocol::PluginInstantiateRequest;
using protocol::PluginInstantiateResult;
using protocol::PluginPort;
using protocol::PluginPortError;
using protocol::PluginRegistryEntry;
using protocol::PluginStatus;
using protocol::ServerOptions;

namespace {

class NullSource final : public engine::PluginNodeSource {
public:
    std::unique_ptr<graph::Node> pluginNode(const model::PluginSlot&, int) const override { return nullptr; }
};

class FakePluginPort final : public PluginPort {
public:
    PluginInstantiateResult instantiate(const PluginInstantiateRequest& request) override {
        ++instantiated;
        requests.push_back(request);
        if (refusal) {
            throw PluginPortError(*refusal, "the port refused");
        }
        PluginInstantiateResult result;
        result.descriptor = request.descriptor;
        result.descriptor.uid = "org.siann.test-plugin";
        result.descriptor.name = "SIANN Test Plugin";
        if (!request.stateBlob) {
            result.state = std::vector<std::uint8_t>{'S', 'T', 'A', 'T', 'E'};
        }
        result.latencyFrames = 64;
        result.tailFrames = 12'000;
        result.capabilities.variableLatency = true;
        result.capabilities.sampleAccurateParameters = true;
        return result;
    }
    void settle(const model::PluginSlot& slot, bool inserted) override {
        settled.emplace_back(slot.id, inserted);
        settledSlots.push_back(slot);
    }
    PluginEditorState openEditor(const std::string& slotId) override {
        if (editorRefusal) {
            throw PluginPortError(*editorRefusal, "no editor");
        }
        open = true;
        return {slotId, true, 4242};
    }
    PluginEditorState closeEditor(const std::string& slotId) override {
        if (editorRefusal) {
            throw PluginPortError(*editorRefusal, "no editor");
        }
        open = false;
        return {slotId, false, 0};
    }
    void setParameter(const std::string& slotId, const std::string& paramId, double value) override {
        ++parameterCalls;
        if (parameterRefusal) {
            throw PluginPortError(*parameterRefusal, "the port refused the parameter");
        }
        parameterSets.push_back({slotId, paramId, value});
    }
    std::vector<PluginStatus> plugins() const override { return reported; }
    std::vector<std::string> formats() const override { return {"clap"}; }
    std::shared_ptr<engine::PluginNodeSource> instantiateForRender(const model::Document& document) override {
        ++renderSets;
        renderSlots = document.allPluginSlots().size();
        return std::make_shared<NullSource>();
    }
    void destroyRenderInstances(std::shared_ptr<engine::PluginNodeSource> instances) override {
        if (instances) {
            ++destroyed;
        }
    }
    std::vector<PluginRegistryEntry> registry() const override { return installs; }
    PluginRegistryEntry approve(const std::string& format, const std::string& path, bool approved,
                                const std::optional<std::string>& uid) override {
        ++approveCalls;
        approvedUid = uid;
        if (approveRefusal) {
            throw PluginPortError(*approveRefusal, "the port refused the approval");
        }
        for (PluginRegistryEntry& entry : installs) {
            if (entry.format == format && entry.path == path) {
                entry.approved = approved;
                if (approved && !entry.uid) {
                    entry.uid = "org.siann.test-plugin";  // probed
                }
                return entry;
            }
        }
        throw PluginPortError("plugin_not_registered", "no install at " + path);
    }

    std::vector<PluginRegistryEntry> installs{
        {"clap", "/plugins/test.clap", std::nullopt, "test", false},
        {"clap", "/plugins/known.clap", std::string("org.example.known"), "Known", true},
    };
    int approveCalls = 0;
    std::optional<std::string> approveRefusal;
    std::optional<std::string> approvedUid;  // the last approve's
    int instantiated = 0;
    std::vector<PluginInstantiateRequest> requests;
    std::vector<std::pair<std::string, bool>> settled;
    std::vector<model::PluginSlot> settledSlots;
    std::optional<std::string> refusal;
    std::optional<std::string> editorRefusal;
    bool open = false;
    struct ParameterSet {
        std::string slotId;
        std::string paramId;
        double value = 0.0;
    };
    int parameterCalls = 0;
    std::vector<ParameterSet> parameterSets;
    std::optional<std::string> parameterRefusal;
    std::vector<PluginStatus> reported;
    int renderSets = 0;
    std::size_t renderSlots = 0;
    int destroyed = 0;
};

class StatusPort final : public protocol::TransportPort {
public:
    protocol::TransportState play() override { return {}; }
    protocol::TransportState stop() override { return {}; }
    protocol::TransportState locate(std::int64_t) override { return {}; }
    protocol::EngineStatus status() const override { return {}; }
    std::vector<protocol::DeviceDescription> devices() const override { return {}; }
    protocol::DeviceInfo selectDevice(const std::string&) override { return {}; }
};

ServerOptions withPort(PluginPort& port) {
    ServerOptions options = manualOptions();
    options.pluginPort = &port;
    options.jobs.workerThread = false;
    return options;
}

Value instantiateParams(const std::string& trackId, std::optional<std::string> stateBlob = std::nullopt) {
    Object params{{"trackId", Value(trackId)},
                  {"index", Value(0)},
                  {"descriptor", Value(Object{{"format", Value("clap")}, {"path", Value("/plugins/test.clap")}})}};
    if (stateBlob) {
        params.emplace_back("stateBlob", Value(*stateBlob));
    }
    return Value(std::move(params));
}

}  // namespace

TEST_CASE("plugin.instantiate writes the blob, commits plugin.insert and answers done", "[protocol][plugin]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed(true);
    f.commit(c, Array{trackAdd("trk_1")});

    const Value started = f.ok(c, "plugin.instantiate", instantiateParams("trk_1"));
    CHECK(at(started, "kind").asString() == "plugin.instantiate");
    CHECK(at(started, "state").asString() == "done");
    const std::string jobId = at(started, "jobId").asString();
    const Value& result = at(started, "result");
    const std::string slotId = at(result, "slotId").asString();
    CHECK(slotId == "slt_1");
    CHECK(at(result, "revision").asString() == f.head().envelope.id);
    CHECK(at(at(result, "descriptor"), "uid").asString() == "org.siann.test-plugin");
    CHECK(at(at(result, "descriptor"), "format").asString() == "clap");
    CHECK(at(at(result, "descriptor"), "path").asString() == "/plugins/test.clap");
    CHECK(at(result, "latencyFrames").asNumber() == 64);
    CHECK(at(result, "tailFrames").asNumber() == 12'000);
    const Value& capabilities = at(result, "capabilities");
    CHECK(at(capabilities, "variableLatency").asBool());
    CHECK(at(capabilities, "sampleAccurateParameters").asBool());
    CHECK_FALSE(at(capabilities, "editor").asBool());
    CHECK(capabilities.asObject().size() == 6);

    // The blob is durable before the command that names it.
    const std::string blob = at(result, "stateBlob").asString();
    CHECK(blob == hash::formatHash(hash::sha256(std::string("STATE"))));
    const auto file = f.session.bundlePath() / "blobs" / blob.substr(7);
    REQUIRE(std::filesystem::exists(file));
    CHECK(io::readFile(file) == "STATE");

    const model::PluginSlot* slot = f.head().document.pluginSlot(slotId);
    REQUIRE(slot != nullptr);
    CHECK(slot->stateBlob == std::optional<std::string>{blob});
    CHECK(slot->uid == "org.siann.test-plugin");
    CHECK(f.head().document.track("trk_1")->inserts == std::vector<std::string>{slotId});
    REQUIRE(port.settled.size() == 1);
    CHECK(port.settled[0] == std::make_pair(slotId, true));
    CHECK(port.settledSlots[0] == *slot);
    CHECK(port.requests[0].slotId == slotId);
    CHECK(port.requests[0].trackId == "trk_1");
    CHECK_FALSE(port.requests[0].stateBlob.has_value());

    // job.status answers the same.
    const Value status = f.ok(c, "job.status", Value(Object{{"jobId", Value(jobId)}}));
    CHECK(canonical(status) == canonical(started));

    // session.changed went out for the plugin.insert revision.
    bool changed = false;
    for (const Value& event : f.events(c)) {
        changed = changed || at(event, "type").asString() == "session.changed";
    }
    CHECK(changed);

    // A second plugin gets the next free slot id.
    const Value second = f.ok(c, "plugin.instantiate", instantiateParams("trk_1"));
    CHECK(at(at(second, "result"), "slotId").asString() == "slt_2");
    CHECK(f.head().document.track("trk_1")->inserts == std::vector<std::string>{"slt_2", slotId});
}

TEST_CASE("plugin.instantiate never hands out a slot id the history has used", "[protocol][plugin]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed(true);
    f.commit(c, Array{trackAdd("trk_1")});

    const Value first = f.ok(c, "plugin.instantiate", instantiateParams("trk_1"));
    CHECK(at(at(first, "result"), "slotId").asString() == "slt_1");
    // Removed: slt_1 is free in the head document but not new.
    f.commit(c, Array{Value(Object{{"op", Value("plugin.remove")}, {"slotId", Value("slt_1")}})});
    REQUIRE(f.head().document.pluginSlot("slt_1") == nullptr);
    const Value second = f.ok(c, "plugin.instantiate", instantiateParams("trk_1"));
    CHECK(at(at(second, "result"), "slotId").asString() == "slt_2");
    // Undone: slt_2 leaves the head document and stays used.
    f.ok(c, "session.undo");
    REQUIRE(f.head().document.pluginSlot("slt_2") == nullptr);
    const Value third = f.ok(c, "plugin.instantiate", instantiateParams("trk_1"));
    CHECK(at(at(third, "result"), "slotId").asString() == "slt_3");
}

TEST_CASE("plugin.instantiate uses a blob it was given and honours idempotency and expectedRevision",
          "[protocol][plugin]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1")});
    const std::string given = "sha256:" + std::string(64, 'b');
    const std::string request = f.request("req_same", "plugin.instantiate", instantiateParams("trk_1", given));
    f.transport.deliver(c, request);
    f.server.pump();
    f.transport.deliver(c, request);
    f.server.pump();
    CHECK(port.instantiated == 1);
    const auto frames = f.transport.sent(c);
    CHECK(frames[frames.size() - 1] == frames[frames.size() - 2]);
    REQUIRE(port.requests[0].stateBlob.has_value());
    CHECK(*port.requests[0].stateBlob == given);
    CHECK(f.head().document.pluginSlot("slt_1")->stateBlob == std::optional<std::string>{given});
    CHECK_FALSE(std::filesystem::exists(f.session.bundlePath() / "blobs" / std::string(64, 'b')));

    const std::string stale = jcs::canonicalize(Value(Object{{"requestId", Value("req_stale")},
                                                              {"sessionId", Value(f.server.sessionId())},
                                                              {"method", Value("plugin.instantiate")},
                                                              {"params", instantiateParams("trk_1")},
                                                              {"expectedRevision", Value("r1")}}));
    f.transport.deliver(c, stale);
    f.server.pump();
    CHECK(errorCode(json::parse(f.transport.sent(c).back())) == "revision_mismatch");
    CHECK(port.instantiated == 1);
}

TEST_CASE("plugin.instantiate failures", "[protocol][plugin]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1")});
    const std::string before = f.head().envelope.id;

    port.refusal = "plugin_load_failed";
    const Value failed = f.ok(c, "plugin.instantiate", instantiateParams("trk_1"));
    CHECK(at(failed, "state").asString() == "failed");
    CHECK(at(failed, "kind").asString() == "plugin.instantiate");
    CHECK(at(at(failed, "error"), "code").asString() == "plugin_load_failed");
    CHECK(f.head().envelope.id == before);
    const Value status = f.ok(c, "job.status", Value(Object{{"jobId", at(failed, "jobId")}}));
    CHECK(at(status, "state").asString() == "failed");
    port.refusal.reset();

    CHECK(errorCode(f.call(c, "plugin.instantiate", instantiateParams("trk_9"))) == "not_found");
    const std::vector<Value> bad = {
        Value(Object{{"trackId", Value("trk_1")}, {"index", Value(0)}}),
        Value(Object{{"trackId", Value("trk_1")}, {"index", Value(0)}, {"descriptor", Value(Object{})}}),
        Value(Object{{"trackId", Value("trk_1")},
                     {"index", Value(0)},
                     {"descriptor", Value(Object{{"format", Value("dx")}, {"path", Value("/x")}})}}),
        Value(Object{{"trackId", Value("trk_1")},
                     {"index", Value(0)},
                     {"descriptor", Value(Object{{"format", Value("clap")}, {"path", Value(7)}})}}),
        Value(Object{{"trackId", Value("trk_1")},
                     {"index", Value(-1)},
                     {"descriptor", Value(Object{{"format", Value("clap")}, {"path", Value("/x")}})}}),
        Value(Object{{"trackId", Value("trk_1")},
                     {"index", Value(0)},
                     {"descriptor", Value(Object{{"format", Value("clap")}})}}),
        instantiateParams("trk_1", std::string("sha256:abc")),
    };
    for (const Value& params : bad) {
        INFO(canonical(params));
        CHECK(errorCode(f.call(c, "plugin.instantiate", params)) == "invalid_params");
    }
    CHECK(f.head().envelope.id == before);
    CHECK(port.instantiated == 1);
}

TEST_CASE("plugin methods without a port are not_supported", "[protocol][plugin]") {
    ServerOptions options = manualOptions();
    Fixture f(options);
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1")});
    CHECK(errorCode(f.call(c, "plugin.instantiate", instantiateParams("trk_1"))) == "not_supported");
    CHECK(errorCode(f.call(c, "plugin.open_editor", Value(Object{{"slotId", Value("slt_1")}}))) == "not_supported");
    CHECK(errorCode(f.call(c, "plugin.close_editor", Value(Object{{"slotId", Value("slt_1")}}))) == "not_supported");
    CHECK(errorCode(f.call(c, "plugin.set_parameter",
                           Value(Object{{"slotId", Value("slt_1")}, {"paramId", Value("8890")}, {"value", Value(1)}}))) ==
          "not_supported");
    CHECK(errorCode(f.call(c, "plugin.registry")) == "not_supported");
    CHECK(errorCode(f.call(c, "plugin.approve",
                           Value(Object{{"format", Value("clap")}, {"path", Value("/x.clap")}, {"approved", Value(true)}}))) ==
          "not_supported");
    const Value capabilities = f.ok(c, "engine.capabilities");
    CHECK_FALSE(at(at(capabilities, "features"), "plugins").asBool());
}

TEST_CASE("plugin.open_editor and plugin.close_editor answer the editor's state", "[protocol][plugin]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    const Value opened = f.ok(c, "plugin.open_editor", Value(Object{{"slotId", Value("slt_1")}}));
    CHECK(at(opened, "slotId").asString() == "slt_1");
    CHECK(at(opened, "editorOpen").asBool());
    CHECK(at(opened, "nativeHandle").asString() == "4242");
    CHECK(port.open);
    const Value closed = f.ok(c, "plugin.close_editor", Value(Object{{"slotId", Value("slt_1")}}));
    CHECK_FALSE(at(closed, "editorOpen").asBool());
    CHECK(at(closed, "nativeHandle").asString() == "0");
    CHECK(errorCode(f.call(c, "plugin.open_editor", Value(Object{}))) == "invalid_params");
    for (const char* code : {"not_found", "plugin_missing", "editor_failed", "no_plugin_host"}) {
        port.editorRefusal = code;
        CHECK(errorCode(f.call(c, "plugin.open_editor", Value(Object{{"slotId", Value("slt_1")}}))) == code);
    }
}

// m4-crash-recovery (Protocol v0 item 20): the live, non-journaled parameter path.
Value setParameterParams(const std::string& slotId, const std::string& paramId, double value) {
    return Value(Object{{"slotId", Value(slotId)}, {"paramId", Value(paramId)}, {"value", Value(value)}});
}

TEST_CASE("plugin.set_parameter hands the value to the port and commits nothing", "[protocol][plugin][param]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed(true);
    f.commit(c, Array{trackAdd("trk_1")});
    const Value before = f.ok(c, "session.inspect");
    const std::size_t eventsBefore = f.events(c).size();

    const Value result = f.ok(c, "plugin.set_parameter", setParameterParams("slt_1", "8890", 0.75));
    CHECK(at(result, "slotId").asString() == "slt_1");
    CHECK(at(result, "paramId").asString() == "8890");
    CHECK(at(result, "value").asNumber() == 0.75);
    CHECK(result.asObject().size() == 3);
    REQUIRE(port.parameterSets.size() == 1);
    CHECK(port.parameterSets[0].slotId == "slt_1");
    CHECK(port.parameterSets[0].paramId == "8890");
    CHECK(port.parameterSets[0].value == 0.75);

    // Not journaled: no revision, no session.changed.
    const Value after = f.ok(c, "session.inspect");
    CHECK(canonical(after) == canonical(before));
    CHECK(f.events(c).size() == eventsBefore);
}

TEST_CASE("plugin.set_parameter checks its params", "[protocol][plugin][param]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    const std::vector<Value> bad = {
        Value(Object{{"paramId", Value("1")}, {"value", Value(0.5)}}),
        Value(Object{{"slotId", Value(7)}, {"paramId", Value("1")}, {"value", Value(0.5)}}),
        Value(Object{{"slotId", Value("slt_1")}, {"value", Value(0.5)}}),
        Value(Object{{"slotId", Value("slt_1")}, {"paramId", Value(1)}, {"value", Value(0.5)}}),
        Value(Object{{"slotId", Value("slt_1")}, {"paramId", Value("1")}}),
        Value(Object{{"slotId", Value("slt_1")}, {"paramId", Value("1")}, {"value", Value("0.5")}}),
        setParameterParams("slt_1", "1", -0.1),
        setParameterParams("slt_1", "1", 1.5),
    };
    for (const Value& params : bad) {
        INFO(canonical(params));
        CHECK(errorCode(f.call(c, "plugin.set_parameter", params)) == "invalid_params");
    }
    CHECK(port.parameterCalls == 0);
    // The ends of the range are values.
    f.ok(c, "plugin.set_parameter", setParameterParams("slt_1", "1", 0.0));
    f.ok(c, "plugin.set_parameter", setParameterParams("slt_1", "1", 1.0));
    CHECK(port.parameterCalls == 2);
}

TEST_CASE("plugin.set_parameter passes the port's errors through", "[protocol][plugin][param]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    for (const char* code : {"not_found", "plugin_missing"}) {
        port.parameterRefusal = code;
        CHECK(errorCode(f.call(c, "plugin.set_parameter", setParameterParams("slt_1", "1", 0.5))) == code);
    }
}

TEST_CASE("plugin.set_parameter honours expectedRevision and the idempotency cache", "[protocol][plugin][param]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1")});
    const std::string request = f.request("req_param", "plugin.set_parameter", setParameterParams("slt_1", "1", 0.5));
    f.transport.deliver(c, request);
    f.server.pump();
    f.transport.deliver(c, request);
    f.server.pump();
    CHECK(port.parameterCalls == 1);
    const auto frames = f.transport.sent(c);
    CHECK(frames[frames.size() - 1] == frames[frames.size() - 2]);

    const std::string stale = jcs::canonicalize(Value(Object{{"requestId", Value("req_stale")},
                                                              {"sessionId", Value(f.server.sessionId())},
                                                              {"method", Value("plugin.set_parameter")},
                                                              {"params", setParameterParams("slt_1", "1", 0.5)},
                                                              {"expectedRevision", Value("r1")}}));
    f.transport.deliver(c, stale);
    f.server.pump();
    CHECK(errorCode(json::parse(f.transport.sent(c).back())) == "revision_mismatch");
    CHECK(port.parameterCalls == 1);

    const std::string current = jcs::canonicalize(Value(Object{{"requestId", Value("req_current")},
                                                                {"sessionId", Value(f.server.sessionId())},
                                                                {"method", Value("plugin.set_parameter")},
                                                                {"params", setParameterParams("slt_1", "1", 0.25)},
                                                                {"expectedRevision", Value(f.head().envelope.id)}}));
    f.transport.deliver(c, current);
    f.server.pump();
    CHECK(at(json::parse(f.transport.sent(c).back()), "ok").asBool());
    CHECK(port.parameterCalls == 2);
}

TEST_CASE("plugin.set_parameter on a full inbox answers queue_full", "[protocol][plugin][param]") {
    FakePluginPort port;
    ServerOptions options = withPort(port);
    options.inboxCapacity = 1;
    Fixture f(std::move(options));
    const ConnectionId c = f.authed();
    f.transport.deliver(c, f.request("q1", "plugin.set_parameter", setParameterParams("slt_1", "1", 0.5)));
    f.transport.deliver(c, f.request("q2", "plugin.set_parameter", setParameterParams("slt_1", "1", 0.6)));
    auto sent = f.transport.sent(c);
    REQUIRE(sent.size() == 2);
    const Value full = json::parse(sent[1]);
    CHECK(at(full, "requestId").asString() == "q2");
    CHECK(errorCode(full) == "queue_full");
    CHECK(f.server.pump() == 1);
    CHECK(port.parameterCalls == 1);
    CHECK(port.parameterSets.back().value == 0.5);
}

TEST_CASE("engine.capabilities lists the plugin methods, formats and flags", "[protocol][plugin]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    const Value capabilities = f.ok(c, "engine.capabilities");
    std::vector<std::string> methods;
    for (const Value& method : at(capabilities, "methods").asArray()) {
        methods.push_back(method.asString());
    }
    for (const char* name : {"plugin.instantiate", "plugin.open_editor", "plugin.close_editor", "plugin.set_parameter",
                             "plugin.registry", "plugin.approve"}) {
        CHECK(std::find(methods.begin(), methods.end(), name) != methods.end());
    }
    const Value& plugins = at(at(capabilities, "features"), "plugins");
    REQUIRE(plugins.kind() == Value::Kind::object);
    CHECK(canonical(at(plugins, "formats")) == R"(["clap"])");
    CHECK(canonical(at(plugins, "flags")) ==
          R"(["sampleAccurateParameters","midiInput","midiOutput","sidechain","variableLatency","editor"])");
}

TEST_CASE("engine.status carries plugins[] with nulls for a missing plugin", "[protocol][plugin]") {
    FakePluginPort port;
    StatusPort transport;
    ServerOptions options = withPort(port);
    options.transportPort = &transport;
    Fixture f(options);
    const ConnectionId c = f.authed();

    PluginStatus running;
    running.slotId = "slt_1";
    running.trackId = "trk_1";
    running.format = "clap";
    running.uid = "org.siann.test-plugin";
    running.running = true;
    running.capabilities = protocol::PluginCapabilityFlags{};
    running.capabilities->editor = true;
    running.latencyFrames = 64;
    running.tailFrames = 0;
    running.callbacks = 12'345'678'901ULL;
    running.xruns = 3;
    running.maxCallbackMicros = 20'123.5;
    running.unmeasuredCallbacks = 0;
    running.midiOutputOverflows = 2;
    running.midiOutputSysex = 3;
    PluginStatus missing;
    missing.slotId = "slt_2";
    missing.trackId = "trk_1";
    missing.format = "vst3";
    missing.uid = "x";
    missing.error = std::make_pair(std::string("plugin_not_found"), std::string("gone"));
    port.reported = {running, missing};

    const Value status = f.ok(c, "engine.status");
    const auto& plugins = at(status, "plugins").asArray();
    REQUIRE(plugins.size() == 2);
    const Value& a = plugins[0];
    CHECK(at(a, "slotId").asString() == "slt_1");
    CHECK(at(a, "state").asString() == "running");
    CHECK(at(a, "callbacks").asString() == "12345678901");
    CHECK(at(a, "xruns").asString() == "3");
    CHECK(at(a, "maxCallbackMicros").asNumber() == 20'123.5);
    CHECK(at(a, "unmeasuredCallbacks").asString() == "0");
    CHECK(at(a, "midiOutputOverflows").asString() == "2");
    CHECK(at(a, "midiOutputSysex").asString() == "3");
    CHECK(at(a, "latencyFrames").asNumber() == 64);
    CHECK(at(at(a, "capabilities"), "editor").asBool());
    CHECK(a.find("error") == nullptr);
    const Value& b = plugins[1];
    CHECK(at(b, "state").asString() == "missing");
    CHECK(at(at(b, "error"), "code").asString() == "plugin_not_found");
    for (const char* key : {"capabilities", "latencyFrames", "tailFrames", "callbacks", "xruns", "maxCallbackMicros",
                            "unmeasuredCallbacks", "midiOutputOverflows", "midiOutputSysex"}) {
        INFO(key);
        CHECK(at(b, key).kind() == Value::Kind::null);
    }
}

TEST_CASE("render.start takes its own instances from the port and hands them back", "[protocol][plugin][jobs]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1")});
    f.ok(c, "plugin.instantiate", instantiateParams("trk_1"));
    const Value started = f.ok(c, "render.start", Value(Object{{"name", Value("mix")}, {"frames", Value("4800")}}));
    CHECK(port.renderSets == 1);
    CHECK(port.renderSlots == 1);
    CHECK(port.destroyed == 0);
    CHECK(f.server.runJobs() == 1);
    f.server.pump();  // the command thread hands the set back
    CHECK(port.destroyed == 1);
    const Value status = f.ok(c, "job.status", Value(Object{{"jobId", at(started, "jobId")}}));
    CHECK(at(status, "state").asString() == "done");
    f.server.pump();
    CHECK(port.destroyed == 1);
}

// ---- plugin.registry, plugin.approve (m5-plugin-registry, Protocol v0 item 21) ----

namespace {

Value approveParams(const std::string& path, bool approved, const std::string& format = "clap") {
    return Value(Object{{"format", Value(format)}, {"path", Value(path)}, {"approved", Value(approved)}});
}

}  // namespace

TEST_CASE("plugin.registry lists every install with its five fields", "[protocol][plugin][registry]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    const Value listed = f.ok(c, "plugin.registry");
    CHECK(listed.asObject().size() == 1);
    const auto& plugins = at(listed, "plugins").asArray();
    REQUIRE(plugins.size() == 2);
    CHECK(canonical(plugins[0]) ==
          R"({"approved":false,"format":"clap","name":"test","path":"/plugins/test.clap","uid":null})");
    CHECK(canonical(plugins[1]) ==
          R"({"approved":true,"format":"clap","name":"Known","path":"/plugins/known.clap","uid":"org.example.known"})");
}

TEST_CASE("plugin.approve sets the flag through the port and returns the entry", "[protocol][plugin][registry]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    const std::string before = f.head().envelope.id;
    const Value approved = f.ok(c, "plugin.approve", approveParams("/plugins/test.clap", true));
    CHECK(canonical(approved) ==
          R"({"approved":true,"format":"clap","name":"test","path":"/plugins/test.clap","uid":"org.siann.test-plugin"})");
    CHECK(port.installs[0].approved);
    const Value withdrawn = f.ok(c, "plugin.approve", approveParams("/plugins/test.clap", false));
    CHECK_FALSE(at(withdrawn, "approved").asBool());
    CHECK(f.head().envelope.id == before);  // no document change
    CHECK(port.approveCalls == 2);

    // The port's codes pass through.
    CHECK(errorCode(f.call(c, "plugin.approve", approveParams("/plugins/other.clap", true))) == "plugin_not_registered");
    port.approveRefusal = "plugin_load_failed";
    CHECK(errorCode(f.call(c, "plugin.approve", approveParams("/plugins/test.clap", true))) == "plugin_load_failed");
    port.approveRefusal.reset();
    CHECK(port.approveCalls == 4);

    const std::vector<Value> bad = {
        Value(Object{}),
        Value(Object{{"path", Value("/plugins/test.clap")}, {"approved", Value(true)}}),
        approveParams("/plugins/test.clap", true, "dx"),
        Value(Object{{"format", Value("clap")}, {"path", Value(7)}, {"approved", Value(true)}}),
        Value(Object{{"format", Value("clap")}, {"approved", Value(true)}}),
        Value(Object{{"format", Value("clap")}, {"path", Value("/plugins/test.clap")}, {"approved", Value("yes")}}),
        Value(Object{{"format", Value("clap")}, {"path", Value("/plugins/test.clap")}}),
    };
    for (const Value& params : bad) {
        INFO(canonical(params));
        CHECK(errorCode(f.call(c, "plugin.approve", params)) == "invalid_params");
    }
    CHECK(port.approveCalls == 4);
}

// The follow-up of PR #70: a library holding several plugins is approved as the
// one the request names.
TEST_CASE("plugin.approve passes the uid naming one plugin of the library to the port",
          "[protocol][plugin][registry]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    f.ok(c, "plugin.approve", approveParams("/plugins/test.clap", true));
    CHECK_FALSE(port.approvedUid.has_value());
    const auto withUid = [](Value uid) {
        return Value(Object{{"format", Value("clap")},
                            {"path", Value("/plugins/test.clap")},
                            {"approved", Value(true)},
                            {"uid", std::move(uid)}});
    };
    f.ok(c, "plugin.approve", withUid(Value("org.siann.test-plugin")));
    CHECK(port.approvedUid == std::optional<std::string>{"org.siann.test-plugin"});
    CHECK(port.approveCalls == 2);
    for (const Value& uid : {Value(7), Value(""), Value(nullptr)}) {
        const Value params = withUid(uid);
        INFO(canonical(params));
        CHECK(errorCode(f.call(c, "plugin.approve", params)) == "invalid_params");
    }
    CHECK(port.approveCalls == 2);
}

TEST_CASE("plugin.approve honours expectedRevision and the idempotency cache", "[protocol][plugin][registry]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1")});
    const std::string request = f.request("req_approve", "plugin.approve", approveParams("/plugins/test.clap", true));
    f.transport.deliver(c, request);
    f.server.pump();
    f.transport.deliver(c, request);
    f.server.pump();
    CHECK(port.approveCalls == 1);
    const auto frames = f.transport.sent(c);
    CHECK(frames[frames.size() - 1] == frames[frames.size() - 2]);

    const std::string stale = jcs::canonicalize(Value(Object{{"requestId", Value("req_stale")},
                                                              {"sessionId", Value(f.server.sessionId())},
                                                              {"method", Value("plugin.approve")},
                                                              {"params", approveParams("/plugins/test.clap", false)},
                                                              {"expectedRevision", Value("r1")}}));
    f.transport.deliver(c, stale);
    f.server.pump();
    CHECK(errorCode(json::parse(f.transport.sent(c).back())) == "revision_mismatch");
    CHECK(port.approveCalls == 1);
    CHECK(port.installs[0].approved);

    const std::string listing = jcs::canonicalize(Value(Object{{"requestId", Value("req_list")},
                                                                {"sessionId", Value(f.server.sessionId())},
                                                                {"method", Value("plugin.registry")},
                                                                {"params", Value(Object{})},
                                                                {"expectedRevision", Value("r1")}}));
    f.transport.deliver(c, listing);
    f.server.pump();
    CHECK(errorCode(json::parse(f.transport.sent(c).back())) == "revision_mismatch");
}

TEST_CASE("plugin.instantiate refuses a UNC path and a path inside the bundle before the port",
          "[protocol][plugin][registry]") {
    FakePluginPort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_1")});
    const std::string inside = (f.session.bundlePath() / "blobs" / "x.clap").string();
    for (const std::string& path : {std::string(R"(\\server\share\x.clap)"), std::string("//server/share/x.clap"),
                                    std::string(R"(\\?\UNC\server\share\x.clap)"), inside}) {
        INFO(path);
        const Value params(Object{{"trackId", Value("trk_1")},
                                  {"index", Value(0)},
                                  {"descriptor", Value(Object{{"format", Value("clap")}, {"path", Value(path)}})}});
        CHECK(errorCode(f.call(c, "plugin.instantiate", params)) == "invalid_params");
    }
    CHECK(port.instantiated == 0);
}
