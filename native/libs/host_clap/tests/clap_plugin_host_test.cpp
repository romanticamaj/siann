// CLAP hosting tests. siann_test_plugin, built here, is a known delay, so latency
// reporting is checked against audio, not only against a number. These run in every
// preset: this is the host of the headless target too. Test names start with
// "clap host:" so `ctest -R "clap host"` selects them.

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#endif

#include "clap_library.hpp"
#include "hosting_checks.hpp"
#include "siann/host/clap_plugin_host.hpp"

using namespace siann;
using namespace siann::hosting_test;
using Catch::Approx;

namespace {

constexpr const char* testPluginUid = "org.siann.test-plugin";

Pump pumpOf(host::ClapPluginHost& host) {
    return [&host](const std::function<bool()>& predicate) {
        const auto deadline = std::chrono::steady_clock::now() + eventTimeout;
        for (;;) {
            host.runMainThreadCallbacks();
            if (predicate()) {
                return true;
            }
            if (std::chrono::steady_clock::now() >= deadline) {
                return false;
            }
            std::this_thread::yield();
        }
    };
}

host::PluginDescriptor testPlugin(host::ClapPluginHost& host) {
    const auto descriptors = host.scanPath(SIANN_TEST_PLUGIN_CLAP);
    REQUIRE(descriptors.size() == 1);
    return descriptors.front();
}

std::unique_ptr<host::PluginInstance> loadTestPlugin(host::ClapPluginHost& host) {
    return host.instantiate(testPlugin(host), sampleRate, blockFrames);
}

// A copy of the test plugin in a directory of its own, a second install.
std::filesystem::path installCopy(const std::string& directoryName) {
    const auto directory = std::filesystem::temp_directory_path() / directoryName;
    std::error_code ignored;
    std::filesystem::remove_all(directory, ignored);  // an earlier run's copy
    std::filesystem::create_directories(directory);
    const std::filesystem::path original(SIANN_TEST_PLUGIN_CLAP);
    const auto copy = directory / original.filename();
    std::filesystem::copy(original, copy, std::filesystem::copy_options::recursive);
    return copy;
}

// The directory the loaded code really came from, which the plugin puts in a
// parameter's name.
std::string loadedFrom(host::PluginInstance& instance) {
    for (const auto& parameter : instance.control().parameters()) {
        if (parameter.name.rfind("home:", 0) == 0) {
            return parameter.name.substr(5);
        }
    }
    FAIL("the plugin has no home parameter");
    return {};
}

// Sets an environment variable for the length of a scope.
class ScopedEnvironment {
public:
    ScopedEnvironment(const char* name, const std::string& value) : name_(name) { set(value.c_str()); }
    ~ScopedEnvironment() { set(""); }
    ScopedEnvironment(const ScopedEnvironment&) = delete;
    ScopedEnvironment& operator=(const ScopedEnvironment&) = delete;

private:
    void set(const char* value) {
#if defined(_WIN32)
        _putenv_s(name_, value);
#else
        setenv(name_, value, 1);
#endif
    }

    const char* name_;
};

template <typename Call>
void requireError(const std::string& code, Call call) {
    try {
        call();
        FAIL("this must throw " << code);
    } catch (const host::PluginError& error) {
        CHECK(error.code() == code);
    }
}

// The next event of a kind from the sink, while the host is pumped.
std::optional<host::PluginEvent> nextEvent(const Pump& pump, rt::MpscQueue<host::PluginEvent>& events,
                                           host::PluginEvent::Kind kind) {
    std::optional<host::PluginEvent> found;
    pump([&] {
        host::PluginEvent event;
        while (!found && events.pop(event)) {
            if (event.kind == kind) {
                found = event;
            }
        }
        return found.has_value();
    });
    return found;
}

}  // namespace

