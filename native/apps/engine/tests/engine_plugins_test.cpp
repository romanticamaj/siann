// EngineHost as the protocol's PluginPort (m4-plugin-node; spec, Protocol v0
// items 18 and 19, "Commands and jobs", Jobs v0, plugins), with siann_test_plugin
// as a CLAP, through a ProtocolServer over the in-memory transport.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "live_rig.hpp"
#include "siann/engine_app/engine_host.hpp"
#include "siann/host/fake_audio_device.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/io/durable_file.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using Catch::Approx;
using engine_app::EngineHost;
using engine_app::EngineHostOptions;
using live_rig::Fixture;
using live_rig::kBlock;
using protocol::testing::Harness;
using protocol::testing::at;
using protocol::testing::errorCode;
using json::Object;
using json::Value;

namespace {

Value instantiateParams(const std::string& trackId, const std::string& format, const std::string& path) {
    return Value(Object{{"trackId", Value(trackId)},
                        {"index", Value(0)},
                        {"descriptor", Value(Object{{"format", Value(format)}, {"path", Value(path)}})}});
}

int parameterIndex(host::PluginInstance& instance, const std::string& name) {
    const auto parameters = instance.control().parameters();
    for (std::size_t i = 0; i < parameters.size(); ++i) {
        if (parameters[i].name == name) {
            return static_cast<int>(i);
        }
    }
    FAIL("no parameter " << name);
    return -1;
}

// The test plugins' build directories, as the launch tests pass them with
// --plugin-dir (m5-plugin-registry).
std::vector<std::string> testPluginDirs() {
    std::vector<std::string> dirs{std::filesystem::path(SIANN_TEST_PLUGIN_CLAP).parent_path().string(),
                                  std::filesystem::path(SIANN_HOSTILE_PLUGIN_CLAP).parent_path().string()};
#if defined(SIANN_ENGINE_WITH_JUCE) && defined(SIANN_TEST_PLUGIN_VST3)
    dirs.push_back(std::filesystem::path(SIANN_TEST_PLUGIN_VST3).parent_path().string());
#endif
    return dirs;
}

// The test plugins that may load: approved through the method, as a user would.
std::vector<std::pair<std::string, std::string>> testPlugins() {
    std::vector<std::pair<std::string, std::string>> plugins{{"clap", SIANN_TEST_PLUGIN_CLAP},
                                                             {"clap", SIANN_HOSTILE_PLUGIN_CLAP}};
#if defined(SIANN_ENGINE_WITH_JUCE) && defined(SIANN_TEST_PLUGIN_VST3)
    plugins.emplace_back("vst3", SIANN_TEST_PLUGIN_VST3);
#endif
    return plugins;
}

Value approveParams(const std::string& format, const std::string& path, bool approved = true) {
    return Value(Object{{"format", Value(format)}, {"path", Value(path)}, {"approved", Value(approved)}});
}

void approveTestPlugins(Harness& harness, protocol::ConnectionId connection) {
    for (const auto& [format, path] : testPlugins()) {
        INFO(path);
        const Value entry = harness.ok(connection, "plugin.approve", approveParams(format, path));
        REQUIRE(at(entry, "approved").asBool());
    }
}

// The entry plugin.registry lists for `path`, or nullptr.
const Value* registryEntry(const Value& listed, const std::string& path) {
    for (const Value& entry : at(listed, "plugins").asArray()) {
        if (std::filesystem::path(at(entry, "path").asString()).lexically_normal() ==
            std::filesystem::path(path).lexically_normal()) {
            return &entry;
        }
    }
    return nullptr;
}

protocol::ServerOptions serverOptions(EngineHost& host) {
    protocol::ServerOptions options = protocol::testing::manualOptions();
    options.transportPort = &host;
    options.auditionPort = host.auditionPort();
    options.pluginPort = &host;
    options.jobs.workerThread = false;
    return options;
}

// An engine host on a manual device, served by a protocol server.
struct ManualRig {
    Fixture fixture;
    std::vector<std::string> diagnostics;  // before the host that reports into it
    host::ManualAudioDevice* device = nullptr;
    std::unique_ptr<EngineHost> host;
    std::unique_ptr<Harness> harness;
    protocol::ConnectionId connection = 0;

