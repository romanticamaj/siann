#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <thread>

#include "support/live_rig.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/host/clap_plugin_host.hpp"
#include "siann/host/fake_audio_device.hpp"
#include "siann/playback/plugin_instances.hpp"

// The instance table of the live graph and the render's own instance set
// (m4-plugin-node), with siann_test_plugin as a CLAP.

using namespace live_rig;
using Catch::Approx;
using playback::PluginHosts;
using playback::PluginInstanceTable;
using playback::RenderInstanceSet;

namespace {

std::string insertSlot(const std::string& slotId, const std::string& trackId, const std::string& path,
                       const std::string& stateBlob = "null") {
    return R"({"op":"plugin.insert","trackId":")" + trackId + R"(","index":0,"slotId":")" + slotId +
           R"(","descriptor":{"format":"clap","uid":"org.siann.test-plugin","path":)" + jcs::canonicalize(json::Value(path)) +
           R"(},"stateBlob":)" + stateBlob + "}";
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

// Saves a state blob of the test plugin with `gain` into <bundle>/blobs, as
// plugin.instantiate does; returns its "sha256:<hex>".
std::string writeBlob(host::ClapPluginHost& host, const fs::path& bundle, double gain) {
    host::PluginDescriptor descriptor;
    descriptor.format = "clap";
    descriptor.uid = "org.siann.test-plugin";
    descriptor.path = SIANN_TEST_PLUGIN_CLAP;
    auto instance = host.instantiate(descriptor, 48'000, kBlock);
    instance->control().setParameter(parameterIndex(*instance, "gain"), gain);
    host.runMainThreadCallbacks();
    const std::vector<std::uint8_t> state = instance->control().getState();
    const std::string text(state.begin(), state.end());
    const std::string hash = hash::formatHash(hash::sha256(text));
    fs::create_directories(bundle / "blobs");
    io::writeFileAtomic(playback::blobPath(bundle, hash), text);
    return hash;
}

PlaybackOptions pluginOptions(host::ClapPluginHost& host) {
    PlaybackOptions o = testOptions();
    o.pluginHosts = PluginHosts{{"clap", &host}};
    return o;
}

// Pumps like Live::pump, and services the CLAP host on the main thread as the
// engine host's tick does.
void pump(Live& live, host::ClapPluginHost& host, int blocks) {
    for (int b = 0; b < blocks; ++b) {
        live.device.pumpAll(1, live.out);
        host.runMainThreadCallbacks();
        live.engine.tick();
        live.engine.butler().runOnce();
        live.engine.tick();
    }
}

void edit(Fixture& f, Live& live, const std::string& json) {
    f.exec(json);
    live.engine.update(f.doc());
}

template <class Predicate>
bool eventually(Predicate predicate, std::chrono::seconds timeout = std::chrono::seconds(10)) {
    const auto end = std::chrono::steady_clock::now() + timeout;
    while (!predicate()) {
        if (std::chrono::steady_clock::now() > end) {
            return false;
        }
        std::this_thread::yield();
    }
    return true;
}

}  // namespace

TEST_CASE("plugin table: an instance survives unrelated edits through its pins", "[playback][plugin]") {
    Fixture f;
    host::ClapPluginHost host;
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP));
    Live live(f.session, pluginOptions(host));
    PluginInstanceTable& table = live.engine.plugins();
    host::PluginInstance* first = table.instance("slt_1");
    REQUIRE(first != nullptr);
    CHECK(table.pins("slt_1") == 1);
    const auto status = table.status("slt_1");
    REQUIRE(status.has_value());
    CHECK(status->running);
    CHECK_FALSE(status->error.has_value());
    CHECK(status->latencyFrames == 64);
    REQUIRE(status->capabilities.has_value());
    CHECK(status->capabilities->variableLatency);
    pump(live, host, 4);
    CHECK(table.status("slt_1")->callbacks == 4);

    const std::size_t compiles = live.engine.compileCount();
    edit(f, live, addTrack("trk_c"));
    pump(live, host, 6);
    CHECK(live.engine.compileCount() == compiles + 1);
    CHECK(table.instance("slt_1") == first);
    edit(f, live, R"({"op":"track.set_gain","trackId":"trk_b","gainMilliDb":-3000})");
    pump(live, host, 4);
    CHECK(table.instance("slt_1") == first);
    CHECK(table.pins("slt_1") == 1);  // the retired graphs let go of it
    CHECK(table.size() == 1);
}