TEST_CASE("clap host: the test plugin is found by path", "[clap][plugin]") {
#if defined(_WIN32)
    // Windows answers a bad image with a modal error box nobody can click in a
    // headless engine. Git Bash and MSYS hand their children a mode that hides the
    // box, so a shell run proves nothing: start from the default, as the shell's
    // spawn of the engine does.
    SetErrorMode(0);
#endif
    host::ClapPluginHost host;
    const auto descriptors = host.scanPath(SIANN_TEST_PLUGIN_CLAP);
    REQUIRE(descriptors.size() == 1);
    const auto& plugin = descriptors.front();
    CHECK(plugin.format == "clap");
    CHECK(plugin.name == "SIANN Test Plugin");
    CHECK(plugin.vendor == "SIANN");
    CHECK(plugin.version == "1.0.0");
    CHECK(plugin.uid == testPluginUid);
    CHECK(plugin.path == SIANN_TEST_PLUGIN_CLAP);
    CHECK_FALSE(plugin.hasEditor);

    requireError("plugin_not_found", [&] { host.scanPath(std::string(SIANN_TEST_PLUGIN_CLAP) + ".missing"); });

    const auto path = std::filesystem::temp_directory_path() / "siann-not-a-plugin.clap";
    std::ofstream(path, std::ios::binary).close();
    REQUIRE(std::filesystem::exists(path));
    requireError("plugin_load_failed", [&] { host.scanPath(path.string()); });
    std::filesystem::remove(path);

    const auto wrongKind = std::filesystem::temp_directory_path() / "siann-not-a-clap.txt";
    std::ofstream(wrongKind, std::ios::binary).close();
    requireError("plugin_load_failed", [&] { host.scanPath(wrongKind.string()); });
    std::filesystem::remove(wrongKind);
}

TEST_CASE("clap host: scan lists CLAP_PATH without loading anything", "[clap][plugin]") {
    const auto copy = installCopy("siann-clap-host-scan");
    const auto nested = copy.parent_path() / "vendor";
    std::filesystem::create_directories(nested);
    std::filesystem::copy(copy, nested / "nested.clap", std::filesystem::copy_options::recursive);
    std::ofstream(copy.parent_path() / "readme.txt").close();

    const ScopedEnvironment path("CLAP_PATH", copy.parent_path().string());
    host::ClapPluginHost host;
    const auto listed = host.scan();
    const auto entry = [&](const std::filesystem::path& file) {
        return std::find_if(listed.begin(), listed.end(), [&](const host::PluginDescriptor& descriptor) {
            return std::filesystem::path(descriptor.path) == file;
        });
    };
    const auto found = entry(copy);
    REQUIRE(found != listed.end());
    CHECK(found->format == "clap");
    CHECK(found->name == copy.stem().string());
    CHECK(found->uid.empty());  // what a probe says, and nothing was probed
    CHECK(found->vendor.empty());
    CHECK(entry(nested / "nested.clap") != listed.end());
    CHECK(entry(copy.parent_path() / "readme.txt") == listed.end());

    // And a listed entry instantiates, probed then.
    auto instance = host.instantiate(*found, sampleRate, blockFrames);
    CHECK(loadedFrom(*instance) == "siann-clap-host-scan");
}

TEST_CASE("clap host: two installs of one plugin each load their own file", "[clap][plugin]") {
    host::ClapPluginHost host;
    const auto copy = installCopy("siann-clap-host-second");
    const auto original = testPlugin(host);
    const auto second = host.scanPath(copy.string()).front();
    REQUIRE(original.uid == second.uid);
    REQUIRE(original.path != second.path);
    const auto first = host.instantiate(original, sampleRate, blockFrames);
    const auto other = host.instantiate(second, sampleRate, blockFrames);
    CHECK(loadedFrom(*first) != "siann-clap-host-second");
    CHECK(loadedFrom(*other) == "siann-clap-host-second");

    // Without a path, two known installs must not be picked from.
    auto unplaced = original;
    unplaced.path.clear();
    requireError("plugin_not_found", [&] { host.instantiate(unplaced, sampleRate, blockFrames); });
}

