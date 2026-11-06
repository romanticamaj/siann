// Hosting tests (M0 plugin-set gate). siann_test_plugin, built by CI, is a known
// delay, so latency reporting is checked against audio, not only against a
// number. The third-party plugins named by SIANN_TEST_VST3 and SIANN_TEST_AU run
// on the maintainer's machines and skip elsewhere. Test names start with
// "plugin host:" so `ctest -R "plugin host"` selects them.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

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
#include <thread>
#include <vector>

#include "siann/host/juce_plugin_host.hpp"
#include "siann/rt/mpsc_queue.hpp"
#include "siann/rt/realtime_thread.hpp"

#if defined(_WIN32)
#include <windows.h>
#endif

using namespace siann;
using Catch::Approx;

namespace {

constexpr std::int64_t sampleRate = 48'000;
constexpr int blockFrames = 256;
constexpr auto eventTimeout = std::chrono::seconds(5);

// Owned planar audio and the view of it the core would pass.
class Audio {
public:
    Audio(int channels, int frames) : samples_(static_cast<std::size_t>(channels)) {
        for (auto& channel : samples_) {
            channel.assign(static_cast<std::size_t>(frames), 0.0f);
            pointers_.push_back(channel.data());
        }
        view_.channels = pointers_.data();
        view_.channelCount = channels;
        view_.frames = frames;
    }