    explicit ManualRig(bool approve = true, std::vector<std::string> extraDirs = {}) {
        auto owned = std::make_unique<host::ManualAudioDevice>();
        device = owned.get();
        EngineHostOptions options;
        options.device = std::move(owned);
        options.deviceId = "manual";
        options.bufferFrames = kBlock;
        options.playback = live_rig::testOptions();
        options.pluginDirs = testPluginDirs();
        options.pluginDirs.insert(options.pluginDirs.end(), extraDirs.begin(), extraDirs.end());
        options.pluginRegistryFile = registryFile();
        options.diagnostic = [this](const std::string& line) { diagnostics.push_back(line); };
        host = std::make_unique<EngineHost>(fixture.session, std::move(options));
        harness = std::make_unique<Harness>(fixture.session, serverOptions(*host));
        connection = harness->authed();
        if (approve) {
            approveTestPlugins(*harness, connection);
        }
    }

    std::filesystem::path registryFile() const { return fixture.dir.path() / "plugin-registry.json"; }
    ~ManualRig() {
        harness.reset();
        host->shutdown();
    }

    Value ok(const std::string& method, Value params = Value(Object{})) {
        return harness->ok(connection, method, std::move(params));
    }

    void pump(int blocks) {
        for (int b = 0; b < blocks; ++b) {
            device->pump(1);
            host->tick();
            host->playback().butler().runOnce();
            host->tick();
        }
    }

    const Value* plugin(const Value& status, const std::string& slotId) {
        for (const Value& entry : at(status, "plugins").asArray()) {
            if (at(entry, "slotId").asString() == slotId) {
                return &entry;
            }
        }
        return nullptr;
    }
};

}  // namespace

TEST_CASE("plugin.instantiate through the engine host loads, inserts and reports the plugin", "[engine][plugin]") {
    ManualRig rig;
    rig.host->play();
    const Value loaded = rig.ok("plugin.instantiate", instantiateParams("trk_a", "clap", SIANN_TEST_PLUGIN_CLAP));
    REQUIRE(at(loaded, "state").asString() == "done");
    const Value& result = at(loaded, "result");
    const std::string slotId = at(result, "slotId").asString();
    CHECK(at(at(result, "descriptor"), "uid").asString() == "org.siann.test-plugin");
    CHECK(at(result, "latencyFrames").asNumber() == 64);
    CHECK(at(at(result, "capabilities"), "variableLatency").asBool());
    CHECK(at(result, "stateBlob").kind() == Value::Kind::string);
    host::PluginInstance* instance = rig.host->playback().plugins().instance(slotId);
    REQUIRE(instance != nullptr);  // adopted: the next compile reuses it

    rig.pump(8);
    CHECK(rig.host->playback().plugins().instance(slotId) == instance);
    const Value status = rig.ok("engine.status");
    const Value* entry = rig.plugin(status, slotId);
    REQUIRE(entry != nullptr);
    CHECK(at(*entry, "state").asString() == "running");
    CHECK(at(*entry, "latencyFrames").asNumber() == 64);
    CHECK(at(*entry, "callbacks").asString() != "0");
    CHECK(at(*entry, "xruns").asString() == "0");
    CHECK(at(at(*entry, "capabilities"), "editor").kind() == Value::Kind::boolean);

    // Unrelated commits keep the instance.
    rig.ok("command.execute", Value(Object{{"commands", Value(json::Array{Value(Object{{"op", Value("track.add")},
                                                                                       {"trackId", Value("trk_c")},
                                                                                       {"name", Value("C")},
                                                                                       {"channels", Value(2)}})})}}));
    rig.pump(8);
    CHECK(rig.host->playback().plugins().instance(slotId) == instance);
    CHECK(rig.harness->server.waitJob(at(loaded, "jobId").asString(), std::chrono::milliseconds(0)));
}

