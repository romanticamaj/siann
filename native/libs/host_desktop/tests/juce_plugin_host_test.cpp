// Hosting tests (M0 plugin-set gate). siann_test_plugin, built by CI, is a known
// delay, so latency reporting is checked against audio, not only against a
// number. The third-party plugins named by SIANN_TEST_VST3 and SIANN_TEST_AU run
// on the maintainer's machines and skip elsewhere. Test names start with
// "plugin host:" so `ctest -R "plugin host"` selects them.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

#include "hosting_checks.hpp"
#include "siann/host/clap_plugin_host.hpp"
#include "siann/host/juce_plugin_host.hpp"

#if defined(_WIN32)
#include <windows.h>
#endif

using namespace siann;
using namespace siann::hosting_test;
using Catch::Approx;

namespace {

Pump pumpOf(host::MainThreadLoop& loop) {
    return [&loop](const std::function<bool()>& predicate) { return loop.runUntil(predicate, eventTimeout); };
}

host::PluginDescriptor testPlugin(host::JucePluginHost& host) {
    const auto descriptors = host.scanPath(SIANN_TEST_PLUGIN_VST3);
    REQUIRE(descriptors.size() == 1);
    return descriptors.front();
}

std::unique_ptr<host::PluginInstance> loadTestPlugin(host::JucePluginHost& host) {
    return host.instantiate(testPlugin(host), sampleRate, blockFrames);
}

// A copy of the test plugin in a directory of its own, a second install.
std::filesystem::path installCopy(const std::string& directoryName) {
    const auto directory = std::filesystem::temp_directory_path() / directoryName;
    std::error_code ignored;
    std::filesystem::remove_all(directory, ignored);  // an earlier run's copy
    std::filesystem::create_directories(directory);
    const std::filesystem::path original(SIANN_TEST_PLUGIN_VST3);
    const auto copy = directory / original.filename();
    std::filesystem::copy(original, copy, std::filesystem::copy_options::recursive);
    return copy;
}

// The directory of the bundle the loaded code really came from, which the plugin
// reads from its own module and puts in a parameter's name.
std::string loadedFrom(host::PluginInstance& instance) {
    for (const auto& parameter : instance.control().parameters()) {
        if (parameter.name.rfind("home:", 0) == 0) {
            return parameter.name.substr(5);
        }
    }
    FAIL("the plugin has no home parameter");
    return {};
}

std::optional<std::string> environment(const char* name) {
#if defined(_MSC_VER)
    char* value = nullptr;
    std::size_t size = 0;
    if (_dupenv_s(&value, &size, name) != 0 || value == nullptr) {
        return std::nullopt;
    }
    std::string result(value);
    std::free(value);
#else
    const char* value = std::getenv(name);
    if (value == nullptr) {
        return std::nullopt;
    }
    std::string result(value);
#endif
    if (result.empty()) {
        return std::nullopt;
    }
    return result;
}

// What every plugin SIANN did not build has to do: load, keep its state and open
// its editor. State is compared by parameter values: third-party blobs are opaque
// and need not repeat. A runtime latency change is siann_test_plugin's to prove:
// no parameter of TDR Nova moves its latency.
void checkThirdParty(host::JucePluginHost& host, const host::PluginDescriptor& descriptor) {
    REQUIRE(descriptor.hasEditor);
    auto instance = host.instantiate(descriptor, sampleRate, blockFrames);
    const auto parameters = instance->control().parameters();
    REQUIRE_FALSE(parameters.empty());

    // The first automatable parameter that accepts a new value. The far end of its
    // range, because a stepped parameter snaps anything between steps.
    int changed = -1;
    double changedTo = 0.0;
    for (std::size_t i = 0; i < parameters.size() && changed < 0; ++i) {
        if (!parameters[i].automatable) {
            continue;
        }
        const int index = static_cast<int>(i);
        const double before = instance->control().getParameter(index);
        instance->control().setParameter(index, before < 0.5 ? 1.0 : 0.0);
        if (std::abs(instance->control().getParameter(index) - before) > 1e-3) {
            changed = index;
            changedTo = instance->control().getParameter(index);
        }
    }
    REQUIRE(changed >= 0);
    runBlocks(*instance);

    std::vector<double> expected;
    for (std::size_t i = 0; i < parameters.size(); ++i) {
        expected.push_back(instance->control().getParameter(static_cast<int>(i)));
    }
    const auto state = instance->control().getState();
    CHECK_FALSE(state.empty());

    auto restored = host.instantiate(descriptor, sampleRate, blockFrames);
    CHECK(std::abs(restored->control().getParameter(changed) - changedTo) > 1e-3);
    restored->control().setState(state);
    for (std::size_t i = 0; i < parameters.size(); ++i) {
        if (parameters[i].automatable) {
            INFO("parameter " << parameters[i].name);
            CHECK(restored->control().getParameter(static_cast<int>(i)) == Approx(expected[i]).margin(1e-3));
        }
    }

    if (displayAvailable()) {
        restored->control().openEditor({});
        CHECK(restored->control().editorOpen());
        CHECK(restored->control().editorNativeHandle() != 0);
        restored->control().closeEditor();
        CHECK_FALSE(restored->control().editorOpen());
    }
}

// A maintainer plugin also has its latency checked against audio, on a new instance
// because its defaults pass an impulse through whole; a limiter need not.
void checkMaintainerPlugin(host::JucePluginHost& host, const host::PluginDescriptor& descriptor) {
    auto instance = host.instantiate(descriptor, sampleRate, blockFrames);
    const auto measured = measureDelay(*instance);
    CHECK(measured.peak > 0.5f);
    CHECK(measured.frames == instance->latencyFrames());
    checkThirdParty(host, descriptor);
}

// The named bundle's plugin, or a skip when the variable is unset. A variable that
// points nowhere is a broken setup, not a skip.
std::optional<host::PluginDescriptor> maintainerPlugin(host::JucePluginHost& host, const char* variable) {
    const auto path = environment(variable);
    if (!path) {
        return std::nullopt;
    }
    if (!std::filesystem::exists(std::filesystem::path(*path))) {
        FAIL(variable << " points at a missing file: " << *path);
    }
    const auto descriptors = host.scanPath(*path);
    REQUIRE_FALSE(descriptors.empty());
    return descriptors.front();
}

}  // namespace