TEST_CASE("clap host: a descriptor names its plugin or fails", "[clap][plugin]") {
    host::ClapPluginHost host;
    auto unplaced = testPlugin(host);
    unplaced.path.clear();
    CHECK(host.instantiate(unplaced, sampleRate, blockFrames) != nullptr);

    auto gone = testPlugin(host);
    gone.path += ".gone";
    requireError("plugin_not_found", [&] { host.instantiate(gone, sampleRate, blockFrames); });

    auto other = testPlugin(host);
    other.uid = "org.siann.another-plugin";
    requireError("plugin_not_found", [&] { host.instantiate(other, sampleRate, blockFrames); });

    requireError("plugin_not_found", [&] { host.instantiate({}, sampleRate, blockFrames); });
}

// macOS keeps the code inside a bundle; the layout is checked everywhere.
TEST_CASE("clap host: a bundle resolves to its executable", "[clap][plugin]") {
    const auto directory = std::filesystem::temp_directory_path() / "siann-clap-bundle";
    std::error_code ignored;
    std::filesystem::remove_all(directory, ignored);
    const auto bundle = directory / "Some Plugin.clap";
    const auto code = bundle / "Contents" / "MacOS";
    std::filesystem::create_directories(code);
    CHECK(host::clapExecutablePath(directory / "plain.clap") == directory / "plain.clap");
    requireError("plugin_load_failed", [&] { host::clapExecutablePath(bundle); });

    std::ofstream(code / "other-name").close();
    CHECK(host::clapExecutablePath(bundle) == code / "other-name");  // the only file there
    std::ofstream(code / "Some Plugin").close();
    CHECK(host::clapExecutablePath(bundle) == code / "Some Plugin");  // named after the bundle
}

TEST_CASE("clap host: instantiate on the main thread, process on the audio thread", "[clap][plugin]") {
    host::ClapPluginHost host;
    auto instance = loadTestPlugin(host);

    const auto capabilities = instance->capabilities();
    CHECK(capabilities.sampleAccurateParameters);
    CHECK_FALSE(capabilities.editor);
    CHECK(capabilities.variableLatency);
    CHECK_FALSE(capabilities.midiInput);
    CHECK_FALSE(capabilities.midiOutput);
    CHECK_FALSE(capabilities.sidechain);
    CHECK(instance->latencyFrames() == 64);
    CHECK(instance->tailFrames() == 0);

    const auto measured = measureDelay(*instance);
    CHECK(measured.frames == 64);
    CHECK(measured.peak == Approx(1.0f));
    CHECK(measured.allocations == 0);
    CHECK(instance->control().getParameter(parameterIndex(*instance, "wrongThread")) < 0.5);
}

TEST_CASE("clap host: capabilities come from the plugin's ports", "[clap][plugin]") {
    host::ClapPluginHost host;
    const ScopedEnvironment layout("SIANN_TEST_PLUGIN_LAYOUT", "sidechain");
    auto instance = loadTestPlugin(host);
    const auto capabilities = instance->capabilities();
    CHECK(capabilities.midiInput);
    CHECK(capabilities.midiOutput);
    CHECK(capabilities.sidechain);
    CHECK(measureDelay(*instance).frames == 64);  // the sidechain port gets silence
}

TEST_CASE("clap host: a port beyond the channel limit fails the load", "[clap][plugin]") {
    host::ClapPluginHost host;
    const auto descriptor = testPlugin(host);
    const ScopedEnvironment layout("SIANN_TEST_PLUGIN_LAYOUT", "wide");
    requireError("plugin_load_failed", [&] { host.instantiate(descriptor, sampleRate, blockFrames); });
}

