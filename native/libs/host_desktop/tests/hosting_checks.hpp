#pragma once

// What the hosting tests share, whichever format carries the plugin. siann_test_plugin
// is a known delay, so latency is checked against audio, not only against a number.

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "siann/host/juce_plugin_host.hpp"
#include "siann/rt/mpsc_queue.hpp"
#include "siann/rt/realtime_thread.hpp"

namespace siann::hosting_test {

inline constexpr std::int64_t sampleRate = 48'000;
inline constexpr int blockFrames = 256;
inline constexpr auto eventTimeout = std::chrono::seconds(5);
inline constexpr int longTailFrames = 12'000;  // the test plugin's quarter second, at sampleRate

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
inline DelayMeasurement measureDelay(host::PluginInstance& instance, int channels = 2) {
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
inline void runBlocks(host::PluginInstance& instance) {
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

// What the audio thread gets from tailFrames().
inline int tailFramesOnAudioThread(host::PluginInstance& instance) {
    int frames = -1;
    std::thread audio([&] {
        const rt::ScopedRealtimeThread realtime;
        frames = instance.tailFrames();
    });
    audio.join();
    return frames;
}

inline int parameterIndex(host::PluginInstance& instance, const std::string& name) {
    const auto parameters = instance.control().parameters();
    for (std::size_t i = 0; i < parameters.size(); ++i) {
        if (parameters[i].name == name) {
            return static_cast<int>(i);
        }
    }
    FAIL("the plugin has no parameter named " << name);
    return -1;
}

inline bool displayAvailable() {
#if defined(__linux__)
    return std::getenv("DISPLAY") != nullptr;
#else
    return true;
#endif
}

// The latency the plugin reports through the event sink next, or -1 on timeout.
inline int nextReportedLatency(host::MainThreadLoop& loop, rt::MpscQueue<host::PluginEvent>& events) {
    int reported = -1;
    loop.runUntil(
        [&] {
            host::PluginEvent event;
            while (events.pop(event)) {
                if (event.kind == host::PluginEvent::Kind::latencyChanged) {
                    reported = event.latencyFrames;
                }
            }
            return reported >= 0;
        },
        eventTimeout);
    return reported;
}

// Acceptance item 2 against siann_test_plugin, in whichever format the descriptor
// names: a runtime latency change, reported and heard; state that really moves a
// default instance; and the editor.
inline void checkBuiltTestPlugin(host::MainThreadLoop& loop, host::JucePluginHost& host,
                                 const host::PluginDescriptor& descriptor) {
    rt::MpscQueue<host::PluginEvent> events(64);
    auto instance = host.instantiate(descriptor, sampleRate, blockFrames);
    instance->control().setEventSink([&](const host::PluginEvent& event) { events.push(event); });
    const int gain = parameterIndex(*instance, "gain");
    const int latency = parameterIndex(*instance, "latency");
    CHECK(instance->latencyFrames() == 64);
    CHECK(measureDelay(*instance).frames == 64);

    instance->control().setParameter(latency, 1.0);
    CHECK(nextReportedLatency(loop, events) == 512);
    CHECK(instance->latencyFrames() == 512);
    CHECK(instance->tailFrames() == longTailFrames);
    CHECK(measureDelay(*instance).frames == 512);

    instance->control().setParameter(gain, 0.25);
    instance->control().setParameter(parameterIndex(*instance, "tail"), 1.0);  // state; no latency change
    const auto state = instance->control().getState();
    auto restored = host.instantiate(descriptor, sampleRate, blockFrames);
    CHECK(restored->control().getParameter(gain) == Catch::Approx(1.0));
    CHECK(restored->control().getParameter(latency) == Catch::Approx(0.0));
    CHECK(restored->latencyFrames() == 64);
    CHECK(restored->tailFrames() == 0);
    restored->control().setState(state);
    // On return: setState's own tail read. A hosted VST3's controller also reports
    // a restart here, which reads it again; a hosted AU reports nothing
    // synchronously, so on macOS this line stands on that read alone.
    CHECK(restored->tailFrames() == longTailFrames);
    CHECK(restored->control().getParameter(gain) == Catch::Approx(0.25));
    CHECK(restored->control().getParameter(latency) == Catch::Approx(1.0));
    REQUIRE(loop.runUntil([&] { return restored->latencyFrames() == 512; }, eventTimeout));
    const auto delayed = measureDelay(*restored);
    CHECK(delayed.frames == 512);
    CHECK(delayed.peak == Catch::Approx(0.25f));

    if (displayAvailable()) {
        restored->control().openEditor({});
        CHECK(restored->control().editorOpen());
        CHECK(restored->control().editorNativeHandle() != 0);
        restored->control().closeEditor();
        CHECK_FALSE(restored->control().editorOpen());
        CHECK(restored->control().editorNativeHandle() == 0);
    }
    instance->control().setEventSink(nullptr);
}

}  // namespace siann::hosting_test