TEST_CASE("plugin host: the CI-built test plugin is found by path", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto descriptors = host.scanPath(SIANN_TEST_PLUGIN_VST3);
    REQUIRE(descriptors.size() == 1);
    const auto& plugin = descriptors.front();
    CHECK(plugin.format == "vst3");
    CHECK(plugin.name == "SIANN Test Plugin");
    CHECK(plugin.vendor == "SIANN");
    CHECK(plugin.version == "1.0.0");
    CHECK(plugin.path == SIANN_TEST_PLUGIN_VST3);
    CHECK_FALSE(plugin.uid.empty());
    CHECK(plugin.hasEditor);

    try {
        host.scanPath(std::string(SIANN_TEST_PLUGIN_VST3) + ".missing");
        FAIL("a missing path must throw");
    } catch (const host::PluginError& error) {
        CHECK(error.code() == "plugin_not_found");
    }
}

TEST_CASE("plugin host: a plugin keeps its uid and its state when it moves", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto moved = installCopy("siann-plugin-host-moved");

    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    instance->control().setParameter(gain, 0.25);
    const auto state = instance->control().getState();

    const auto descriptors = host.scanPath(moved.string());
    REQUIRE(descriptors.size() == 1);
    CHECK(descriptors.front().uid == testPlugin(host).uid);  // the original is the last one scanned
    auto restored = host.instantiate(descriptors.front(), sampleRate, blockFrames);
    CHECK(loadedFrom(*restored) == "siann-plugin-host-moved");
    restored->control().setState(state);
    CHECK(restored->control().getParameter(gain) == Approx(0.25));
}

TEST_CASE("plugin host: two installs of one plugin each load their own bundle", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto copy = installCopy("siann-plugin-host-second");

    const auto original = testPlugin(host);
    const auto second = host.scanPath(copy.string()).front();
    REQUIRE(original.uid == second.uid);
    REQUIRE(original.path != second.path);
    const auto first = host.instantiate(original, sampleRate, blockFrames);
    CHECK(loadedFrom(*first) != "siann-plugin-host-second");
    CHECK(loadedFrom(*host.instantiate(second, sampleRate, blockFrames)) == "siann-plugin-host-second");
    CHECK(loadedFrom(*host.instantiate(original, sampleRate, blockFrames)) == loadedFrom(*first));
}

TEST_CASE("plugin host: a stale path fails instead of loading another install", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto gone = testPlugin(host);  // its uid is known from here on
    gone.path += ".gone";
    try {
        host.instantiate(gone, sampleRate, blockFrames);
        FAIL("a path that is gone must throw");
    } catch (const host::PluginError& error) {
        CHECK(error.code() == "plugin_not_found");
    }
}

TEST_CASE("plugin host: a descriptor without a path needs exactly one known install", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto unplaced = testPlugin(host);
    unplaced.path.clear();
    CHECK(host.instantiate(unplaced, sampleRate, blockFrames) != nullptr);

    host.scanPath(installCopy("siann-plugin-host-ambiguous").string());
    try {
        host.instantiate(unplaced, sampleRate, blockFrames);
        FAIL("two known installs must not be picked from");
    } catch (const host::PluginError& error) {
        CHECK(error.code() == "plugin_not_found");
    }
}