TEST_CASE("clap host: parameters are listed and normalized", "[clap][plugin]") {
    host::ClapPluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    const auto parameters = instance->control().parameters();
    CHECK(parameters[static_cast<std::size_t>(gain)].defaultValue == Approx(1.0));
    CHECK(parameters[static_cast<std::size_t>(gain)].automatable);
    CHECK_FALSE(parameters[static_cast<std::size_t>(gain)].id.empty());
    CHECK(instance->control().getParameter(gain) == Approx(1.0));
    instance->control().setParameter(gain, 0.25);
    CHECK(instance->control().getParameter(gain) == Approx(0.25));
    instance->control().setParameter(gain, 2.0);
    CHECK(instance->control().getParameter(gain) == Approx(1.0));

    const int beyond = static_cast<int>(parameters.size());
    requireError("bad_parameter", [&] { instance->control().getParameter(beyond); });
    requireError("bad_parameter", [&] { instance->control().setParameter(-1, 0.0); });
}

TEST_CASE("clap host: the test plugin passes the whole hosting check", "[clap][plugin]") {
    host::ClapPluginHost host;
    checkBuiltTestPlugin(pumpOf(host), host, testPlugin(host));
}

TEST_CASE("clap host: parameter events land at their sample offset", "[clap][plugin]") {
    host::ClapPluginHost host;
    auto instance = loadTestPlugin(host);
    const auto gain = static_cast<std::uint32_t>(parameterIndex(*instance, "gain"));
    const auto kind = host::BlockEventKind::parameterValue;

    // In order, and out of order: CLAP wants them sorted, the host's job.
    const std::array<host::BlockEvent, 2> sorted{{{100, kind, gain, 0, 0.0}, {200, kind, gain, 0, 1.0}}};
    const std::array<host::BlockEvent, 2> unsorted{{{200, kind, gain, 0, 1.0}, {100, kind, gain, 0, 0.0}}};
    for (const auto* events : {&sorted, &unsorted}) {
        Audio input(2, blockFrames);
        Audio output(2, blockFrames);
        for (int c = 0; c < 2; ++c) {
            input.channel(c).assign(static_cast<std::size_t>(blockFrames), 1.0f);
        }
        std::uint64_t allocations = 1;
        std::thread audio([&] {
            const rt::ScopedRealtimeThread realtime;
            const auto before = rt::allocationViolations();
            for (int block = 0; block < 2; ++block) {  // past the delay line's silence
                instance->process(input.view(), output.view(), {});
            }
            instance->process(input.view(), output.view(), *events);
            allocations = rt::allocationViolations() - before;
        });
        audio.join();
        CHECK(allocations == 0);
        for (int c = 0; c < 2; ++c) {
            const auto& samples = output.channel(c);
            for (std::size_t i = 0; i < samples.size(); ++i) {
                const float expected = i >= 100 && i < 200 ? 0.0f : 1.0f;
                if (samples[i] != expected) {
                    FAIL("channel " << c << " sample " << i << ": " << samples[i] << " is not " << expected);
                }
            }
        }
        CHECK(instance->control().getParameter(static_cast<int>(gain)) == Approx(1.0));
    }
}

TEST_CASE("clap host: an event's value is what the control side reads afterwards", "[clap][plugin]") {
    host::ClapPluginHost host;
    auto instance = loadTestPlugin(host);
    const auto gain = static_cast<std::uint32_t>(parameterIndex(*instance, "gain"));
    const std::array<host::BlockEvent, 3> events{{{0, host::BlockEventKind::none, gain, 0, 0.5},
                                                  {blockFrames + 10, host::BlockEventKind::parameterValue, gain, 0, 0.25},
                                                  {1, host::BlockEventKind::parameterValue, 9999, 0, 0.5}}};
    Audio input(2, blockFrames);
    Audio output(2, blockFrames);
    std::thread audio([&] {
        const rt::ScopedRealtimeThread realtime;
        instance->process(input.view(), output.view(), events);
    });
    audio.join();
    // No kind, no effect; beyond the block, the block's last sample; no such
    // parameter, nothing.
    CHECK(instance->control().getParameter(static_cast<int>(gain)) == Approx(0.25));
    CHECK(measureDelay(*instance).peak == Approx(0.25f));
}

