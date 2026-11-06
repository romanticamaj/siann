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

#include "hosting_checks.hpp"

#if defined(_WIN32)
#include <windows.h>
#endif

using namespace siann;
using namespace siann::hosting_test;
using Catch::Approx;

namespace {

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
    CHECK_FALSE(capabilities.midiOutput);
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
    checkBuiltTestPlugin(loop, host, testPlugin(host));
}

namespace {

// The audio thread at full speed beside the main thread, with what it may meet
// there. The test ends the loop itself: process() is only ever called from here.
class PlayingThread {
public:
    explicit PlayingThread(host::PluginInstance& instance)
        : input_(2, blockFrames), output_(2, blockFrames), thread_([this, &instance] {
              const rt::ScopedRealtimeThread realtime;
              const auto before = rt::allocationViolations();
              while (!stop_.load()) {
                  instance.process(input_.view(), output_.view(), {});
                  blocks_.fetch_add(1);
              }
              allocations_.store(rt::allocationViolations() - before);
          }) {}
    ~PlayingThread() { finish(); }

    std::uint64_t blocks() const { return blocks_.load(); }
    // Stops the thread, then says how often it allocated.
    std::uint64_t finish() {
        stop_.store(true);
        if (thread_.joinable()) {
            thread_.join();
        }
        return allocations_.load();
    }

private:
    Audio input_;
    Audio output_;
    std::atomic<bool> stop_{false};
    std::atomic<std::uint64_t> blocks_{0};
    std::atomic<std::uint64_t> allocations_{0};
    std::thread thread_;
};

}  // namespace

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
    CHECK(restored->tailFrames() == longTailFrames);  // on return, before any restart reaches the host
}

TEST_CASE("plugin host: a block with fewer channels than the plugin still processes", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);

    const auto measured = measureDelay(*instance, 1);
    CHECK(measured.frames == 64);
    CHECK(measured.allocations == 0);
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
