// What ClapPluginHost does about a plugin that breaks the rules (architecture spec,
// "siann-host: two targets, one interface", Hostile test plugin). siann_hostile_plugin,
// built here, turns each behaviour on through a parameter; a default instance is a
// harmless stereo pass-through. "The engine survives" is checked here, at the host:
// process() runs on a realtime-marked thread, as the audio thread calls it.
//
// Blocks in which the plugin allocates, throws or sleeps run under
// ScopedRealtimeSanitizerDisabler, with the reason at each use, and nothing is
// asserted about their allocation count: what the plugin does is outside SIANN's
// guarantee. The host's own blocks around them are asserted not to allocate.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#if !defined(_WIN32)
#include <csignal>
#endif

#include "child_process.hpp"
#include "hosting_checks.hpp"
#include "siann/host/clap_plugin_host.hpp"
#include "siann/host/state_envelope.hpp"

using namespace siann;
using namespace siann::hosting_test;
using Catch::Approx;

namespace {

constexpr const char* hostileUid = "org.siann.hostile-plugin";
constexpr std::size_t stateSize = 12;  // magic and version

constexpr const char* behaviours[] = {
    "allocate",    "throwProcess", "throwActivate",  "throwLoad",     "throwSave", "throwMainThread",
    "latencyFlap", "sleep",        "callbacksAudio", "callbacksMain", "crash",
};

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

host::PluginDescriptor hostilePlugin(host::ClapPluginHost& host) {
    const auto descriptors = host.scanPath(SIANN_HOSTILE_PLUGIN_CLAP);
    REQUIRE(descriptors.size() == 1);
    return descriptors.front();
}

std::unique_ptr<host::PluginInstance> loadHostile(host::ClapPluginHost& host) {
    return host.instantiate(hostilePlugin(host), sampleRate, blockFrames);
}

// A default instance's blob: what a session saved before anything went wrong.
std::vector<std::uint8_t> defaultState(host::ClapPluginHost& host) { return loadHostile(host)->control().getState(); }

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

// The plugin's events, as the engine's pluginEventAny queue would hold them.
class Events {
public:
    explicit Events(host::PluginInstance& instance) : instance_(instance) {
        instance_.control().setEventSink([this](const host::PluginEvent& event) { queue_.push(event); });
    }
    ~Events() { instance_.control().setEventSink(nullptr); }
    Events(const Events&) = delete;
    Events& operator=(const Events&) = delete;

    // Moves what arrived into seen(); true when one of `kind` was among it.
    bool drain(host::PluginEvent::Kind kind) {
        bool found = false;
        host::PluginEvent event;
        while (queue_.pop(event)) {
            seen_.push_back(event);
            found = found || event.kind == kind;
        }
        return found;
    }

    // Pumps until an event of `kind` arrives; false on timeout.
    bool next(const Pump& pump, host::PluginEvent::Kind kind) {
        return pump([&] { return drain(kind); });
    }

    // How many of `kind` arrived so far, drained first.
    std::size_t count(host::PluginEvent::Kind kind) {
        drain(kind);
        return static_cast<std::size_t>(std::count_if(seen_.begin(), seen_.end(),
                                                      [&](const host::PluginEvent& event) { return event.kind == kind; }));
    }