TEST_CASE("plugin table: a plugin that cannot load passes audio through and reports missing", "[playback][plugin]") {
    Fixture f;
    host::ClapPluginHost host;
    const std::string blob = "\"sha256:" + std::string(64, 'e') + "\"";
    f.exec(insertSlot("slt_gone", "trk_a", (f.dir.path() / "missing.clap").string(), blob));
    Live live(f.session, pluginOptions(host));
    pump(live, host, 8);
    const auto status = live.engine.plugins().status("slt_gone");
    REQUIRE(status.has_value());
    CHECK_FALSE(status->running);
    REQUIRE(status->error.has_value());
    CHECK(status->error->code == "plugin_not_found");
    CHECK_FALSE(status->capabilities.has_value());
    CHECK(live.engine.plugins().instance("slt_gone") == nullptr);
    // The slot keeps its state blob in the document and the track sounds dry.
    CHECK(f.doc().pluginSlot("slt_gone")->stateBlob.has_value());
    CHECK(matches(live, offline(f.doc(), f.bundle(), framesOf(live)), 1, live.blockCount()));  // after the rise
}

TEST_CASE("plugin table: a format without a host is missing with no_plugin_host", "[playback][plugin]") {
    Fixture f;
    f.exec(R"({"op":"plugin.insert","trackId":"trk_a","index":0,"slotId":"slt_v","descriptor":{"format":"vst3","uid":"x"},"stateBlob":null})");
    host::ClapPluginHost host;
    Live live(f.session, pluginOptions(host));
    const auto status = live.engine.plugins().status("slt_v");
    REQUIRE(status.has_value());
    CHECK_FALSE(status->running);
    CHECK(status->error->code == "no_plugin_host");
}

TEST_CASE("plugin table: a state blob loads, and a missing one loads the default state", "[playback][plugin]") {
    Fixture f;
    host::ClapPluginHost host;
    const std::string hash = writeBlob(host, f.bundle(), 0.25);
    f.exec(insertSlot("slt_s", "trk_a", SIANN_TEST_PLUGIN_CLAP, "\"" + hash + "\""));
    f.exec(insertSlot("slt_d", "trk_b", SIANN_TEST_PLUGIN_CLAP, "\"sha256:" + std::string(64, 'f') + "\""));
    Live live(f.session, pluginOptions(host));
    PluginInstanceTable& table = live.engine.plugins();
    host::PluginInstance* loaded = table.instance("slt_s");
    REQUIRE(loaded != nullptr);
    CHECK(loaded->control().getParameter(parameterIndex(*loaded, "gain")) == Approx(0.25));
    CHECK(table.status("slt_s")->running);
    CHECK_FALSE(table.status("slt_s")->error.has_value());

    host::PluginInstance* fresh = table.instance("slt_d");
    REQUIRE(fresh != nullptr);
    CHECK(fresh->control().getParameter(parameterIndex(*fresh, "gain")) == Approx(1.0));
    const auto status = table.status("slt_d");
    CHECK(status->running);
    REQUIRE(status->error.has_value());
    CHECK(status->error->code == "state_missing");
}

TEST_CASE("plugin table: set_bypass recompiles and keeps the instance", "[playback][plugin]") {
    Fixture f;
    host::ClapPluginHost host;
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP));
    Live live(f.session, pluginOptions(host));
    pump(live, host, 4);
    host::PluginInstance* instance = live.engine.plugins().instance("slt_1");
    const std::size_t compiles = live.engine.compileCount();
    edit(f, live, R"({"op":"plugin.set_bypass","slotId":"slt_1","bypass":true})");
    pump(live, host, 6);
    CHECK(live.engine.compileCount() == compiles + 1);
    CHECK(live.engine.plugins().instance("slt_1") == instance);
    const std::uint64_t callbacks = live.engine.plugins().status("slt_1")->callbacks;
    pump(live, host, 4);
    CHECK(live.engine.plugins().status("slt_1")->callbacks == callbacks);  // bypassed: not called
}

TEST_CASE("plugin table: a removed slot's instance goes once its graph retired", "[playback][plugin]") {
    Fixture f;
    host::ClapPluginHost host;
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP));
    Live live(f.session, pluginOptions(host));
    pump(live, host, 4);
    f.exec(R"({"op":"plugin.remove","slotId":"slt_1"})");
    live.engine.update(f.doc());
    live.engine.tick();  // compiles and sends the new graph; the old one still plays
    CHECK(live.engine.plugins().instance("slt_1") != nullptr);
    pump(live, host, 6);
    CHECK(live.engine.plugins().instance("slt_1") == nullptr);
    CHECK(live.engine.plugins().size() == 0);
}