TEST_CASE("a plugin that is not there fails the job and a missing slot shows as missing", "[engine][plugin]") {
    ManualRig rig;
    const Value failed = rig.ok("plugin.instantiate", instantiateParams("trk_a", "clap", "/nowhere/gone.clap"));
    CHECK(at(failed, "state").asString() == "failed");
    CHECK(at(at(failed, "error"), "code").asString() == "plugin_not_registered");

    // A slot whose plugin is gone (inserted by a command, as a reopened session has it).
    rig.fixture.exec(R"({"op":"plugin.insert","trackId":"trk_b","index":0,"slotId":"slt_gone",
        "descriptor":{"format":"clap","uid":"org.siann.gone","path":"/nowhere/gone.clap"},
        "stateBlob":"sha256:)" + std::string(64, 'c') + R"("})");
    rig.host->auditionPort()->mainCommitted();
    rig.pump(4);
    const Value status = rig.ok("engine.status");
    const Value* entry = rig.plugin(status, "slt_gone");
    REQUIRE(entry != nullptr);
    CHECK(at(*entry, "state").asString() == "missing");
    CHECK(at(at(*entry, "error"), "code").asString() == "plugin_not_registered");
    CHECK(at(*entry, "callbacks").kind() == Value::Kind::null);
    CHECK(rig.fixture.doc().pluginSlot("slt_gone")->stateBlob.has_value());
    CHECK(errorCode(rig.harness->call(rig.connection, "plugin.open_editor", Value(Object{{"slotId", Value("slt_gone")}}))) ==
          "plugin_missing");
    CHECK(errorCode(rig.harness->call(rig.connection, "plugin.open_editor", Value(Object{{"slotId", Value("slt_9")}}))) ==
          "not_found");
}