    const std::vector<host::PluginEvent>& seen() const { return seen_; }

private:
    host::PluginInstance& instance_;
    rt::MpscQueue<host::PluginEvent> queue_{4096};
    std::vector<host::PluginEvent> seen_;
};

// `each` on a realtime-marked thread, as the audio thread calls process(); returns
// the allocation guard's count across it. With `hostile`, the plugin breaks the
// realtime rules on purpose inside: the caller asserts nothing about that count.
template <typename Each>
std::uint64_t onAudioThread(bool hostile, Each each) {
    std::uint64_t allocations = 0;
    std::thread audio([&] {
        const rt::ScopedRealtimeThread realtime;
        const auto before = rt::allocationViolations();
        if (hostile) {
            // Reason: the plugin allocates, throws (__cxa_allocate_exception and the
            // unwinder) or sleeps on purpose; RealtimeSanitizer would rightly report it.
            const rt::ScopedRealtimeSanitizerDisabler allowed;
            each();
        } else {
            each();
        }
        allocations = rt::allocationViolations() - before;
    });
    audio.join();
    return allocations;
}

// A ramp per block, never zero, so a cleared output tells from a passed-through one.
void fillRamp(Audio& audio, int block) {
    for (int c = 0; c < 2; ++c) {
        auto& samples = audio.channel(c);
        for (std::size_t i = 0; i < samples.size(); ++i) {
            samples[i] = 0.25f + static_cast<float>((static_cast<std::size_t>(block) * samples.size() + i) % 97) / 256.0f;
        }
    }
}

bool same(Audio& a, Audio& b) {
    return a.channel(0) == b.channel(0) && a.channel(1) == b.channel(1);
}

bool silent(Audio& audio) {
    for (int c = 0; c < 2; ++c) {
        const auto& samples = audio.channel(c);
        if (std::any_of(samples.begin(), samples.end(), [](float sample) { return sample != 0.0f; })) {
            return false;
        }
    }
    return true;
}

// Clean blocks through the instance: true when each one passed its ramp through.
// The host's own work, so it must not allocate.
bool passesThrough(host::PluginInstance& instance, int blocks, std::uint64_t& allocations) {
    Audio input(2, blockFrames);
    Audio output(2, blockFrames);
    bool passed = true;
    allocations = onAudioThread(false, [&] {
        for (int block = 0; block < blocks; ++block) {
            fillRamp(input, block);
            instance.process(input.view(), output.view(), {});
            passed = passed && same(input, output);
        }
    });
    return passed;
}

// PlayingThread, for a plugin that sleeps or throws inside process(): the loop runs
// under the sanitizer disabler and its allocation count is not asserted.
class HostilePlaying {
public:
    explicit HostilePlaying(host::PluginInstance& instance)
        : instance_(instance), input_(2, blockFrames), output_(2, blockFrames), thread_([this] {
              const rt::ScopedRealtimeThread realtime;
              // Reason: the plugin sleeps or throws inside process() on purpose;
              // RealtimeSanitizer would rightly report it.
              const rt::ScopedRealtimeSanitizerDisabler allowed;
              while (!stop_.load()) {
                  instance_.process(input_.view(), output_.view(), {});
                  blocks_.fetch_add(1);
              }
          }) {
        instance_.setBlocksComing(true);
    }
    ~HostilePlaying() { finish(); }
    HostilePlaying(const HostilePlaying&) = delete;
    HostilePlaying& operator=(const HostilePlaying&) = delete;

    std::uint64_t blocks() const { return blocks_.load(); }

    void finish() {
        stop_.store(true);
        if (thread_.joinable()) {
            thread_.join();
            instance_.setBlocksComing(false);
        }
    }

private:
    host::PluginInstance& instance_;
    Audio input_;
    Audio output_;
    std::atomic<bool> stop_{false};
    std::atomic<std::uint64_t> blocks_{0};
    std::thread thread_;
};

// Pumps a few rounds; true when none of them brought an event of `kind`.
bool quietFor(const Pump& pump, Events& events, host::PluginEvent::Kind kind, int rounds) {
    bool quiet = true;
    for (int round = 0; round < rounds; ++round) {
        pump([] { return true; });
        quiet = !events.drain(kind) && quiet;
    }
    return quiet;
}

}  // namespace

TEST_CASE("clap host: hostile plugin is harmless by default", "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto descriptors = host.scanPath(SIANN_HOSTILE_PLUGIN_CLAP);
    REQUIRE(descriptors.size() == 1);
    CHECK(descriptors.front().uid == hostileUid);
    auto instance = host.instantiate(descriptors.front(), sampleRate, blockFrames);
    for (const char* behaviour : behaviours) {
        INFO(behaviour);
        CHECK(instance->control().getParameter(parameterIndex(*instance, behaviour)) == 0.0);
    }
    CHECK(instance->latencyFrames() == 0);
    const auto measured = measureDelay(*instance);
    CHECK(measured.frames == 0);
    CHECK(measured.peak == Approx(1.0f));
    CHECK(measured.allocations == 0);
}

TEST_CASE("clap host: hostile allocate completes every block with the plugin's output", "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadHostile(host);
    Events events(*instance);
    const int allocate = parameterIndex(*instance, "allocate");
    instance->control().setParameter(allocate, 1.0);

    Audio input(2, blockFrames);
    Audio output(2, blockFrames);
    bool passed = true;
    onAudioThread(true, [&] {
        for (int block = 0; block < 8; ++block) {
            fillRamp(input, block);
            instance->process(input.view(), output.view(), {});
            passed = passed && same(input, output);
        }
    });
    CHECK(passed);
    CHECK(quietFor(pump, events, host::PluginEvent::Kind::failed, 4));

    instance->control().setParameter(allocate, 0.0);
    std::uint64_t allocations = 1;
    CHECK(passesThrough(*instance, 1, allocations));
    CHECK(allocations == 0);
}