TEST_CASE("clap host: bad blobs are refused with parameters unchanged", "[clap][plugin]") {
    host::ClapPluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    instance->control().setParameter(gain, 0.25);
    const auto state = instance->control().getState();
    REQUIRE(state.size() > 8);
    CHECK(std::string(state.begin(), state.begin() + 8) == "SIANNPS1");

    auto wrongMagic = state;
    wrongMagic[0] = 'X';
    auto wrongVersion = state;
    wrongVersion[8] = static_cast<std::uint8_t>(wrongVersion[8] + 1);  // the u32 after the magic
    auto wrongPlugin = state;
    wrongPlugin[16] = static_cast<std::uint8_t>(wrongPlugin[16] ^ 0x20);  // the first byte of the uid
    auto truncated = state;
    truncated.pop_back();
    instance->control().setParameter(parameterIndex(*instance, "futureState"), 1.0);
    auto refusedByThePlugin = instance->control().getState();

    auto target = loadTestPlugin(host);
    target->control().setParameter(gain, 0.75);
    for (const auto* blob : {&wrongMagic, &wrongVersion, &wrongPlugin, &truncated, &refusedByThePlugin}) {
        requireError("bad_state", [&] { target->control().setState(*blob); });
        CHECK(target->control().getParameter(gain) == Approx(0.75));
    }
    CHECK(measureDelay(*target).peak == Approx(0.75f));  // what the processor holds
}

TEST_CASE("clap host: a plugin keeps its state when it moves", "[clap][plugin]") {
    host::ClapPluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    instance->control().setParameter(gain, 0.25);
    const auto state = instance->control().getState();

    auto moved = host.instantiate(host.scanPath(installCopy("siann-clap-host-moved").string()).front(), sampleRate,
                                  blockFrames);
    CHECK(loadedFrom(*moved) == "siann-clap-host-moved");
    moved->control().setState(state);
    CHECK(moved->control().getParameter(gain) == Approx(0.25));
}

TEST_CASE("clap host: a plugin's own edit reaches the sink", "[clap][plugin]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadTestPlugin(host);
    rt::MpscQueue<host::PluginEvent> events(64);
    instance->control().setEventSink([&](const host::PluginEvent& event) { events.push(event); });
    const int gain = parameterIndex(*instance, "gain");

    instance->control().setParameter(parameterIndex(*instance, "nudgeGain"), 1.0);
    const auto edit = nextEvent(pump, events, host::PluginEvent::Kind::parameterEdited);
    REQUIRE(edit.has_value());
    CHECK(edit->parameterIndex == gain);
    CHECK(edit->value == Approx(0.5));
    CHECK(instance->control().getParameter(gain) == Approx(0.5));
    CHECK(instance->control().getParameter(parameterIndex(*instance, "wrongThread")) < 0.5);
    instance->control().setEventSink(nullptr);
}

TEST_CASE("clap host: a plugin's edit during playback reaches the sink from the audio thread", "[clap][plugin]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadTestPlugin(host);
    rt::MpscQueue<host::PluginEvent> events(64);
    instance->control().setEventSink([&](const host::PluginEvent& event) { events.push(event); });
    const int gain = parameterIndex(*instance, "gain");

    PlayingThread playing(*instance);
    REQUIRE(pump([&] { return playing.blocks() >= 16; }));
    instance->control().setParameter(parameterIndex(*instance, "nudgeGain"), 1.0);
    const auto edit = nextEvent(pump, events, host::PluginEvent::Kind::parameterEdited);
    REQUIRE(edit.has_value());
    CHECK(edit->parameterIndex == gain);
    CHECK(edit->value == Approx(0.5));
    CHECK(playing.finish() == 0);
    CHECK(instance->control().getParameter(gain) == Approx(0.5));
    instance->control().setEventSink(nullptr);
}

