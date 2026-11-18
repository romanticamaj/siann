// The count-in (m5b-engine-punch-count-in; spec, "Click"): a locate that carries
// a start and a count-in holds the transport at its position for bars x 4 beats
// of click, the first and every fourth accented, at the click's gain whether or
// not the metronome is on, and then starts the transport at the frame the next
// beat would fall on, within one sample, splitting the device callback there.
// Everything runs on a ManualAudioDevice, one block at a time; the binary links
// siann_rt_alloc_guard, so an allocation on the audio path counts as a violation.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <span>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/realtime/click.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/rt/realtime_thread.hpp"

using namespace siann;
using realtime::GraphDriver;
using realtime::TransportCommand;

namespace {

constexpr int kBlock = 64;
constexpr std::int64_t kRate = 48'000;
// 97 BPM: 29690.72... frames a beat, a fractional beat length.
constexpr std::int32_t kMilliBpm = 97'000;
constexpr double kBeatFrames = static_cast<double>(kRate) * 60'000.0 / kMilliBpm;
constexpr std::int64_t kHeld = 5'000;  // the position the transport is held at

// Silence on two channels: the output is the click alone.
class SilentNode final : public graph::Node {
public:
    int outputChannels() const override { return 2; }
    void process(const graph::ProcessContext& context, std::span<const graph::AudioBufferView>,
                 const graph::AudioBufferView& output) noexcept override {
        for (int c = 0; c < 2; ++c) {
            for (int i = 0; i < context.frames; ++i) {
                output.channel(c)[i] = 0.0f;
            }
        }
    }
};

std::unique_ptr<graph::PreparedGraph> silentGraph() {
    graph::GraphBuilder b;
    b.setOutput(b.add(std::make_unique<SilentNode>(), "silence"));
    return std::move(b).compile(kBlock);
}

host::AudioDeviceConfig config() {
    host::AudioDeviceConfig c;
    c.sampleRate = kRate;
    c.bufferFrames = kBlock;
    c.outputChannels = 2;
    return c;
}

// Each burst's first non-zero sample after at least `gap` zeros.
std::vector<std::int64_t> onsets(const std::vector<float>& samples, std::size_t gap = 2'000) {
    std::vector<std::int64_t> out;
    std::size_t zeros = gap;
    for (std::size_t i = 0; i < samples.size(); ++i) {
        if (samples[i] != 0.0f) {
            if (zeros >= gap) {
                out.push_back(static_cast<std::int64_t>(i));
            }
            zeros = 0;
        } else {
            ++zeros;
        }
    }
    return out;
}

std::vector<float> slice(const std::vector<float>& v, std::int64_t from, std::int64_t n) {
    return {v.begin() + from, v.begin() + from + n};
}

TransportCommand countedStart(int bars) {
    TransportCommand command{1, kHeld, true};
    command.countIn = realtime::CountIn{bars * 4, kBeatFrames};
    return command;
}

}  // namespace

TEST_CASE("a count-in plays bars x 4 clicks with the playhead held, with the metronome off, and the playhead starts "
          "at the expected frame within one sample",
          "[driver][countin][click][alloc]") {
    GraphDriver driver({});
    driver.publish(silentGraph());
    driver.setClickTempo(realtime::ClickTempo::build({time::TempoPoint{time::MusicTime{0}, kMilliBpm}}, kRate));
    driver.setClick(false, 0.5f);  // the metronome is off; its gain applies
    host::ManualAudioDevice device;
    driver.start(device, config());
    REQUIRE(driver.pushLocate(countedStart(2)));  // two bars: eight beats

    const auto expectedStart = static_cast<std::int64_t>(std::llround(8 * kBeatFrames));
    REQUIRE(expectedStart % kBlock != 0);  // the start falls inside a callback
    std::vector<std::vector<float>> capture;
    const auto before = rt::allocationViolations();
    std::int64_t pumped = 0;
    std::int64_t startedAt = -1;
    while (pumped < expectedStart + 20 * kBlock) {
        device.pumpAll(1, capture);
        pumped += kBlock;
        driver.poll();
        if (startedAt < 0 && driver.playhead() != kHeld) {
            // The playhead moved within this callback: it started that many frames before its end.
            startedAt = pumped - (driver.playhead() - kHeld);
        }
        if (startedAt < 0) {
            CHECK(driver.countingIn());
            CHECK_FALSE(driver.playing());
        }
    }
    CHECK(rt::allocationViolations() == before);
    CHECK_FALSE(driver.countingIn());
    CHECK(driver.playing());
    CHECK(startedAt == expectedStart);
    CHECK(std::fabs(static_cast<double>(startedAt) - 8 * kBeatFrames) <= 1.0);
    CHECK(driver.playhead() == kHeld + pumped - expectedStart);
    driver.stop();

    // Eight clicks, beat k at round(k x beatFrames), and none after the start (the
    // metronome is off).
    const std::vector<std::int64_t> found = onsets(capture[0]);
    REQUIRE(found.size() == 8);
    for (int k = 0; k < 8; ++k) {
        CHECK(found[static_cast<std::size_t>(k)] == std::llround(k * kBeatFrames));
    }
    // The first beat and every fourth are accented: beats 0 and 4 sound alike and
    // differ from beat 1, which sounds like beat 2.
    const std::int64_t burst = 400;
    CHECK(slice(capture[0], found[0], burst) == slice(capture[0], found[4], burst));
    CHECK(slice(capture[0], found[1], burst) == slice(capture[0], found[2], burst));
    CHECK(slice(capture[0], found[0], burst) != slice(capture[0], found[1], burst));
    // At the click's gain: the loudest sample of a burst is at most the gain.
    float peak = 0.0f;
    for (const float v : capture[0]) {
        peak = std::max(peak, std::fabs(v));
    }
    CHECK(peak > 0.1f);
    CHECK(peak <= 0.5f);
}

TEST_CASE("no click outside the count-in while the metronome is off", "[driver][countin][click]") {
    GraphDriver driver({});
    driver.publish(silentGraph());
    driver.setClickTempo(realtime::ClickTempo::build({time::TempoPoint{time::MusicTime{0}, kMilliBpm}}, kRate));
    driver.setClick(false, 1.0f);
    host::ManualAudioDevice device;
    driver.start(device, config());
    // A plain start: the transport plays two seconds with no click.
    REQUIRE(driver.pushLocate(TransportCommand{1, kHeld, true}));
    std::vector<std::vector<float>> capture;
    for (int b = 0; b < 2 * kRate / kBlock; ++b) {
        device.pumpAll(1, capture);
        driver.poll();
    }
    CHECK_FALSE(driver.countingIn());
    CHECK(driver.playhead() == kHeld + 2 * kRate);
    CHECK(onsets(capture[0]).empty());
    driver.stop();
}

TEST_CASE("a pause during the count-in ends it with the transport stopped", "[driver][countin]") {
    GraphDriver driver({});
    driver.publish(silentGraph());
    host::ManualAudioDevice device;
    driver.start(device, config());
    REQUIRE(driver.pushLocate(countedStart(1)));
    std::vector<std::vector<float>> capture;
    device.pumpAll(10, capture);
    CHECK(driver.countingIn());
    driver.pause(1);
    device.pumpAll(2'000, capture);  // past where the count-in would have ended
    CHECK_FALSE(driver.countingIn());
    CHECK_FALSE(driver.playing());
    CHECK(driver.playhead() == kHeld);
    // One click sounded before the pause, none after it.
    CHECK(onsets(capture[0]).size() == 1);
    driver.stop();
}