TEST_CASE("clap host: hostile throwProcess clears the block and fails the instance", "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    const auto state = defaultState(host);
    auto instance = loadHostile(host);
    Events events(*instance);
    const int level = parameterIndex(*instance, "level");
    instance->control().setParameter(parameterIndex(*instance, "throwProcess"), 1.0);

    Audio input(2, blockFrames);
    Audio output(2, blockFrames);
    fillRamp(input, 0);
    onAudioThread(true, [&] { instance->process(input.view(), output.view(), {}); });
    CHECK(silent(output));
    CHECK_FALSE(silent(input));

    REQUIRE(events.next(pump, host::PluginEvent::Kind::failed));
    CHECK(quietFor(pump, events, host::PluginEvent::Kind::failed, 4));  // once only
    CHECK(events.count(host::PluginEvent::Kind::failed) == 1);

    // Failed: input passes through, from the host alone.
    std::uint64_t allocations = 1;
    CHECK(passesThrough(*instance, 4, allocations));
    CHECK(allocations == 0);

    requireError("plugin_failed", [&] { instance->control().getState(); });
    requireError("plugin_failed", [&] { instance->control().setState(state); });
    instance->control().setParameter(level, 0.75);  // stored, delivered to nobody
    CHECK(instance->control().getParameter(level) == Approx(0.75));
    CHECK(instance->latencyFrames() == 0);
    CHECK(instance->tailFrames() == 0);
    CHECK_NOTHROW(host.runMainThreadCallbacks());
}

TEST_CASE("clap host: hostile throwActivate at instantiate fails the load", "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto descriptor = hostilePlugin(host);
    const ScopedEnvironment throwActivate("SIANN_HOSTILE_PLUGIN_THROW_ACTIVATE", "1");
    requireError("plugin_load_failed", [&] { host.instantiate(descriptor, sampleRate, blockFrames); });
}

TEST_CASE("clap host: hostile throwActivate in a restart fails the instance", "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadHostile(host);
    Events events(*instance);
    instance->control().setParameter(parameterIndex(*instance, "throwActivate"), 1.0);
    instance->control().setParameter(parameterIndex(*instance, "latencyFlap"), 1.0);  // asks for the restart

    {
        HostilePlaying playing(*instance);
        REQUIRE(events.next(pump, host::PluginEvent::Kind::failed));
        const auto failedAt = playing.blocks();
        REQUIRE(pump([&] { return playing.blocks() >= failedAt + 16; }));
    }
    CHECK(events.count(host::PluginEvent::Kind::failed) == 1);
    std::uint64_t allocations = 1;
    CHECK(passesThrough(*instance, 4, allocations));
    CHECK(allocations == 0);
}

TEST_CASE("clap host: hostile throwLoad is bad_state and fails the instance", "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    const auto state = defaultState(host);
    auto instance = loadHostile(host);
    Events events(*instance);
    instance->control().setParameter(parameterIndex(*instance, "throwLoad"), 1.0);

    requireError("bad_state", [&] { instance->control().setState(state); });
    REQUIRE(events.next(pump, host::PluginEvent::Kind::failed));
    requireError("plugin_failed", [&] { instance->control().getState(); });
    std::uint64_t allocations = 1;
    CHECK(passesThrough(*instance, 2, allocations));
    CHECK(allocations == 0);
}

TEST_CASE("clap host: hostile throwSave is bad_state and the instance lives", "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    const auto state = defaultState(host);
    auto instance = loadHostile(host);
    Events events(*instance);
    const int throwSave = parameterIndex(*instance, "throwSave");
    instance->control().setParameter(throwSave, 1.0);

    requireError("bad_state", [&] { instance->control().getState(); });
    CHECK(quietFor(pump, events, host::PluginEvent::Kind::failed, 4));
    CHECK_NOTHROW(instance->control().setState(state));
    instance->control().setParameter(throwSave, 0.0);
    const auto saved = instance->control().getState();
    CHECK(host::unwrapPluginState(saved, hostileUid).size() == stateSize);
}