TEST_CASE("clap host: a rescan reads the values again and reaches the sink", "[clap][plugin]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadTestPlugin(host);
    rt::MpscQueue<host::PluginEvent> events(64);
    instance->control().setEventSink([&](const host::PluginEvent& event) { events.push(event); });

    instance->control().setParameter(parameterIndex(*instance, "rescan"), 1.0);
    REQUIRE(nextEvent(pump, events, host::PluginEvent::Kind::restartRequested).has_value());
    CHECK(instance->control().getParameter(parameterIndex(*instance, "gain")) == Approx(0.125));
    instance->control().setEventSink(nullptr);
}

TEST_CASE("clap host: the wake handler says when the main thread is wanted", "[clap][plugin]") {
    host::ClapPluginHost host;
    std::atomic<int> wakes{0};
    host.setWakeHandler([&] { wakes.fetch_add(1); });
    auto instance = loadTestPlugin(host);
    instance->control().setParameter(parameterIndex(*instance, "nudgeGain"), 1.0);
    const int afterSet = wakes.load();
    CHECK(afterSet > 0);  // the parameter wants a flush, as no block is coming
    REQUIRE(pumpOf(host)([&] { return wakes.load() > afterSet; }));  // request_callback
    host.setWakeHandler(nullptr);
}

// CLAP's [audio-thread] calls and process() never overlap, and neither do
// deactivate and process. The plugin spends time in deactivate and activate and
// watches for process() meanwhile.
TEST_CASE("clap host: a restart during playback keeps deactivate and process apart", "[clap][plugin]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadTestPlugin(host);
    rt::MpscQueue<host::PluginEvent> events(64);
    instance->control().setEventSink([&](const host::PluginEvent& event) { events.push(event); });
    const int restarted = parameterIndex(*instance, "restarted");

    PlayingThread playing(*instance);
    const auto ranAtLeast = [&](std::uint64_t count) { return pump([&] { return playing.blocks() >= count; }); };
    REQUIRE(ranAtLeast(16));

    instance->control().setParameter(parameterIndex(*instance, "latency"), 1.0);
    REQUIRE(pump([&] { return instance->control().getParameter(restarted) > 0.5; }));
    CHECK(instance->latencyFrames() == 512);
    REQUIRE(ranAtLeast(playing.blocks() + 16));

    CHECK(playing.finish() == 0);
    CHECK(instance->control().getParameter(parameterIndex(*instance, "overlapped")) < 0.5);
    CHECK(instance->control().getParameter(parameterIndex(*instance, "wrongThread")) < 0.5);
    CHECK(measureDelay(*instance).frames == 512);
    int reportedLatency = -1;
    bool restartReported = false;
    host::PluginEvent event;
    while (events.pop(event)) {
        if (event.kind == host::PluginEvent::Kind::latencyChanged) {
            reportedLatency = event.latencyFrames;
        }
        restartReported = restartReported || event.kind == host::PluginEvent::Kind::restartRequested;
    }
    CHECK(reportedLatency == 512);
    CHECK(restartReported);
    instance->control().setEventSink(nullptr);
}

TEST_CASE("clap host: a restart with no latency change reports none", "[clap][plugin]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadTestPlugin(host);
    rt::MpscQueue<host::PluginEvent> events(64);
    instance->control().setEventSink([&](const host::PluginEvent& event) { events.push(event); });

    instance->control().setParameter(parameterIndex(*instance, "requestRestart"), 1.0);
    REQUIRE(pump([&] { return instance->control().getParameter(parameterIndex(*instance, "restarted")) > 0.5; }));
    host::PluginEvent event;
    while (events.pop(event)) {
        CHECK(event.kind != host::PluginEvent::Kind::latencyChanged);
    }
    instance->control().setEventSink(nullptr);
}