// m5-plugin-registry: the engine's --plugin-dir directories, listed beside the
// default locations without loading anything.
TEST_CASE("plugin host: scan lists extra directories without probing them", "[juce][plugin][registry]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto copy = installCopy("siann-plugin-host-plugin-dir");
    const auto listed = host.scan({copy.parent_path().string()});
    const auto found = std::find_if(listed.begin(), listed.end(), [&](const host::PluginDescriptor& descriptor) {
        return descriptor.format == "vst3" &&
               std::filesystem::weakly_canonical(std::filesystem::path(descriptor.path)) ==
                   std::filesystem::weakly_canonical(copy);
    });
    REQUIRE(found != listed.end());
    CHECK(found->uid.empty());  // nothing was probed
    CHECK(found->vendor.empty());
}

TEST_CASE("plugin host: a descriptor that only names a path instantiates", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    host::PluginDescriptor listed;  // what scan() gives
    listed.format = "vst3";
    listed.path = SIANN_TEST_PLUGIN_VST3;
    auto instance = host.instantiate(listed, sampleRate, blockFrames);
    CHECK(instance->latencyFrames() == 64);

    listed.path += ".missing";
    try {
        host.instantiate(listed, sampleRate, blockFrames);
        FAIL("a missing path must throw");
    } catch (const host::PluginError& error) {
        CHECK(error.code() == "plugin_not_found");
    }
}

TEST_CASE("plugin host: a file that holds no plugin does not load", "[juce][plugin]") {
#if defined(_WIN32)
    // Windows answers a bad image with a modal error box nobody can click in a
    // headless engine. Git Bash and MSYS hand their children a mode that hides the
    // box, so a shell run proves nothing: start from the default, as the shell's
    // spawn of the engine does.
    SetErrorMode(0);
#endif
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto path = std::filesystem::temp_directory_path() / "siann-not-a-plugin.vst3";
    std::ofstream(path, std::ios::binary).close();
    REQUIRE(std::filesystem::exists(path));
    try {
        host.scanPath(path.string());
        FAIL("an empty file must throw");
    } catch (const host::PluginError& error) {
        CHECK(error.code() == "plugin_load_failed");
    }
    std::filesystem::remove(path);
}

TEST_CASE("plugin host: instantiate on the main thread, process on the audio thread", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);

    const auto capabilities = instance->capabilities();
    CHECK(capabilities.editor);
    CHECK(capabilities.variableLatency);
    CHECK_FALSE(capabilities.midiInput);
    CHECK(capabilities.midiOutput);  // midiFlood (m4-plugin-node)
    CHECK_FALSE(capabilities.sidechain);
    CHECK(instance->tailFrames() == 0);
    CHECK(instance->latencyFrames() == 64);

    const auto measured = measureDelay(*instance);
    CHECK(measured.frames == 64);
    CHECK(measured.peak == Approx(1.0f));
    CHECK(measured.allocations == 0);
}

TEST_CASE("plugin host: the CI-built VST3 passes the whole hosting check", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    checkBuiltTestPlugin(pumpOf(loop), host, testPlugin(host));
}

// The desktop half of ClapPluginHost's acceptance: one process holds both hosts, and
// their plugins run on the audio thread together.
TEST_CASE("plugin host: a CLAP and a VST3 instance process side by side", "[juce][clap][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost vst3Host;
    host::ClapPluginHost clapHost;
    auto vst3 = loadTestPlugin(vst3Host);
    const auto clapDescriptors = clapHost.scanPath(SIANN_TEST_PLUGIN_CLAP);
    REQUIRE(clapDescriptors.size() == 1);
    auto clap = clapHost.instantiate(clapDescriptors.front(), sampleRate, blockFrames);

    for (auto* instance : {vst3.get(), clap.get()}) {
        const auto measured = measureDelay(*instance);
        CHECK(measured.frames == 64);
        CHECK(measured.peak == Approx(1.0f));
        CHECK(measured.allocations == 0);
    }

    PlayingThread playingVst3(*vst3);
    PlayingThread playingClap(*clap);
    REQUIRE(loop.runUntil([&] { return playingVst3.blocks() >= 16 && playingClap.blocks() >= 16; }, eventTimeout));
    CHECK(playingVst3.finish() == 0);
    CHECK(playingClap.finish() == 0);
}

// VST3 forbids process during setActive, and that is what the one lock JUCE takes
// per block is for (spec, "Locks inside a hosted plugin's processBlock"). The
// plugin spends time in setActive and watches for processBlock meanwhile.
TEST_CASE("plugin host: a VST3 restart during playback keeps setActive and process apart", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    const int restarted = parameterIndex(*instance, "restarted");
    const int overlapped = parameterIndex(*instance, "overlapped");

    PlayingThread playing(*instance);
    const auto ranAtLeast = [&](std::uint64_t count) {
        return loop.runUntil([&] { return playing.blocks() >= count; }, eventTimeout);
    };
    REQUIRE(ranAtLeast(16));

    instance->control().setParameter(parameterIndex(*instance, "requestRestart"), 1.0);
    REQUIRE(loop.runUntil([&] { return instance->control().getParameter(restarted) > 0.5; }, eventTimeout));
    REQUIRE(ranAtLeast(playing.blocks() + 16));

    CHECK(playing.finish() == 0);
    CHECK(instance->control().getParameter(overlapped) < 0.5);
    CHECK(measureDelay(*instance).frames == 64);
}