TEST_CASE("a plugin that holds its block is an xrun of the driver and of its own timer", "[engine][plugin][timing]") {
    ManualRig rig;
    rig.host->play();
    const std::string slow = at(at(rig.ok("plugin.instantiate", instantiateParams("trk_a", "clap", SIANN_TEST_PLUGIN_CLAP)),
                                   "result"),
                                "slotId")
                                 .asString();
    const std::string fast = at(at(rig.ok("plugin.instantiate", instantiateParams("trk_b", "clap", SIANN_TEST_PLUGIN_CLAP)),
                                   "result"),
                                "slotId")
                                 .asString();
    rig.pump(4);
    host::PluginInstance* instance = rig.host->playback().plugins().instance(slow);
    instance->control().setParameter(parameterIndex(*instance, "holdProcessBlock"), 1.0);
    rig.pump(1);
    const std::uint64_t before = rig.host->status().xruns;
    rig.pump(4);
    CHECK(rig.host->status().xruns >= before + 4);
    const Value status = rig.ok("engine.status");
    CHECK(std::stoull(at(*rig.plugin(status, slow), "xruns").asString()) >= 4);
    CHECK(at(*rig.plugin(status, slow), "maxCallbackMicros").asNumber() >= 20'000.0);
    CHECK(at(*rig.plugin(status, fast), "xruns").asString() == "0");
}

#if !defined(SIANN_ENGINE_WITH_JUCE)
TEST_CASE("a core build has no VST3 or AU host", "[engine][plugin]") {
    ManualRig rig;
    for (const char* format : {"vst3", "au"}) {
        const Value failed = rig.ok("plugin.instantiate", instantiateParams("trk_a", format, "/x/plugin"));
        CHECK(at(failed, "state").asString() == "failed");
        CHECK(at(at(failed, "error"), "code").asString() == "no_plugin_host");
    }
    const Value capabilities = rig.ok("engine.capabilities");
    CHECK(protocol::testing::canonical(at(at(at(capabilities, "features"), "plugins"), "formats")) == R"(["clap"])");
}
#endif

TEST_CASE("on the fake device: getState waits for a block, a render overlaps playback on its own instances",
          "[engine][plugin][render]") {
    Fixture fixture;
    host::FakeAudioDevice::Options deviceOptions;
    deviceOptions.paced = true;
    EngineHostOptions options;
    options.device = std::make_unique<host::FakeAudioDevice>(deviceOptions);
    auto* device = static_cast<host::FakeAudioDevice*>(options.device.get());
    options.deviceId = "fake";
    options.playback.ringFrames = 8'192;
    options.pluginDirs = testPluginDirs();
    EngineHost host(fixture.session, std::move(options));
    protocol::ServerOptions server = serverOptions(host);
    server.jobs.workerThread = true;  // the offline-render thread
    Harness harness(fixture.session, server);
    const protocol::ConnectionId c = harness.authed();
    approveTestPlugins(harness, c);
    host.play();
    const Value loaded = harness.ok(c, "plugin.instantiate", instantiateParams("trk_a", "clap", SIANN_TEST_PLUGIN_CLAP));
    const std::string slotId = at(at(loaded, "result"), "slotId").asString();
    host::PluginInstance* instance = host.playback().plugins().instance(slotId);
    REQUIRE(instance != nullptr);
    instance->control().setParameter(parameterIndex(*instance, "watchSave"), 1.0);
    const auto until = [&](const std::function<bool()>& done) {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
        while (!done() && std::chrono::steady_clock::now() < deadline) {
            harness.server.pump();
            host.tick();
            std::this_thread::yield();
        }
        return done();
    };
    REQUIRE(until([&] { return host.playback().plugins().pins(slotId) > 0 && device->callbacks() > 16; }));
    CHECK(host.playback().plugins().blocksComingTold(slotId) == std::optional<bool>{true});

    const std::int64_t position = host.transportState().position;
    const auto state = instance->control().getState();
    CHECK_FALSE(state.empty());
    CHECK(instance->control().getParameter(parameterIndex(*instance, "savedWhileProcessing")) > 0.5);

    const Value started = harness.ok(c, "render.start", Value(Object{{"name", Value("mix")}, {"frames", Value("96000")}}));
    const std::string jobId = at(started, "jobId").asString();
    REQUIRE(until([&] {
        const Value status = harness.ok(c, "job.status", Value(Object{{"jobId", Value(jobId)}}));
        return at(status, "state").asString() == "done";
    }));
    CHECK(until([&] { return host.transportState().position > position; }));
    CHECK(instance->control().getParameter(parameterIndex(*instance, "concurrentProcess")) * 4.0 == Approx(1.0));
    CHECK(host.status().playing);
    host.shutdown();
    CHECK(host.playback().plugins().blocksComingTold(slotId) == std::optional<bool>{false});
}

// ---- plugin.set_parameter (m4-crash-recovery; spec, Protocol v0 item 20) ----

namespace {

// The id plugin.set_parameter takes: what the instance's parameter list reports.
std::string parameterId(host::PluginInstance& instance, const std::string& name) {
    return instance.control().parameters()[static_cast<std::size_t>(parameterIndex(instance, name))].id;
}

Value setParameterParams(const std::string& slotId, const std::string& paramId, double value) {
    return Value(Object{{"slotId", Value(slotId)}, {"paramId", Value(paramId)}, {"value", Value(value)}});
}

}  // namespace

TEST_CASE("plugin.set_parameter reaches a CLAP slot as an event of the next block", "[engine][plugin][param]") {
    ManualRig rig;
    rig.host->play();
    const std::string slotId =
        at(at(rig.ok("plugin.instantiate", instantiateParams("trk_a", "clap", SIANN_TEST_PLUGIN_CLAP)), "result"),
           "slotId")
            .asString();
    rig.pump(4);
    host::PluginInstance* instance = rig.host->playback().plugins().instance(slotId);
    REQUIRE(instance != nullptr);
    const int gain = parameterIndex(*instance, "gain");
    const double before = instance->control().getParameter(gain);
    REQUIRE(before != Approx(0.25));
    const std::size_t revisions = rig.fixture.session.history().revisions().size();

    const Value result = rig.ok("plugin.set_parameter", setParameterParams(slotId, parameterId(*instance, "gain"), 0.25));
    CHECK(at(result, "slotId").asString() == slotId);
    // Through the dispatcher and the audio thread, not a main-thread call.
    CHECK(instance->control().getParameter(gain) == Approx(before));
    rig.host->tick();  // the dispatcher hands it to paramInbox
    CHECK(instance->control().getParameter(gain) == Approx(before));
    rig.device->pump(1);  // the block that carries the event
    CHECK(instance->control().getParameter(gain) == Approx(0.25));
    CHECK(rig.fixture.session.history().revisions().size() == revisions);  // not journaled

    // The instance is pinned: an unrelated structural edit keeps the value.
    rig.ok("command.execute", Value(Object{{"commands", Value(json::Array{Value(Object{{"op", Value("track.add")},
                                                                                       {"trackId", Value("trk_c")},
                                                                                       {"name", Value("C")},
                                                                                       {"channels", Value(2)}})})}}));
    rig.pump(8);
    CHECK(rig.host->playback().plugins().instance(slotId) == instance);
    CHECK(instance->control().getParameter(gain) == Approx(0.25));
}

TEST_CASE("plugin.set_parameter answers not_found and plugin_missing", "[engine][plugin][param]") {
    ManualRig rig;
    const std::string slotId =
        at(at(rig.ok("plugin.instantiate", instantiateParams("trk_a", "clap", SIANN_TEST_PLUGIN_CLAP)), "result"),
           "slotId")
            .asString();
    rig.pump(2);
    host::PluginInstance* instance = rig.host->playback().plugins().instance(slotId);
    REQUIRE(instance != nullptr);
    const std::string gain = parameterId(*instance, "gain");
    const auto codeOf = [&](const Value& params) {
        return errorCode(rig.harness->call(rig.connection, "plugin.set_parameter", params));
    };
    CHECK(codeOf(setParameterParams("slt_9", gain, 0.5)) == "not_found");
    CHECK(codeOf(setParameterParams(slotId, "4242424", 0.5)) == "not_found");
    CHECK(codeOf(setParameterParams(slotId, "gain", 0.5)) == "not_found");  // a name is not an id

    rig.fixture.exec(R"({"op":"plugin.insert","trackId":"trk_b","index":0,"slotId":"slt_gone",
        "descriptor":{"format":"clap","uid":"org.siann.gone","path":"/nowhere/gone.clap"},
        "stateBlob":"sha256:)" + std::string(64, 'c') + R"("})");
    rig.host->auditionPort()->mainCommitted();
    rig.pump(4);
    CHECK(codeOf(setParameterParams("slt_gone", gain, 0.5)) == "plugin_missing");
    CHECK(rig.host->playback().dispatcher().pendingCount() == 0);
}