TEST_CASE("clap host: hostile throwMainThread fails the instance and the others are serviced",
          "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto first = loadHostile(host);
    auto second = loadHostile(host);
    Events firstEvents(*first);
    Events secondEvents(*second);
    // Each asks for a main-thread callback, which throws.
    first->control().setParameter(parameterIndex(*first, "throwMainThread"), 1.0);
    second->control().setParameter(parameterIndex(*second, "throwMainThread"), 1.0);

    REQUIRE(firstEvents.next(pump, host::PluginEvent::Kind::failed));
    REQUIRE(secondEvents.next(pump, host::PluginEvent::Kind::failed));
    CHECK_NOTHROW(host.runMainThreadCallbacks());
    requireError("plugin_failed", [&] { first->control().getState(); });
    requireError("plugin_failed", [&] { second->control().getState(); });
}

TEST_CASE("clap host: hostile latencyFlap restarts on every request and stops when it stops",
          "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadHostile(host);
    Events events(*instance);
    const int latencyFlap = parameterIndex(*instance, "latencyFlap");
    const int activations = parameterIndex(*instance, "activations");
    instance->control().setParameter(latencyFlap, 1.0);

    PlayingThread playing(*instance);
    std::vector<int> latencies;
    std::vector<std::uint64_t> blocksAt;
    std::size_t scanned = 0;
    REQUIRE(pump([&] {
        events.drain(host::PluginEvent::Kind::latencyChanged);
        for (; scanned < events.seen().size(); ++scanned) {
            const auto& event = events.seen()[scanned];
            if (event.kind == host::PluginEvent::Kind::latencyChanged) {
                latencies.push_back(event.latencyFrames);
                blocksAt.push_back(playing.blocks());
            }
        }
        return latencies.size() >= 3;
    }));
    CHECK(latencies[0] == 64);
    CHECK(latencies[1] == 128);
    CHECK(latencies[2] == 64);
    // Each restart after the first needs a block to ask for it, which runs after the
    // previous restart: so the third came at least one block after the first.
    CHECK(blocksAt[2] > blocksAt[0]);

    instance->control().setParameter(latencyFlap, 0.0);
    const auto stableFor32Blocks = [&] {
        const int latency = instance->latencyFrames();
        const double activated = instance->control().getParameter(activations);
        const auto from = playing.blocks();
        REQUIRE(pump([&] { return playing.blocks() >= from + 32; }));
        return instance->latencyFrames() == latency && instance->control().getParameter(activations) == activated;
    };
    bool settled = false;
    for (int attempt = 0; attempt < 20 && !settled; ++attempt) {
        settled = stableFor32Blocks();
    }
    CHECK(settled);
    CHECK(playing.finish() == 0);
    CHECK(events.count(host::PluginEvent::Kind::failed) == 0);
}

TEST_CASE("clap host: hostile sleep makes the waits for a block wait and return", "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    const auto state = defaultState(host);
    auto instance = loadHostile(host);
    const int sleeps = parameterIndex(*instance, "sleep");
    instance->control().setParameter(sleeps, 1.0);

    HostilePlaying playing(*instance);
    REQUIRE(pump([&] { return playing.blocks() >= 2; }));
    instance->control().setState(state);  // waits for the sleeping block in flight
    const auto restored = playing.blocks();
    REQUIRE(pump([&] { return playing.blocks() > restored; }));
    instance->control().setParameter(parameterIndex(*instance, "level"), 0.5);
    const auto saved = instance->control().getState();  // waits for a block to take the value
    CHECK(host::unwrapPluginState(saved, hostileUid).size() == stateSize);
    instance->control().setParameter(sleeps, 0.0);
    const auto woken = playing.blocks();
    REQUIRE(pump([&] { return playing.blocks() >= woken + 16; }));
}

TEST_CASE("clap host: hostile callbacksAudio from process() take effect on the main thread",
          "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    auto instance = loadHostile(host);
    Events events(*instance);
    const int callbacksAudio = parameterIndex(*instance, "callbacksAudio");
    const int getValueOnAudioThread = parameterIndex(*instance, "getValueOnAudioThread");
    instance->control().setParameter(callbacksAudio, 1.0);

    PlayingThread playing(*instance);
    REQUIRE(pump([&] { return playing.blocks() >= 32; }));
    const auto mid = playing.blocks();
    REQUIRE(pump([&] { return playing.blocks() >= mid + 32; }));
    CHECK(events.count(host::PluginEvent::Kind::restartRequested) > 0);
    CHECK(events.count(host::PluginEvent::Kind::failed) == 0);
    // The host read the values again on the main thread, never on the caller's.
    CHECK(instance->control().getParameter(getValueOnAudioThread) < 0.5);

    instance->control().setParameter(callbacksAudio, 0.0);
    const auto off = playing.blocks();
    REQUIRE(pump([&] { return playing.blocks() >= off + 32; }));
    CHECK(playing.finish() == 0);
    CHECK(instance->control().getParameter(getValueOnAudioThread) < 0.5);
}