TEST_CASE("plugin host: process runs while the main thread does everything else", "[juce][plugin]") {
    if (!displayAvailable()) {
        SKIP("no display: set DISPLAY or run under xvfb-run");
    }
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    const int latency = parameterIndex(*instance, "latency");
    const int gain = parameterIndex(*instance, "gain");

    PlayingThread playing(*instance);
    for (int round = 0; round < 8; ++round) {
        const int frames = round % 2 == 0 ? 512 : 64;
        instance->control().setParameter(latency, frames == 512 ? 1.0 : 0.0);
        REQUIRE(loop.runUntil([&] { return instance->latencyFrames() == frames; }, eventTimeout));
        instance->control().setParameter(gain, 0.25);
        const auto state = instance->control().getState();
        instance->control().setParameter(gain, 0.75);
        instance->control().setState(state);
        CHECK(instance->control().getParameter(gain) == Approx(0.25));
        instance->control().openEditor({});
        instance->control().closeEditor();
    }
    const auto ran = playing.blocks();
    REQUIRE(loop.runUntil([&] { return playing.blocks() > ran; }, eventTimeout));
    CHECK(playing.finish() == 0);
}

// A value on its way to the processor when setState starts could land after the
// restore and silently win. JUCE reads pending values into a block and hands them
// over inside process, which no test can stop between the two, so what is checked
// is what rules that out: no process call meets a restore. The plugin spends time
// in setStateInformation and watches for processBlock meanwhile.
TEST_CASE("plugin host: a state restore during playback keeps setState and process apart", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    const int restored = parameterIndex(*instance, "restored");
    instance->control().setParameter(gain, 0.25);
    const auto state = instance->control().getState();
    instance->control().setParameter(parameterIndex(*instance, "watchRestore"), 1.0);

    PlayingThread playing(*instance);
    const auto ranAtLeast = [&](std::uint64_t count) {
        return loop.runUntil([&] { return playing.blocks() >= count; }, eventTimeout);
    };
    REQUIRE(ranAtLeast(16));

    instance->control().setParameter(gain, 0.75);
    instance->control().setState(state);
    REQUIRE(loop.runUntil([&] { return instance->control().getParameter(restored) > 0.5; }, eventTimeout));
    REQUIRE(ranAtLeast(playing.blocks() + 16));

    CHECK(playing.finish() == 0);
    CHECK(instance->control().getParameter(parameterIndex(*instance, "overlapped")) < 0.5);
    CHECK(instance->control().getParameter(gain) == Approx(0.25));
    CHECK(measureDelay(*instance).peak == Approx(0.25f));  // what the processor holds
}

// tailFrames() is an any-thread read, and the format's own call is not: VST3 keeps
// getTailSamples to the UI thread, which the test plugin answers wrongly elsewhere.
TEST_CASE("plugin host: the audio thread reads the tail without calling the plugin", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    CHECK(tailFramesOnAudioThread(*instance) == 0);

    instance->control().setParameter(parameterIndex(*instance, "latency"), 1.0);
    REQUIRE(loop.runUntil([&] { return instance->tailFrames() == longTailFrames; }, eventTimeout));
    CHECK(tailFramesOnAudioThread(*instance) == longTailFrames);
}

TEST_CASE("plugin host: a restored state brings its tail", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    instance->control().setParameter(parameterIndex(*instance, "latency"), 1.0);
    REQUIRE(loop.runUntil([&] { return instance->latencyFrames() == 512; }, eventTimeout));
    const auto state = instance->control().getState();

    auto restored = loadTestPlugin(host);
    CHECK(restored->tailFrames() == 0);
    restored->control().setState(state);
    // On return. Here the restore also changes the latency, and that report (a
    // kLatencyChanged restart, run on this thread inside setState) refreshes the
    // tail too; the test below is the one that needs setState's own read.
    CHECK(restored->tailFrames() == longTailFrames);
}

// A tail the latency report does not announce: "tail" is state and changes no
// latency. What brings it here is JUCE's own plugin-side controller, whose
// setComponentState ends in restartComponent(kParamValuesChanged), which the host
// turns into a programChanged report and the adapter into a tail read; so the
// adapter's own read after setState is not what this test exercises through VST3
// (removing it passes here: the mutant survives on Windows and Linux). A hosted AU
// reports nothing synchronously after setState, so checkBuiltTestPlugin's tail
// check on macOS is the one that stands on that read.
TEST_CASE("plugin host: a restored state brings a tail its latency does not announce", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    instance->control().setParameter(parameterIndex(*instance, "tail"), 1.0);
    const auto state = instance->control().getState();

    auto restored = loadTestPlugin(host);
    rt::MpscQueue<host::PluginEvent> events(64);
    restored->control().setEventSink([&](const host::PluginEvent& event) { events.push(event); });
    CHECK(restored->tailFrames() == 0);
    restored->control().setState(state);
    CHECK(restored->tailFrames() == longTailFrames);
    CHECK(restored->latencyFrames() == 64);
    loop.runUntil([] { return false; }, std::chrono::milliseconds(50));  // anything the restore queued
    host::PluginEvent event;
    while (events.pop(event)) {
        CHECK(event.kind != host::PluginEvent::Kind::latencyChanged);
    }
    CHECK(restored->tailFrames() == longTailFrames);
    restored->control().setEventSink(nullptr);
}