TEST_CASE("plugin table: a reused slot id with another state loads it while the old graph pins the id",
          "[playback][plugin]") {
    Fixture f;
    host::ClapPluginHost host;
    const std::string quiet = writeBlob(host, f.bundle(), 0.25);
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP));
    Live live(f.session, pluginOptions(host));
    PluginInstanceTable& table = live.engine.plugins();
    pump(live, host, 4);
    host::PluginInstance* old = table.instance("slt_1");
    REQUIRE(old != nullptr);
    CHECK(old->control().getParameter(parameterIndex(*old, "gain")) == Approx(1.0));

    // The same id comes back with another state in one update: the playing
    // graph still pins slt_1 when the next one is compiled.
    f.exec(R"({"op":"plugin.remove","slotId":"slt_1"})");
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP, "\"" + quiet + "\""));
    live.engine.update(f.doc());
    live.engine.tick();
    host::PluginInstance* reloaded = table.instance("slt_1");
    REQUIRE(reloaded != nullptr);
    CHECK(reloaded != old);
    CHECK(reloaded->control().getParameter(parameterIndex(*reloaded, "gain")) == Approx(0.25));
    CHECK(table.status("slt_1")->callbacks == 0);  // a new entry, its own counters
    pump(live, host, 8);
    CHECK(table.instance("slt_1") == reloaded);
    CHECK(table.status("slt_1")->callbacks > 0);
    CHECK(table.pins("slt_1") == 1);
    CHECK(table.size() == 1);
    // What plays is the new state.
    CHECK(matches(live, offline(f.doc(), f.bundle(), framesOf(live)), live.blockCount() - 4, live.blockCount()));
}

TEST_CASE("plugin table: an instance adopted under a pinned slot id replaces the old one", "[playback][plugin]") {
    Fixture f;
    host::ClapPluginHost host;
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP));
    Live live(f.session, pluginOptions(host));
    PluginInstanceTable& table = live.engine.plugins();
    pump(live, host, 4);
    host::PluginInstance* old = table.instance("slt_1");
    REQUIRE(old != nullptr);
    f.exec(R"({"op":"plugin.remove","slotId":"slt_1"})");
    live.engine.update(f.doc());
    live.engine.tick();  // the graph without slt_1 is out; the old one still pins it

    // plugin.instantiate loaded another plugin for the same id.
    host::PluginDescriptor descriptor;
    descriptor.format = "clap";
    descriptor.uid = "org.siann.test-plugin";
    descriptor.path = SIANN_TEST_PLUGIN_CLAP;
    auto fresh = host.instantiate(descriptor, 48'000, kBlock);
    fresh->control().setParameter(parameterIndex(*fresh, "gain"), 0.5);
    host.runMainThreadCallbacks();
    host::PluginInstance* adopted = fresh.get();
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP));
    table.adopt(*f.doc().pluginSlot("slt_1"), std::move(fresh));
    REQUIRE(table.instance("slt_1") == adopted);
    live.engine.update(f.doc());
    pump(live, host, 8);
    REQUIRE(table.instance("slt_1") == adopted);
    CHECK(adopted->control().getParameter(parameterIndex(*adopted, "gain")) == Approx(0.5));
    CHECK(table.status("slt_1")->callbacks > 0);
    CHECK(table.size() == 1);
}

TEST_CASE("plugin table: a restart to a new latency recompiles and PDC still lines up", "[playback][plugin][pdc]") {
    Fixture f;
    host::ClapPluginHost host;
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP));
    Live live(f.session, pluginOptions(host));
    pump(live, host, 4);
    host::PluginInstance* instance = live.engine.plugins().instance("slt_1");
    instance->control().setParameter(parameterIndex(*instance, "latency"), 1.0);
    REQUIRE(eventually([&] {
        pump(live, host, 1);
        return instance->latencyFrames() == 512 && live.engine.driver().liveGraph() != nullptr &&
               live.engine.driver().liveGraph()->totalLatency() == 512;
    }));
    CHECK(live.engine.plugins().instance("slt_1") == instance);
    CHECK(live.engine.plugins().status("slt_1")->latencyFrames == 512);
    CHECK(live.engine.plugins().restartsSeen() >= 1);
    // Settled: the output is the plugin-free render, 512 frames late, on both tracks.
    pump(live, host, 40);
    const int from = live.blockCount() - 16;
    const auto reference = offline(f.doc(), f.bundle(), framesOf(live));
    bool aligned = true;
    for (int c = 0; c < 2; ++c) {
        for (int i = from * kBlock; i < live.blockCount() * kBlock; ++i) {
            const float expected = reference[static_cast<std::size_t>(c)][static_cast<std::size_t>(i - 512)];
            aligned = aligned && live.out[static_cast<std::size_t>(c)][static_cast<std::size_t>(i)] == expected;
        }
    }
    CHECK(aligned);
}