#if defined(SIANN_ENGINE_WITH_JUCE) && defined(SIANN_TEST_PLUGIN_VST3)
TEST_CASE("plugin.set_parameter sets a VST3 slot on the main thread", "[engine][plugin][param][juce]") {
    ManualRig rig;
    rig.host->play();
    const Value loaded = rig.ok("plugin.instantiate", instantiateParams("trk_a", "vst3", SIANN_TEST_PLUGIN_VST3));
    REQUIRE(at(loaded, "state").asString() == "done");
    const std::string slotId = at(at(loaded, "result"), "slotId").asString();
    rig.pump(4);
    host::PluginInstance* instance = rig.host->playback().plugins().instance(slotId);
    REQUIRE(instance != nullptr);
    const int gain = parameterIndex(*instance, "gain");
    REQUIRE(instance->control().getParameter(gain) != Approx(0.25));
    rig.ok("plugin.set_parameter", setParameterParams(slotId, parameterId(*instance, "gain"), 0.25));
    // No block pumped and nothing for the dispatcher: setParameter on this thread.
    CHECK(instance->control().getParameter(gain) == Approx(0.25).margin(1e-6));
    CHECK(rig.host->playback().dispatcher().pendingCount() == 0);
}
#endif

// ---- midiOutputSysex (m4-juce-formats; ADR-0018, Amendment 3; Protocol v0 item 18) ----