// The plugin holds every block open for restartWatch, so a restore that did not
// wait for the block in flight would run setStateInformation beside processBlock.
TEST_CASE("plugin host: a restore waits for a block the plugin holds open", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    const int restored = parameterIndex(*instance, "restored");
    instance->control().setParameter(gain, 0.25);
    const auto state = instance->control().getState();
    instance->control().setParameter(parameterIndex(*instance, "watchRestore"), 1.0);
    instance->control().setParameter(parameterIndex(*instance, "holdProcessBlock"), 1.0);

    PlayingThread playing(*instance);
    REQUIRE(loop.runUntil([&] { return playing.blocks() >= 2; }, eventTimeout));
    instance->control().setParameter(gain, 0.75);
    instance->control().setState(state);
    REQUIRE(loop.runUntil([&] { return instance->control().getParameter(restored) > 0.5; }, eventTimeout));
    REQUIRE(loop.runUntil([&] { return playing.blocks() >= 6; }, eventTimeout));

    CHECK(playing.finish() == 0);
    CHECK(instance->control().getParameter(parameterIndex(*instance, "overlapped")) < 0.5);
    CHECK(instance->control().getParameter(gain) == Approx(0.25));
}

// JUCE reports every restart's end as programChanged + parameterInfoChanged, which
// the adapter turns into restartRequested: a plugin-initiated reload, and a
// latency-only change as well, so the event means "read the plugin again", not
// "a setActive happened".
TEST_CASE("plugin host: a restart the plugin asks for reaches the sink as restartRequested", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    rt::MpscQueue<host::PluginEvent> events(64);
    instance->control().setEventSink([&](const host::PluginEvent& event) { events.push(event); });
    const auto nextRestartRequested = [&] {
        bool seen = false;
        loop.runUntil(
            [&] {
                host::PluginEvent event;
                while (events.pop(event)) {
                    seen = seen || event.kind == host::PluginEvent::Kind::restartRequested;
                }
                return seen;
            },
            eventTimeout);
        return seen;
    };

    instance->control().setParameter(parameterIndex(*instance, "requestRestart"), 1.0);
    CHECK(nextRestartRequested());
    REQUIRE(loop.runUntil(
        [&] { return instance->control().getParameter(parameterIndex(*instance, "restarted")) > 0.5; }, eventTimeout));
    CHECK(measureDelay(*instance).frames == 64);

    instance->control().setParameter(parameterIndex(*instance, "latency"), 1.0);
    REQUIRE(loop.runUntil([&] { return instance->latencyFrames() == 512; }, eventTimeout));
    CHECK(nextRestartRequested());  // a latency-only restart reports it too
    instance->control().setEventSink(nullptr);
}

TEST_CASE("plugin host: a block with fewer channels than the plugin still processes", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);

    const auto measured = measureDelay(*instance, 1);
    CHECK(measured.frames == 64);
    CHECK(measured.allocations == 0);
}

// maxPluginChannels (31; spec, PluginHost contract): juce::AudioBuffer holds that
// many channel pointers without allocating. siann_test_plugin's "buses" layout has
// 16 stereo output buses, 32 channels; the host is unharmed afterwards.
TEST_CASE("plugin host: a plugin with more than 31 channels fails to load", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto descriptor = testPlugin(host);
    {
        const ScopedEnvironment layout("SIANN_TEST_PLUGIN_LAYOUT", "buses");
        try {
            host.instantiate(descriptor, sampleRate, blockFrames);
            FAIL("a 32-channel plugin must not load");
        } catch (const host::PluginError& error) {
            CHECK(error.code() == "plugin_load_failed");
            CHECK(std::string(error.what()).find("more channels") != std::string::npos);
        }
    }
    auto instance = host.instantiate(descriptor, sampleRate, blockFrames);
    CHECK(measureDelay(*instance).frames == 64);
}

// Channels of the output view the plugin does not fill are cleared, not left as
// they were: the view may hold whatever the previous node wrote.
TEST_CASE("plugin host: output channels beyond the plugin's are cleared", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    Audio input(2, blockFrames);
    Audio output(4, blockFrames);
    for (int c = 0; c < 4; ++c) {
        output.channel(c).assign(static_cast<std::size_t>(blockFrames), 1.0f);
    }
    input.channel(0)[0] = 1.0f;
    std::thread audio([&] {
        const rt::ScopedRealtimeThread realtime;
        instance->process(input.view(), output.view(), {});
    });
    audio.join();
    CHECK(output.channel(0)[64] == Approx(1.0f));  // the delayed impulse: the plugin ran
    CHECK(output.channel(0)[0] == 0.0f);
    for (int c = 2; c < 4; ++c) {
        CHECK(*std::max_element(output.channel(c).begin(), output.channel(c).end()) == 0.0f);
    }
}