TEST_CASE("plugin table: a full event queue resyncs the entry on the next tick", "[playback][plugin]") {
    Fixture f;
    host::ClapPluginHost host;
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP));
    PlaybackOptions options = pluginOptions(host);
    options.pluginEventCapacity = 2;  // the smallest queue
    Live live(f.session, options);
    pump(live, host, 2);
    host::PluginInstance* instance = live.engine.plugins().instance("slt_1");
    // Each restart to a new latency reports restartRequested and latencyChanged.
    // Two restarts before the engine's next tick overflow the queue.
    const int latency = parameterIndex(*instance, "latency");
    for (const double value : {1.0, 0.0}) {
        instance->control().setParameter(latency, value);
        const int wanted = value > 0.5 ? 512 : 64;
        REQUIRE(eventually([&] {
            live.device.pumpAll(1, live.out);
            host.runMainThreadCallbacks();
            return instance->latencyFrames() == wanted;
        }));
    }
    CHECK(live.engine.plugins().resyncs() == 0);
    live.engine.tick();
    CHECK(live.engine.plugins().resyncs() == 1);
    CHECK(live.engine.plugins().status("slt_1")->latencyFrames == 64);
    live.engine.tick();
    CHECK(live.engine.plugins().resyncs() == 1);  // the flag is cleared
}

TEST_CASE("plugin table: holdProcessBlock is an xrun of the driver and of that instance only", "[playback][plugin][timing]") {
    Fixture f;
    host::ClapPluginHost host;
    f.exec(insertSlot("slt_slow", "trk_a", SIANN_TEST_PLUGIN_CLAP));
    f.exec(insertSlot("slt_fast", "trk_b", SIANN_TEST_PLUGIN_CLAP));
    Live live(f.session, pluginOptions(host));
    pump(live, host, 2);
    host::PluginInstance* slow = live.engine.plugins().instance("slt_slow");
    slow->control().setParameter(parameterIndex(*slow, "holdProcessBlock"), 1.0);
    pump(live, host, 1);  // delivers the value
    const std::uint64_t misses = live.engine.driver().callbackTiming().misses();
    pump(live, host, 4);  // each block holds 20 ms against a 5.3 ms period
    CHECK(live.engine.driver().callbackTiming().misses() >= misses + 4);
    CHECK(live.engine.plugins().status("slt_slow")->xruns >= 4);
    CHECK(live.engine.plugins().status("slt_slow")->maxCallbackNanos >= 20'000'000);
    CHECK(live.engine.plugins().status("slt_fast")->xruns == 0);
    CHECK(live.engine.plugins().status("slt_fast")->callbacks == live.engine.plugins().status("slt_slow")->callbacks);
}

TEST_CASE("plugin table: blocks are coming while the device runs", "[playback][plugin]") {
    Fixture f;
    host::ClapPluginHost host;
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP));
    host::FakeAudioDevice device(host::FakeAudioDevice::Options{true});
    PlaybackOptions options = pluginOptions(host);
    options.butlerThread = true;
    PlaybackEngine engine(f.session, options);
    engine.load();
    CHECK(engine.plugins().blocksComingTold("slt_1") == std::optional<bool>{});
    engine.start(device, deviceConfig());
    CHECK(engine.plugins().blocksComingTold("slt_1") == std::optional<bool>{true});
    host::PluginInstance* instance = engine.plugins().instance("slt_1");
    instance->control().setParameter(parameterIndex(*instance, "watchSave"), 1.0);
    REQUIRE(eventually([&] {
        host.runMainThreadCallbacks();
        engine.tick();
        return device.callbacks() > 8;
    }));

    // A slot added while the device runs is told at once.
    f.exec(insertSlot("slt_2", "trk_b", SIANN_TEST_PLUGIN_CLAP));
    engine.update(f.doc());
    REQUIRE(eventually([&] {
        host.runMainThreadCallbacks();
        engine.tick();
        return engine.plugins().instance("slt_2") != nullptr && engine.plugins().pins("slt_2") > 0;
    }));
    CHECK(engine.plugins().blocksComingTold("slt_2") == std::optional<bool>{true});

    // getState during playback waits for a block and pauses nothing.
    const std::int64_t before = device.callbacks();
    const auto state = instance->control().getState();
    CHECK_FALSE(state.empty());
    CHECK(instance->control().getParameter(parameterIndex(*instance, "savedWhileProcessing")) > 0.5);
    REQUIRE(eventually([&] { return device.callbacks() > before + 4; }));
    CHECK(engine.driver().state() == realtime::DriverState::realtime);

    engine.stop();
    CHECK(engine.plugins().blocksComingTold("slt_1") == std::optional<bool>{false});
    CHECK(engine.plugins().blocksComingTold("slt_2") == std::optional<bool>{false});
}