namespace {

// siann_test_plugin's "midiSysex", set through plugin.set_parameter while it plays:
// engine.status reports one sysex a block beside an unmoved midiOutputOverflows.
void checkSysexReported(const std::string& format, const std::string& path) {
    ManualRig rig;
    rig.host->play();
    const Value loaded = rig.ok("plugin.instantiate", instantiateParams("trk_a", format, path));
    REQUIRE(at(loaded, "state").asString() == "done");
    const std::string slotId = at(at(loaded, "result"), "slotId").asString();
    rig.pump(4);
    host::PluginInstance* instance = rig.host->playback().plugins().instance(slotId);
    REQUIRE(instance != nullptr);
    const Value quiet = rig.ok("engine.status");
    CHECK(at(*rig.plugin(quiet, slotId), "midiOutputSysex").asString() == "0");

    rig.ok("plugin.set_parameter", setParameterParams(slotId, parameterId(*instance, "midiSysex"), 1.0));
    rig.pump(8);
    const Value status = rig.ok("engine.status");
    const Value* entry = rig.plugin(status, slotId);
    REQUIRE(entry != nullptr);
    const std::uint64_t sysex = std::stoull(at(*entry, "midiOutputSysex").asString());
    CHECK(sysex >= 7);
    CHECK(sysex <= 8);
    CHECK(at(*entry, "midiOutputOverflows").asString() == "0");
    rig.pump(4);
    CHECK(std::stoull(at(*rig.plugin(rig.ok("engine.status"), slotId), "midiOutputSysex").asString()) == sysex + 4);
}

}  // namespace

TEST_CASE("engine.status counts a CLAP plugin's sysex output beside its overflows", "[engine][plugin][midi]") {
    checkSysexReported("clap", SIANN_TEST_PLUGIN_CLAP);
}

#if defined(SIANN_ENGINE_WITH_JUCE) && defined(SIANN_TEST_PLUGIN_VST3)
TEST_CASE("engine.status counts a VST3's sysex output beside its overflows", "[engine][plugin][midi][juce]") {
    checkSysexReported("vst3", SIANN_TEST_PLUGIN_VST3);
}
#endif

// ---- the plugin registry (m5-plugin-registry; Protocol v0 item 21) ----------------

TEST_CASE("plugin.registry lists the scanned build plugins unapproved and unprobed", "[engine][plugin][registry]") {
    ManualRig rig(false);
    const Value listed = rig.ok("plugin.registry");
    for (const auto& [format, path] : testPlugins()) {
        INFO(path);
        const Value* entry = registryEntry(listed, path);
        REQUIRE(entry != nullptr);
        CHECK(at(*entry, "format").asString() == format);
        CHECK(at(*entry, "uid").kind() == Value::Kind::null);
        CHECK_FALSE(at(*entry, "approved").asBool());
        CHECK_FALSE(at(*entry, "name").asString().empty());
    }
    // Nothing is written before an approval.
    CHECK_FALSE(std::filesystem::exists(rig.registryFile()));
}