TEST_CASE("clap host: setState during playback waits for the block in flight", "[clap][plugin]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    instance->control().setParameter(gain, 0.25);
    const auto state = instance->control().getState();
    instance->control().setParameter(parameterIndex(*instance, "watchRestore"), 1.0);
    instance->control().setParameter(parameterIndex(*instance, "holdProcessBlock"), 1.0);

    PlayingThread playing(*instance);
    REQUIRE(pump([&] { return playing.blocks() >= 2; }));
    instance->control().setParameter(gain, 0.75);
    instance->control().setState(state);
    CHECK(instance->control().getParameter(parameterIndex(*instance, "restored")) > 0.5);
    REQUIRE(pump([&] { return playing.blocks() >= 6; }));

    CHECK(playing.finish() == 0);
    CHECK(instance->control().getParameter(parameterIndex(*instance, "overlapped")) < 0.5);
    CHECK(instance->control().getParameter(gain) == Approx(0.25));
    instance->control().setParameter(parameterIndex(*instance, "holdProcessBlock"), 0.0);
    CHECK(measureDelay(*instance).peak == Approx(0.25f));  // what the processor holds
}

TEST_CASE("clap host: a setParameter during playback never holds the plugin out", "[clap][plugin]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    std::atomic<bool> stop{false};
    std::atomic<std::uint64_t> blocks{0};
    std::atomic<std::uint64_t> dryBlocks{0};
    instance->control().setParameter(gain, 0.5);  // anything but unity tells dry from processed
    Audio input(2, blockFrames);
    Audio output(2, blockFrames);
    for (int c = 0; c < 2; ++c) {
        input.channel(c).assign(static_cast<std::size_t>(blockFrames), 1.0f);
    }
    std::thread audio([&] {
        const rt::ScopedRealtimeThread realtime;
        while (!stop.load()) {
            instance->process(input.view(), output.view(), {});
            if (blocks.fetch_add(1) >= 8 && output.channel(0).back() == 1.0f) {
                dryBlocks.fetch_add(1);
            }
        }
    });
    REQUIRE(pump([&] { return blocks.load() >= 16; }));
    for (int round = 0; round < 200; ++round) {
        instance->control().setParameter(gain, round % 2 == 0 ? 0.25 : 0.5);
        host.runMainThreadCallbacks();
    }
    const auto ran = blocks.load();
    REQUIRE(pump([&] { return blocks.load() >= ran + 16; }));
    stop.store(true);
    audio.join();
    CHECK(dryBlocks.load() == 0);
}

// CLAP's state.save may run while the plugin processes, so a save during playback
// (session save, checkpoint, autosave) passes no block dry. The plugin's save waits
// for a process() call to begin, which a host that pauses never lets happen. A value
// set just before still lands in the blob: a block delivers it.
TEST_CASE("clap host: getState during playback never holds the plugin out", "[clap][plugin]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    const int savedWhileProcessing = parameterIndex(*instance, "savedWhileProcessing");
    instance->control().setParameter(gain, 0.5);
    instance->control().setParameter(parameterIndex(*instance, "watchSave"), 1.0);
    host.runMainThreadCallbacks();

    PlayingThread playing(*instance);
    REQUIRE(pump([&] { return playing.blocks() >= 4; }));
    instance->control().setParameter(gain, 0.25);
    const auto state = instance->control().getState();
    CHECK(instance->control().getParameter(savedWhileProcessing) > 0.5);
    CHECK(playing.finish() == 0);
    CHECK(instance->control().getParameter(parameterIndex(*instance, "wrongThread")) < 0.5);

    // The blob is the plugin's: a default instance that loads it has the gain.
    auto restored = loadTestPlugin(host);
    restored->control().setState(state);
    CHECK(restored->control().getParameter(gain) == Approx(0.25));
}

// Stopped, nothing else delivers a value set just before the save: getState flushes.
TEST_CASE("clap host: getState with no playback has the value just set", "[clap][plugin]") {
    host::ClapPluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    instance->control().setParameter(gain, 0.375);
    const auto state = instance->control().getState();
    auto restored = loadTestPlugin(host);
    restored->control().setState(state);
    CHECK(restored->control().getParameter(gain) == Approx(0.375));
}