TEST_CASE("plugin table: restarts asked for from the audio thread leave it running", "[playback][plugin]") {
    Fixture f;
    host::ClapPluginHost host;
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP));
    host::FakeAudioDevice device(host::FakeAudioDevice::Options{true});
    PlaybackOptions options = pluginOptions(host);
    options.butlerThread = true;
    PlaybackEngine engine(f.session, options);
    engine.load();
    engine.start(device, deviceConfig());
    host::PluginInstance* instance = engine.plugins().instance("slt_1");
    REQUIRE(eventually([&] { return device.callbacks() > 4; }));
    // The plugin asks inside process() (the audio thread); the restart runs in
    // runMainThreadCallbacks and reports latencyChanged from there.
    instance->control().setParameter(parameterIndex(*instance, "requestRestart"), 1.0);
    instance->control().setParameter(parameterIndex(*instance, "latency"), 1.0);
    REQUIRE(eventually([&] {
        host.runMainThreadCallbacks();
        engine.tick();
        return instance->latencyFrames() == 512 &&
               instance->control().getParameter(parameterIndex(*instance, "restarted")) > 0.5;
    }));
    const std::int64_t before = device.callbacks();
    REQUIRE(eventually([&] {
        host.runMainThreadCallbacks();
        engine.tick();
        return device.callbacks() > before + 8;
    }));
    CHECK(engine.driver().state() == realtime::DriverState::realtime);
    CHECK(engine.plugins().restartsSeen() >= 1);
    engine.stop();
}

TEST_CASE("plugin table: a render drives its own instances beside the live graph", "[playback][plugin][render]") {
    Fixture f;
    host::ClapPluginHost host;
    const std::string hash = writeBlob(host, f.bundle(), 0.5);
    f.exec(insertSlot("slt_1", "trk_a", SIANN_TEST_PLUGIN_CLAP, "\"" + hash + "\""));
    host::FakeAudioDevice device(host::FakeAudioDevice::Options{true});
    PlaybackOptions options = pluginOptions(host);
    options.butlerThread = true;
    PlaybackEngine engine(f.session, options);
    engine.load();
    engine.start(device, deviceConfig());
    REQUIRE(eventually([&] { return device.callbacks() > 4; }));

    // Instantiated on this thread from the slots' blobs, driven on another.
    auto set = std::make_unique<RenderInstanceSet>(f.doc(), options.pluginHosts, f.bundle(), kBlock);
    host::PluginInstance* rendering = set->instance("slt_1");
    REQUIRE(rendering != nullptr);
    CHECK(rendering != engine.plugins().instance("slt_1"));
    CHECK(rendering->control().getParameter(parameterIndex(*rendering, "gain")) == Approx(0.5));
    media::AudioBuffer rendered;
    std::atomic<bool> done{false};
    const Document snapshot = f.doc();
    const auto library = engine::loadMedia(snapshot, f.bundle());
    std::thread render([&] {
        auto graph = engine::compileDocument(snapshot, library, kBlock, set.get());
        rendered = engine::renderGraph(*graph, 0, 48'000, 48'000);
        done.store(true);
    });
    while (!done.load()) {
        host.runMainThreadCallbacks();
        engine.tick();
        std::this_thread::yield();
    }
    render.join();
    CHECK(rendered.info.frames == 48'000);
    host::PluginInstance* live = engine.plugins().instance("slt_1");
    const int concurrent = parameterIndex(*live, "concurrentProcess");
    CHECK(live->control().getParameter(concurrent) * 4.0 == Approx(1.0));
    CHECK(rendering->control().getParameter(concurrent) * 4.0 == Approx(1.0));
    set.reset();  // back on the control thread
    engine.stop();
}