    const host::AudioBufferView& view() const { return view_; }
    std::vector<float>& channel(int index) { return samples_[static_cast<std::size_t>(index)]; }

private:
    std::vector<std::vector<float>> samples_;
    std::vector<float*> pointers_;
    host::AudioBufferView view_;
};

struct DelayMeasurement {
    int frames = -1;  // of the impulse's first output sample, -1 when none came out
    float peak = 0.0f;
    std::uint64_t allocations = 0;
};

// Sends an impulse through on a realtime-marked thread, the one thread that may
// call process(). Buffers exist before the thread starts: nothing allocates there.
DelayMeasurement measureDelay(host::PluginInstance& instance, int channels = 2) {
    Audio input(channels, blockFrames);
    Audio output(channels, blockFrames);
    DelayMeasurement result;
    std::thread audio([&] {
        const rt::ScopedRealtimeThread realtime;
        const auto before = rt::allocationViolations();
        for (int block = 0; block < 4; ++block) {
            for (int c = 0; c < channels; ++c) {
                input.channel(c)[0] = block == 0 ? 1.0f : 0.0f;
            }
            instance.process(input.view(), output.view(), {});
            for (int i = 0; i < blockFrames; ++i) {
                const float sample = std::abs(output.channel(channels - 1)[static_cast<std::size_t>(i)]);
                if (sample > result.peak) {
                    result.peak = sample;
                    result.frames = block * blockFrames + i;
                }
            }
        }
        result.allocations = rt::allocationViolations() - before;
    });
    audio.join();
    return result;
}

// Silence through the plugin, so a plugin whose processor learns parameters from
// process() has seen them.
void runBlocks(host::PluginInstance& instance) {
    Audio input(2, blockFrames);
    Audio output(2, blockFrames);
    std::thread audio([&] {
        const rt::ScopedRealtimeThread realtime;
        for (int block = 0; block < 4; ++block) {
            instance.process(input.view(), output.view(), {});
        }
    });
    audio.join();
}

int parameterIndex(const host::PluginInstance& instance, const std::string& name) {
    const auto parameters = instance.parameters();
    for (std::size_t i = 0; i < parameters.size(); ++i) {
        if (parameters[i].name == name) {
            return static_cast<int>(i);
        }
    }
    FAIL("the plugin has no parameter named " << name);
    return -1;
}

host::PluginDescriptor testPlugin(host::JucePluginHost& host) {
    const auto descriptors = host.scanPath(SIANN_TEST_PLUGIN_VST3);
    REQUIRE(descriptors.size() == 1);
    return descriptors.front();
}

std::unique_ptr<host::PluginInstance> loadTestPlugin(host::JucePluginHost& host) {
    return host.instantiate(testPlugin(host), sampleRate, blockFrames);
}

bool displayAvailable() {
#if defined(__linux__)
    return std::getenv("DISPLAY") != nullptr;
#else
    return true;
#endif
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

// Everything the acceptance asks of a plugin SIANN did not build. State is
// compared by parameter values: third-party blobs are opaque and need not repeat.
void checkThirdParty(host::JucePluginHost& host, const host::PluginDescriptor& descriptor) {
    auto instance = host.instantiate(descriptor, sampleRate, blockFrames);
    const auto parameters = instance->parameters();
    REQUIRE_FALSE(parameters.empty());
    CHECK(instance->latencyFrames() >= 0);

    // The first automatable parameter that accepts a new value; a stepped one may
    // snap back to where it was.
    int changed = -1;
    double changedTo = 0.0;
    for (std::size_t i = 0; i < parameters.size() && changed < 0; ++i) {
        if (!parameters[i].automatable) {
            continue;
        }
        const int index = static_cast<int>(i);
        const double before = instance->getParameter(index);
        instance->setParameter(index, before < 0.5 ? before + 0.3 : before - 0.3);
        if (std::abs(instance->getParameter(index) - before) > 1e-3) {
            changed = index;
            changedTo = instance->getParameter(index);
        }
    }
    REQUIRE(changed >= 0);
    runBlocks(*instance);

    std::vector<double> expected;
    for (std::size_t i = 0; i < parameters.size(); ++i) {
        expected.push_back(instance->getParameter(static_cast<int>(i)));
    }
    const auto state = instance->getState();
    CHECK_FALSE(state.empty());

    auto restored = host.instantiate(descriptor, sampleRate, blockFrames);
    CHECK(std::abs(restored->getParameter(changed) - changedTo) > 1e-3);
    restored->setState(state);
    for (std::size_t i = 0; i < parameters.size(); ++i) {
        if (parameters[i].automatable) {
            INFO("parameter " << parameters[i].name);
            CHECK(restored->getParameter(static_cast<int>(i)) == Approx(expected[i]).margin(1e-3));
        }
    }

    if (descriptor.hasEditor && displayAvailable()) {
        restored->openEditor({});
        CHECK(restored->editorOpen());
        CHECK(restored->editorNativeHandle() != 0);
        restored->closeEditor();
        CHECK_FALSE(restored->editorOpen());
    }
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
    instance->setParameter(gain, 0.25);
    instance->setParameter(latency, 1.0);
    const auto state = instance->getState();
    REQUIRE(state.size() > 8);
    CHECK(std::string(state.begin(), state.begin() + 8) == "SIANNPS1");

    auto restored = loadTestPlugin(host);
    CHECK(restored->getParameter(gain) == Approx(1.0));
    restored->setState(state);
    CHECK(restored->getParameter(gain) == Approx(0.25));
    CHECK(restored->getParameter(latency) == Approx(1.0));
    REQUIRE(loop.runUntil([&] { return restored->latencyFrames() == 512; }, eventTimeout));
    CHECK(measureDelay(*restored).frames == 512);
}

TEST_CASE("plugin host: a blob of the wrong version, plugin or size changes nothing", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    instance->setParameter(gain, 0.25);
    const auto state = instance->getState();

    auto wrongVersion = state;
    wrongVersion[8] = static_cast<std::uint8_t>(wrongVersion[8] + 1);  // the u32 after the magic
    auto wrongPlugin = state;
    wrongPlugin[16] = static_cast<std::uint8_t>(wrongPlugin[16] ^ 0x20);  // the first byte of the uid
    auto truncated = state;
    truncated.pop_back();
    auto wrongMagic = state;
    wrongMagic[0] = 'X';

    auto target = loadTestPlugin(host);
    target->setParameter(gain, 0.75);
    for (const auto* blob : {&wrongVersion, &wrongPlugin, &truncated, &wrongMagic}) {
        try {
            target->setState(*blob);
            FAIL("a bad blob must throw");
        } catch (const host::PluginError& error) {
            CHECK(error.code() == "bad_state");
        }
        CHECK(target->getParameter(gain) == Approx(0.75));
    }
}

TEST_CASE("plugin host: a plugin that refuses its payload keeps its parameters", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);
    const int gain = parameterIndex(*instance, "gain");
    instance->setParameter(gain, 0.25);
    instance->setParameter(parameterIndex(*instance, "futureState"), 1.0);
    const auto state = instance->getState();

    auto target = loadTestPlugin(host);
    target->setParameter(gain, 0.75);
    target->setState(state);
    CHECK(target->getParameter(gain) == Approx(0.75));
    CHECK(target->latencyFrames() == 64);
}

TEST_CASE("plugin host: a runtime latency change is reported", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    auto instance = loadTestPlugin(host);

    rt::MpscQueue<host::PluginEvent> pluginEventAny(64);
    instance->setEventSink([&](const host::PluginEvent& event) { pluginEventAny.push(event); });
    CHECK(measureDelay(*instance).frames == 64);

    instance->setParameter(parameterIndex(*instance, "latency"), 1.0);
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
    instance->setEventSink([&](const host::PluginEvent& event) { pluginEventAny.push(event); });
    instance->setParameter(parameterIndex(*instance, "nudgeGain"), 1.0);

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
    CHECK(instance->getParameter(gain) == Approx(0.5));

    // After the sink is gone nothing calls it.
    instance->setEventSink(nullptr);
    instance->setParameter(parameterIndex(*instance, "latency"), 1.0);
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

    CHECK_FALSE(instance->editorOpen());
    CHECK(instance->editorNativeHandle() == 0);
    instance->openEditor({});
    CHECK(instance->editorOpen());
    const auto handle = instance->editorNativeHandle();
    CHECK(handle != 0);

    instance->openEditor({});  // idempotent: the same window
    CHECK(instance->editorNativeHandle() == handle);

    instance->closeEditor();
    CHECK_FALSE(instance->editorOpen());
    CHECK(instance->editorNativeHandle() == 0);
    instance->closeEditor();  // idempotent too

    instance->openEditor({});
    CHECK(instance->editorOpen());
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
    instance->openEditor({reinterpret_cast<std::uintptr_t>(owner)});
    auto* editor = reinterpret_cast<HWND>(instance->editorNativeHandle());
    REQUIRE(editor != nullptr);
    CHECK(GetWindow(editor, GW_OWNER) == owner);  // GW_OWNER reads GWLP_HWNDPARENT
    instance->closeEditor();
    CHECK_FALSE(IsWindow(editor));

    instance->openEditor({reinterpret_cast<std::uintptr_t>(owner)});
    editor = reinterpret_cast<HWND>(instance->editorNativeHandle());
    instance.reset();  // an instance closes its editor as it goes
    CHECK_FALSE(IsWindow(editor));
    DestroyWindow(owner);
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
    checkThirdParty(host, *plugin);
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
    checkThirdParty(host, *plugin);
}

TEST_CASE("plugin host: Apple AUPeakLimiter loads in CI", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto plugins = host.scan();
    const auto limiter = std::find_if(plugins.begin(), plugins.end(), [](const host::PluginDescriptor& p) {
        return p.format == "au" && p.name == "AUPeakLimiter" && p.vendor == "Apple";
    });
    REQUIRE(limiter != plugins.end());
    checkThirdParty(host, *limiter);
}
#endif

TEST_CASE("plugin host: scan() lists the default locations without throwing", "[juce][plugin]") {
    host::MainThreadLoop loop;
    host::JucePluginHost host;
    const auto plugins = host.scan();  // may be empty on a Linux runner
    for (const auto& plugin : plugins) {
        CHECK_FALSE(plugin.uid.empty());
        CHECK_FALSE(plugin.path.empty());
    }
}