// A parameter the plugin counts but cannot describe has no id. Neither a block event
// nor setParameter for it may reach the plugin, and neither may crash the audio thread.
TEST_CASE("clap host: a parameter without an info takes no events", "[clap][plugin]") {
    host::ClapPluginHost host;
    const ScopedEnvironment badInfo("SIANN_TEST_PLUGIN_BADINFO", "1");
    auto instance = loadTestPlugin(host);
    const auto parameters = instance->control().parameters();
    std::uint32_t undescribed = 0;
    while (undescribed < parameters.size() && !parameters[undescribed].id.empty()) {
        ++undescribed;
    }
    REQUIRE(undescribed < parameters.size());
    instance->control().setParameter(static_cast<int>(undescribed), 1.0);
    const std::array<host::BlockEvent, 1> events{
        {{10, host::BlockEventKind::parameterValue, undescribed, 0, 1.0}}};
    Audio input(2, blockFrames);
    Audio output(2, blockFrames);
    std::uint64_t allocations = 1;
    std::thread audio([&] {
        const rt::ScopedRealtimeThread realtime;
        const auto before = rt::allocationViolations();
        instance->process(input.view(), output.view(), events);
        instance->process(input.view(), output.view(), events);
        allocations = rt::allocationViolations() - before;
    });
    audio.join();
    CHECK(allocations == 0);
    host.runMainThreadCallbacks();
    CHECK(instance->tailFrames() == 0);  // "tail" never reached the plugin
    const auto measured = measureDelay(*instance);
    CHECK(measured.frames == 64);
    CHECK(measured.peak == Approx(1.0f));
}

TEST_CASE("clap host: a block with fewer channels than the plugin still processes", "[clap][plugin]") {
    host::ClapPluginHost host;
    auto instance = loadTestPlugin(host);
    const auto measured = measureDelay(*instance, 1);
    CHECK(measured.frames == 64);
    CHECK(measured.allocations == 0);
}

// Channels of the output view the plugin does not fill are cleared, not left as
// they were: the view may hold whatever the previous node wrote.
TEST_CASE("clap host: output channels beyond the plugin's are cleared", "[clap][plugin]") {
    host::ClapPluginHost host;
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

// A view may name one buffer for input and output. CLAP gives a plugin separate
// buffers unless it declares a pair, so the host copies.
TEST_CASE("clap host: input and output may be the same buffer", "[clap][plugin]") {
    host::ClapPluginHost host;
    auto instance = loadTestPlugin(host);
    Audio buffer(2, blockFrames);
    buffer.channel(0)[0] = 1.0f;
    std::thread audio([&] {
        const rt::ScopedRealtimeThread realtime;
        instance->process(buffer.view(), buffer.view(), {});
    });
    audio.join();
    CHECK(buffer.channel(0)[0] == 0.0f);
    CHECK(buffer.channel(0)[64] == Approx(1.0f));
}

// A block longer than the instance was prepared for cannot be handed to the plugin:
// the output is cleared instead. So is an empty block.
TEST_CASE("clap host: a block longer than the maximum is cleared, not processed", "[clap][plugin]") {
    host::ClapPluginHost host;
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

TEST_CASE("clap host: the editor is not there yet", "[clap][plugin]") {
    host::ClapPluginHost host;
    auto instance = loadTestPlugin(host);
    requireError("editor_failed", [&] { instance->control().openEditor({}); });
    CHECK_FALSE(instance->control().editorOpen());
    CHECK(instance->control().editorNativeHandle() == 0);
    instance->control().closeEditor();
}

TEST_CASE("clap host: an instance outlives its host", "[clap][plugin]") {
    std::unique_ptr<host::PluginInstance> instance;
    {
        host::ClapPluginHost host;
        instance = loadTestPlugin(host);
    }
    CHECK(measureDelay(*instance).frames == 64);
}