TEST_CASE("clap host: hostile callbacksMain inside host calls are honoured after them", "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    const auto pump = pumpOf(host);
    const auto state = defaultState(host);
    auto instance = loadHostile(host);
    Events events(*instance);
    const int callbacksMain = parameterIndex(*instance, "callbacksMain");
    const int reentered = parameterIndex(*instance, "reentered");
    const int activations = parameterIndex(*instance, "activations");
    instance->control().setParameter(callbacksMain, 1.0);
    host.runMainThreadCallbacks();  // delivers it

    const auto parameters = instance->control().parameters();  // get_info calls back
    REQUIRE(parameters.size() == 15);
    CHECK(parameters[static_cast<std::size_t>(reentered)].name == "reentered");
    const double before = instance->control().getParameter(activations);
    REQUIRE(pump([&] { return instance->control().getParameter(activations) > before; }));
    CHECK(instance->control().getParameter(reentered) < 0.5);

    CHECK_NOTHROW(instance->control().setState(state));  // state.load calls back
    // request_restart inside activate schedules one more: the restarts go on.
    const double restored = instance->control().getParameter(activations);
    REQUIRE(pump([&] { return instance->control().getParameter(activations) > restored; }));
    CHECK(events.count(host::PluginEvent::Kind::restartRequested) > 0);

    instance->control().setParameter(callbacksMain, 0.0);
    bool settled = false;
    for (int attempt = 0; attempt < 20 && !settled; ++attempt) {
        const double activated = instance->control().getParameter(activations);
        settled = quietFor(pump, events, host::PluginEvent::Kind::restartRequested, 8) &&
                  instance->control().getParameter(activations) == activated;
    }
    CHECK(settled);
    CHECK(instance->control().getParameter(reentered) < 0.5);
    CHECK(events.count(host::PluginEvent::Kind::failed) == 0);
}

// Run by the crash test as a child: never returns.
TEST_CASE("clap host: hostile crash child", "[.][hostile-crash-child]") {
    std::fputs("crashing\n", stdout);
    std::fflush(stdout);
    host::ClapPluginHost host;
    auto instance = loadHostile(host);
    instance->control().setParameter(parameterIndex(*instance, "crash"), 1.0);
    Audio input(2, blockFrames);
    Audio output(2, blockFrames);
    onAudioThread(true, [&] { instance->process(input.view(), output.view(), {}); });
    FAIL("the plugin did not crash");
}

TEST_CASE("clap host: hostile crash ends the process with abort and no dialog", "[clap][plugin][hostile]") {
    const auto out = std::filesystem::temp_directory_path() / "siann-hostile-crash-child.txt";
    int code = 0;
    int endedBy = 0;
    {
        cli::test::ChildProcess child(SIANN_HOST_CLAP_TESTS_EXE, {"[hostile-crash-child]"}, out);
        code = child.wait();
        endedBy = child.terminatingSignal();
    }
#if defined(_WIN32)
    CHECK(code == 3);  // abort(), with no "abort() has been called" box to wait on
    CHECK(endedBy == 0);
#else
    CHECK(code == -1);
    CHECK(endedBy == SIGABRT);
#endif
    std::ifstream file(out, std::ios::binary);
    const std::string printed((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    CHECK(printed.find("crashing") != std::string::npos);
    CHECK(printed.find("All tests passed") == std::string::npos);
    CHECK(printed.find("the plugin did not crash") == std::string::npos);
    SUCCEED("this process is alive");
}

TEST_CASE("clap host: hostile crash never comes from state", "[clap][plugin][hostile]") {
    host::ClapPluginHost host;
    auto instance = loadHostile(host);
    const int crash = parameterIndex(*instance, "crash");
    const auto saved = instance->control().getState();
    const auto payload = host::unwrapPluginState(saved, hostileUid);
    REQUIRE(payload.size() == stateSize);  // magic and version: crash is left out
    CHECK(std::string(payload.begin(), payload.begin() + 8) == "SIANNHP1");

    std::vector<std::uint8_t> withCrash(payload.begin(), payload.end());
    withCrash.push_back(1);
    CHECK_NOTHROW(instance->control().setState(host::wrapPluginState(hostileUid, withCrash)));
    CHECK(instance->control().getParameter(crash) == 0.0);
    std::uint64_t allocations = 1;
    CHECK(passesThrough(*instance, 2, allocations));
    CHECK(allocations == 0);
}