// A block longer than the instance was prepared for cannot be handed to the
// plugin (its buffers are sized once): the output is cleared instead. So is an
// empty block.
TEST_CASE("plugin host: a block longer than the maximum is cleared, not processed", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    Audio input(2, 2 * blockFrames);
    Audio output(2, 2 * blockFrames);
    for (int c = 0; c < 2; ++c) {
        input.channel(c).assign(static_cast<std::size_t>(2 * blockFrames), 1.0f);
        output.channel(c).assign(static_cast<std::size_t>(2 * blockFrames), 1.0f);
    }
    std::thread audio([&] {
        const rt::ScopedRealtimeThread realtime;
        instance->process(input.view(), output.view(), {});
        host::AudioBufferView empty = output.view();
        empty.frames = 0;
        instance->process(input.view(), empty, {});
    });
    audio.join();
    for (int c = 0; c < 2; ++c) {
        CHECK(*std::max_element(output.channel(c).begin(), output.channel(c).end()) == 0.0f);
    }
    CHECK(measureDelay(*instance).frames == 64);  // and the instance still works at its block size
}

TEST_CASE("plugin host: state round-trips as a blob", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    const int latency = parameterIndex(*instance, "latency");
    instance->control().setParameter(gain, 0.25);
    instance->control().setParameter(latency, 1.0);
    const auto state = instance->control().getState();
    REQUIRE(state.size() > 8);
    CHECK(std::string(state.begin(), state.begin() + 8) == "SIANNPS1");

    auto restored = loadTestPlugin(host);
    CHECK(restored->control().getParameter(gain) == Approx(1.0));
    restored->control().setState(state);
    CHECK(restored->control().getParameter(gain) == Approx(0.25));
    CHECK(restored->control().getParameter(latency) == Approx(1.0));
    REQUIRE(loop.runUntil([&] { return restored->latencyFrames() == 512; }, eventTimeout));
    CHECK(measureDelay(*restored).frames == 512);
}

TEST_CASE("plugin host: a blob of the wrong version, plugin or size changes nothing", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    instance->control().setParameter(gain, 0.25);
    const auto state = instance->control().getState();

    auto wrongVersion = state;
    wrongVersion[8] = static_cast<std::uint8_t>(wrongVersion[8] + 1);  // the u32 after the magic
    auto wrongPlugin = state;
    wrongPlugin[16] = static_cast<std::uint8_t>(wrongPlugin[16] ^ 0x20);  // the first byte of the uid
    auto truncated = state;
    truncated.pop_back();
    auto wrongMagic = state;
    wrongMagic[0] = 'X';

    auto target = loadTestPlugin(host);
    target->control().setParameter(gain, 0.75);
    for (const auto* blob : {&wrongVersion, &wrongPlugin, &truncated, &wrongMagic}) {
        try {
            target->control().setState(*blob);
            FAIL("a bad blob must throw");
        } catch (const host::PluginError& error) {
            CHECK(error.code() == "bad_state");
        }
        CHECK(target->control().getParameter(gain) == Approx(0.75));
    }
}

TEST_CASE("plugin host: a plugin that refuses its payload keeps its parameters", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    instance->control().setParameter(gain, 0.25);
    instance->control().setParameter(parameterIndex(*instance, "futureState"), 1.0);
    const auto state = instance->control().getState();

    auto target = loadTestPlugin(host);
    target->control().setParameter(gain, 0.75);
    target->control().setState(state);
    CHECK(target->control().getParameter(gain) == Approx(0.75));
    CHECK(target->latencyFrames() == 64);
}

TEST_CASE("plugin host: a runtime latency change is reported", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);

    rt::MpscQueue<host::PluginEvent> pluginEventAny(64);
    instance->control().setEventSink([&](const host::PluginEvent& event) { pluginEventAny.push(event); });
    CHECK(measureDelay(*instance).frames == 64);

    instance->control().setParameter(parameterIndex(*instance, "latency"), 1.0);
    int reported = -1;
    const bool seen = loop.runUntil(
        [&] {
            host::PluginEvent event;
            while (pluginEventAny.pop(event)) {
                if (event.kind == host::PluginEvent::Kind::latencyChanged) {
                    reported = event.latencyFrames;
                }
            }
            return reported >= 0;
        },
        eventTimeout);
    REQUIRE(seen);
    CHECK(reported == 512);
    CHECK(instance->latencyFrames() == 512);
    CHECK(measureDelay(*instance).frames == 512);
}