TEST_CASE("plugin.approve probes the install and plugin.instantiate needs it approved", "[engine][plugin][registry]") {
    ManualRig rig(false);
    const Value before = rig.ok("plugin.instantiate", instantiateParams("trk_a", "clap", SIANN_TEST_PLUGIN_CLAP));
    CHECK(at(before, "state").asString() == "failed");
    CHECK(at(at(before, "error"), "code").asString() == "plugin_not_approved");
    CHECK(rig.fixture.doc().pluginSlot("slt_1") == nullptr);

    const Value approved = rig.ok("plugin.approve", approveParams("clap", SIANN_TEST_PLUGIN_CLAP));
    CHECK(at(approved, "uid").asString() == "org.siann.test-plugin");
    CHECK(at(approved, "name").asString() == "SIANN Test Plugin");
    CHECK(at(approved, "approved").asBool());
    const Value after = rig.ok("plugin.instantiate", instantiateParams("trk_a", "clap", SIANN_TEST_PLUGIN_CLAP));
    REQUIRE(at(after, "state").asString() == "done");
    CHECK(at(at(at(after, "result"), "descriptor"), "uid").asString() == "org.siann.test-plugin");

    // By uid alone: its one approved install.
    const Value byUid = rig.ok("plugin.instantiate",
                               Value(Object{{"trackId", Value("trk_b")},
                                            {"index", Value(0)},
                                            {"descriptor", Value(Object{{"format", Value("clap")},
                                                                        {"uid", Value("org.siann.test-plugin")}})}}));
    CHECK(at(byUid, "state").asString() == "done");
    const Value unknown = rig.ok("plugin.instantiate",
                                 Value(Object{{"trackId", Value("trk_b")},
                                              {"index", Value(0)},
                                              {"descriptor", Value(Object{{"format", Value("clap")},
                                                                          {"uid", Value("org.example.unknown")}})}}));
    CHECK(at(at(unknown, "error"), "code").asString() == "plugin_not_registered");

    // Withdrawn: takes effect at the next instantiate, no probe needed.
    const Value withdrawn = rig.ok("plugin.approve", approveParams("clap", SIANN_TEST_PLUGIN_CLAP, false));
    CHECK_FALSE(at(withdrawn, "approved").asBool());
    CHECK(at(withdrawn, "uid").asString() == "org.siann.test-plugin");
    const Value again = rig.ok("plugin.instantiate", instantiateParams("trk_a", "clap", SIANN_TEST_PLUGIN_CLAP));
    CHECK(at(at(again, "error"), "code").asString() == "plugin_not_approved");
}

TEST_CASE("plugin.instantiate on an unregistered path never opens it", "[engine][plugin][registry]") {
    ManualRig rig;
    live_rig::TempDir elsewhere;
    const std::filesystem::path original(SIANN_TEST_PLUGIN_CLAP);
    const std::filesystem::path copy = elsewhere.path() / original.filename();
    std::filesystem::copy(original, copy, std::filesystem::copy_options::recursive);
    const Value failed = rig.ok("plugin.instantiate", instantiateParams("trk_a", "clap", copy.string()));
    CHECK(at(failed, "state").asString() == "failed");
    CHECK(at(at(failed, "error"), "code").asString() == "plugin_not_registered");
    CHECK(at(at(failed, "error"), "message").asString().find("unregistered_path") != std::string::npos);
    CHECK(errorCode(rig.harness->call(rig.connection, "plugin.approve", approveParams("clap", copy.string()))) ==
          "plugin_not_registered");
}

TEST_CASE("a registered file that is not a plugin stays unapproved when its probe fails", "[engine][plugin][registry]") {
    live_rig::TempDir plugins;
    std::ofstream(plugins.path() / "broken.clap") << "not a library";
    ManualRig rig(false, {plugins.path().string()});
    const std::string broken = (plugins.path() / "broken.clap").string();
    REQUIRE(registryEntry(rig.ok("plugin.registry"), broken) != nullptr);
    CHECK(errorCode(rig.harness->call(rig.connection, "plugin.approve", approveParams("clap", broken))) ==
          "plugin_load_failed");
    const Value after = rig.ok("plugin.registry");
    const Value* entry = registryEntry(after, broken);
    REQUIRE(entry != nullptr);
    CHECK_FALSE(at(*entry, "approved").asBool());
    CHECK(at(*entry, "uid").kind() == Value::Kind::null);
}