TEST_CASE("plugin host: an edit made by the plugin reaches the event sink", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");

    rt::MpscQueue<host::PluginEvent> pluginEventAny(64);
    instance->control().setEventSink([&](const host::PluginEvent& event) { pluginEventAny.push(event); });
    instance->control().setParameter(parameterIndex(*instance, "nudgeGain"), 1.0);

    double edited = -1.0;
    const bool seen = loop.runUntil(
        [&] {
            host::PluginEvent event;
            while (pluginEventAny.pop(event)) {
                if (event.kind == host::PluginEvent::Kind::parameterEdited && event.parameterIndex == gain) {
                    edited = event.value;
                }
            }
            return edited >= 0.0;
        },
        eventTimeout);
    REQUIRE(seen);
    CHECK(edited == Approx(0.5));
    CHECK(instance->control().getParameter(gain) == Approx(0.5));

    // After the sink is gone nothing calls it.
    instance->control().setEventSink(nullptr);
    instance->control().setParameter(parameterIndex(*instance, "latency"), 1.0);
    loop.runUntil([&] { return instance->latencyFrames() == 512; }, eventTimeout);
    host::PluginEvent event;
    while (pluginEventAny.pop(event)) {
        CHECK(event.kind != host::PluginEvent::Kind::latencyChanged);
    }
}

TEST_CASE("plugin host: the editor opens and closes", "[juce][plugin]") {
    if (!displayAvailable()) {
        SKIP("no display: set DISPLAY or run under xvfb-run");
    }
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);

    CHECK_FALSE(instance->control().editorOpen());
    CHECK(instance->control().editorNativeHandle() == 0);
    instance->control().openEditor({});
    CHECK(instance->control().editorOpen());
    const auto handle = instance->control().editorNativeHandle();
    CHECK(handle != 0);

    instance->control().openEditor({});  // idempotent: the same window
    CHECK(instance->control().editorNativeHandle() == handle);

    instance->control().closeEditor();
    CHECK_FALSE(instance->control().editorOpen());
    CHECK(instance->control().editorNativeHandle() == 0);
    instance->control().closeEditor();  // idempotent too

    instance->control().openEditor({});
    CHECK(instance->control().editorOpen());
    instance.reset();  // with the editor open
}

#if defined(_WIN32)
TEST_CASE("plugin host: editors are owned by the given window", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);

    HWND owner = CreateWindowExW(0, L"STATIC", L"SIANN test owner", WS_OVERLAPPEDWINDOW, 0, 0, 100, 100, nullptr,
                                 nullptr, GetModuleHandleW(nullptr), nullptr);
    REQUIRE(owner != nullptr);
    instance->control().openEditor({reinterpret_cast<std::uintptr_t>(owner)});
    auto* editor = reinterpret_cast<HWND>(instance->control().editorNativeHandle());
    REQUIRE(editor != nullptr);
    CHECK(GetWindow(editor, GW_OWNER) == owner);  // GW_OWNER reads GWLP_HWNDPARENT
    CHECK((GetWindowLongPtrW(editor, GWL_EXSTYLE) & WS_EX_TOPMOST) == 0);  // owned, so it need not float
    instance->control().closeEditor();
    CHECK_FALSE(IsWindow(editor));

    instance->control().openEditor({reinterpret_cast<std::uintptr_t>(owner)});
    editor = reinterpret_cast<HWND>(instance->control().editorNativeHandle());
    instance.reset();  // an instance closes its editor as it goes
    CHECK_FALSE(IsWindow(editor));
    DestroyWindow(owner);
}

TEST_CASE("plugin host: the window's close button closes the editor", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);

    instance->control().openEditor({});
    auto* editor = reinterpret_cast<HWND>(instance->control().editorNativeHandle());
    PostMessageW(editor, WM_CLOSE, 0, 0);
    REQUIRE(loop.runUntil([&] { return !instance->control().editorOpen(); }, eventTimeout));
    CHECK_FALSE(IsWindow(editor));

    // Pressed in the last moment of an instance's life.
    instance->control().openEditor({});
    editor = reinterpret_cast<HWND>(instance->control().editorNativeHandle());
    SendMessageW(editor, WM_CLOSE, 0, 0);
    instance.reset();
    loop.runUntil([] { return false; }, std::chrono::milliseconds(50));
}
#endif

TEST_CASE("plugin host: the maintainer's VST3 loads, keeps its state, reports latency and opens its editor",
          "[juce][plugin][thirdparty]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto plugin = maintainerPlugin(host, "SIANN_TEST_VST3");
    if (!plugin) {
        SKIP("set SIANN_TEST_VST3 to a .vst3 bundle");
    }
    CHECK(plugin->format == "vst3");
    checkMaintainerPlugin(host, *plugin);
}

#if defined(__APPLE__)
TEST_CASE("plugin host: the maintainer's AU loads, keeps its state, reports latency and opens its editor",
          "[juce][plugin][thirdparty]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto plugin = maintainerPlugin(host, "SIANN_TEST_AU");
    if (!plugin) {
        SKIP("set SIANN_TEST_AU to a .component bundle");
    }
    CHECK(plugin->format == "au");
    checkMaintainerPlugin(host, *plugin);
}

TEST_CASE("plugin host: Apple AUPeakLimiter loads in CI", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto plugins = host.scan();
    const auto limiter = std::find_if(plugins.begin(), plugins.end(), [](const host::PluginDescriptor& p) {
        return p.format == "au" && p.name == "AUPeakLimiter";
    });
    REQUIRE(limiter != plugins.end());
    const auto descriptors = host.scanPath(limiter->path);
    REQUIRE(descriptors.size() == 1);
    CHECK(descriptors.front().vendor == "Apple");
    checkThirdParty(host, descriptors.front());
}
#endif

TEST_CASE("plugin host: scan() lists the default locations without throwing", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto plugins = host.scan();  // may be empty on a Linux runner
    for (const auto& plugin : plugins) {
        CHECK_FALSE(plugin.format.empty());
        CHECK_FALSE(plugin.name.empty());
        CHECK_FALSE(plugin.path.empty());
        CHECK(plugin.uid.empty());  // nothing was loaded to learn it from
    }
}

// m4-plugin-node: a change reported off the message thread only marks the tail
// stale; the main thread reads it in pollStale. The adapter posts no message for
// it (juce::AsyncUpdater allocated one on the reporting thread).
TEST_CASE("plugin host: a change reported off the message thread leaves the tail to pollStale", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    rt::MpscQueue<host::PluginEvent> events(64);
    instance->control().setEventSink([&](const host::PluginEvent& event) { events.push(event); });
    instance->control().setParameter(parameterIndex(*instance, "tail"), 1.0);  // state; reports nothing
    runBlocks(*instance);
    loop.runUntil([] { return false; }, std::chrono::milliseconds(50));
    REQUIRE(instance->tailFrames() == 0);

    std::uint64_t allocations = 0;
    std::thread reporter([&] {
        const rt::ScopedRealtimeThread realtime;  // as from the audio thread
        const auto before = rt::allocationViolations();
        host::testing::reportProcessorChange(*instance, false, false, true);
        allocations = rt::allocationViolations() - before;
    });
    reporter.join();
    CHECK(allocations == 0);
    bool restartRequested = false;
    host::PluginEvent event;
    while (events.pop(event)) {
        restartRequested = restartRequested || event.kind == host::PluginEvent::Kind::restartRequested;
    }
    CHECK(restartRequested);

    loop.runUntil([] { return false; }, std::chrono::milliseconds(100));  // nothing was posted to read it
    CHECK(instance->tailFrames() == 0);
    instance->control().pollStale();
    CHECK(instance->tailFrames() == longTailFrames);
    instance->control().pollStale();  // once is enough; a second poll reads nothing new
    CHECK(instance->tailFrames() == longTailFrames);
    instance->control().setEventSink(nullptr);
}

// m4-plugin-node, MIDI output (ADR-0018, condition 3): the adapter's MidiBuffer is
// preallocated for Steinberg's 2048 events a block. JUCE's VST3 wrapper stops a
// plugin's output there, so a block that reached the limit is counted: that is
// where events are lost. JUCE's own lists may grow on the audio thread for such a
// plugin (accepted as plugin-caused), so this test does not count allocations.
TEST_CASE("plugin host: blocks whose MIDI output reaches 2048 events are counted", "[juce][plugin][midi]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    CHECK(instance->capabilities().midiOutput);
    runBlocks(*instance);
    CHECK(instance->midiOutputOverflows() == 0);

    instance->control().setParameter(parameterIndex(*instance, "midiFlood"), 1.0);
    runBlocks(*instance);
    const std::uint64_t flooded = instance->midiOutputOverflows();
    CHECK(flooded >= 3);
    CHECK(flooded <= 4);
    runBlocks(*instance);
    CHECK(instance->midiOutputOverflows() == flooded + 4);

    instance->control().setParameter(parameterIndex(*instance, "midiFlood"), 0.0);
    runBlocks(*instance);
    const std::uint64_t after = instance->midiOutputOverflows();
    runBlocks(*instance);
    CHECK(instance->midiOutputOverflows() == after);
    CHECK(measureDelay(*instance).frames == 64);
}

// m4-juce-formats (ADR-0018, Amendment 3): JucePluginInstance walks the MidiBuffer
// after processBlock and counts the sysex in it. JUCE's VST3 wrapper builds each one
// with MidiMessage::createSysExMessage, which mallocs for more than 8 bytes: the
// accepted, plugin-caused allocation. SIANN's walk allocates nothing.
TEST_CASE("plugin host: sysex output is counted per event, never as an overflow", "[juce][plugin][midi]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    CHECK(instance->capabilities().midiOutput);
    checkSysexCounting(*instance);
    CHECK(measureDelay(*instance).frames == 64);
}