TEST_CASE("the registry file keeps approvals for the next engine host", "[engine][plugin][registry]") {
    Fixture fixture;
    const std::filesystem::path file = fixture.dir.path() / "plugin-registry.json";
    const auto makeHost = [&] {
        EngineHostOptions options;
        options.playback = live_rig::testOptions();
        options.pluginDirs = testPluginDirs();
        options.pluginRegistryFile = file;
        return std::make_unique<EngineHost>(fixture.session, std::move(options));
    };
    {
        auto host = makeHost();
        Harness harness(fixture.session, serverOptions(*host));
        const protocol::ConnectionId c = harness.authed();
        harness.ok(c, "plugin.approve", approveParams("clap", SIANN_TEST_PLUGIN_CLAP));
        host->shutdown();
    }
    REQUIRE(std::filesystem::exists(file));
    const Value saved = json::parse(io::readFile(file));
    CHECK(at(saved, "schema").asString() == "siann.plugin_registry.v0");
    const Value* kept = registryEntry(saved, SIANN_TEST_PLUGIN_CLAP);
    REQUIRE(kept != nullptr);
    CHECK(at(*kept, "approved").asBool());
    CHECK(at(*kept, "uid").asString() == "org.siann.test-plugin");

    auto host = makeHost();
    Harness harness(fixture.session, serverOptions(*host));
    const protocol::ConnectionId c = harness.authed();
    const Value listed = harness.ok(c, "plugin.registry");
    const Value* entry = registryEntry(listed, SIANN_TEST_PLUGIN_CLAP);
    REQUIRE(entry != nullptr);
    CHECK(at(*entry, "approved").asBool());
    CHECK(at(*entry, "uid").asString() == "org.siann.test-plugin");
    const Value loaded = harness.ok(c, "plugin.instantiate", instantiateParams("trk_a", "clap", SIANN_TEST_PLUGIN_CLAP));
    CHECK(at(loaded, "state").asString() == "done");
    host->shutdown();
}

TEST_CASE("a malformed registry file is one diagnostic and an empty registry", "[engine][plugin][registry]") {
    for (const std::string& text : {std::string("{not json"), std::string(R"({"schema":"other","plugins":[]})"),
                                   std::string(R"({"schema":"siann.plugin_registry.v0","plugins":[{"format":7}]})")}) {
        INFO(text);
        Fixture fixture;
        const std::filesystem::path file = fixture.dir.path() / "plugin-registry.json";
        io::writeFileAtomic(file, text);
        std::vector<std::string> diagnostics;
        EngineHostOptions options;
        options.playback = live_rig::testOptions();
        options.pluginDirs = testPluginDirs();
        options.pluginRegistryFile = file;
        options.diagnostic = [&](const std::string& line) { diagnostics.push_back(line); };
        auto host = std::make_unique<EngineHost>(fixture.session, std::move(options));
        Harness harness(fixture.session, serverOptions(*host));
        const protocol::ConnectionId c = harness.authed();
        std::size_t registryLines = 0;
        for (const std::string& line : diagnostics) {
            registryLines += line.find("plugin registry") != std::string::npos ? 1 : 0;
        }
        CHECK(registryLines == 1);
        const Value listed = harness.ok(c, "plugin.registry");
        const Value* entry = registryEntry(listed, SIANN_TEST_PLUGIN_CLAP);
        REQUIRE(entry != nullptr);  // scanned all the same
        CHECK_FALSE(at(*entry, "approved").asBool());
        host->shutdown();
    }
}
