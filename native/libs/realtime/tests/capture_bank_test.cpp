// The capture bank (m5b-engine-record; spec, "Recording"): preallocated slots,
// each a Recorder with a channel map into the device input and an armed flag,
// armed and disarmed while the device runs. The driver feeds every slot each
// callback and meters the armed ones, also while the transport is stopped. This
// binary links siann_rt_alloc_guard and ManualAudioDevice marks its callback
// realtime, so an allocation on the audio path counts as a violation.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/media/audio.hpp"
#include "siann/realtime/capture_bank.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/realtime/recorder.hpp"
#include "siann/rt/realtime_thread.hpp"

namespace fs = std::filesystem;
using namespace siann;
using realtime::CaptureBank;
using realtime::GraphDriver;
using realtime::Recorder;

namespace {

constexpr int kBlock = 64;
constexpr int kInputs = 4;

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-bank-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    const fs::path& path() const { return path_; }

private:
    fs::path path_;
};

std::unique_ptr<graph::PreparedGraph> silentGraph() {
    graph::GraphBuilder b;
    b.setOutput(b.add(std::make_unique<graph::ClipPlayerNode>(2, std::vector<graph::ClipPlayerNode::Clip>{}), "clips"));
    return std::move(b).compile(kBlock);
}

host::AudioDeviceConfig config() {
    host::AudioDeviceConfig c;
    c.sampleRate = 48'000;
    c.bufferFrames = kBlock;
    c.inputChannels = kInputs;
    c.outputChannels = 2;
    return c;
}

// Every channel and frame distinct, so a wrong channel or a gap shows.
float inputValue(int channel, std::int64_t frame) {
    return static_cast<float>(channel + 1) * 0.1f + static_cast<float>(frame % 1'000) / 100'000.0f;
}

media::AudioBuffer readWav(const fs::path& file) {
    std::ifstream in(file, std::ios::binary);
    return media::decodeWav(std::string(std::istreambuf_iterator<char>(in), {}));
}

GraphDriver::Options withBank(std::size_t slots) {
    GraphDriver::Options options;
    options.capture.slots = slots;
    options.capture.recorder.writerThread = false;  // the test drains
    return options;
}

}  // namespace

TEST_CASE("A capture bank arms and disarms its slots while the device runs, without allocating",
          "[record][bank][rt]") {
    TempDir dir;
    GraphDriver driver(withBank(4));
    REQUIRE(driver.captureBank() != nullptr);
    CaptureBank& bank = *driver.captureBank();
    CHECK(bank.size() == 4);
    driver.publish(silentGraph());
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.start(device, config());

    const auto before = rt::allocationViolations();
    device.pump(2);
    bank.arm(0, 1, 1);
    CHECK(bank.armed(0));
    CHECK_FALSE(bank.armed(1));
    device.pump(2);
    bank.arm(1, 2, 2);
    device.pump(2);
    bank.disarm(0);
    CHECK_FALSE(bank.armed(0));
    device.pump(2);
    bank.arm(0, 0, 2);  // armed again with another map
    device.pump(2);
    CHECK(rt::allocationViolations() == before);

    // A recording slot on the running device: the take starts at the next block.
    bank.recorder(0).start(dir.path() / "take.wav", 48'000, {}, {}, 2);
    driver.play();
    const auto recording = rt::allocationViolations();
    device.pump(5);
    bank.recorder(0).drain();
    device.pump(3);
    CHECK(rt::allocationViolations() == recording);
    const Recorder::Result result = bank.recorder(0).stop();
    driver.stop();
    CHECK(result.frames == 8 * kBlock);
    CHECK(result.endedBy == realtime::EndedBy::stop);
}

TEST_CASE("Each slot captures its own channels, and two slots share the block's stamp", "[record][bank]") {
    TempDir dir;
    GraphDriver driver(withBank(2));
    CaptureBank& bank = *driver.captureBank();
    driver.publish(silentGraph());
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.play();
    driver.start(device, config());
    device.pump(3);

    bank.arm(0, 1, 1);  // device input channel 1 only
    bank.arm(1, 2, 2);  // channels 2 and 3
    bank.recorder(0).start(dir.path() / "mono.wav", 48'000, {}, {}, 1);
    bank.recorder(1).start(dir.path() / "stereo.wav", 48'000, {}, {}, 2);
    device.pump(6);
    const Recorder::Result mono = bank.recorder(0).stop();
    const Recorder::Result stereo = bank.recorder(1).stop();
    driver.stop();

    CHECK(mono.startPosition == 3 * kBlock);
    CHECK(stereo.startPosition == mono.startPosition);
    CHECK(mono.frames == 6 * kBlock);
    CHECK(stereo.frames == 6 * kBlock);

    const media::AudioBuffer one = readWav(mono.file);
    REQUIRE(one.info.channels == 1);
    REQUIRE(one.info.frames == 6 * kBlock);
    for (std::int64_t i = 0; i < one.info.frames; ++i) {
        if (one.samples[static_cast<std::size_t>(i)] != inputValue(1, 3 * kBlock + i)) {
            FAIL("the mono slot differs from input channel 1 at frame " << i);
        }
    }
    const media::AudioBuffer two = readWav(stereo.file);
    REQUIRE(two.info.channels == 2);
    for (std::int64_t i = 0; i < two.info.frames; ++i) {
        if (two.samples[static_cast<std::size_t>(i * 2)] != inputValue(2, 3 * kBlock + i) ||
            two.samples[static_cast<std::size_t>(i * 2 + 1)] != inputValue(3, 3 * kBlock + i)) {
            FAIL("the stereo slot differs from input channels 2 and 3 at frame " << i);
        }
    }
}

TEST_CASE("Armed slots are metered while the transport is stopped and while it plays", "[record][bank][meters]") {
    GraphDriver driver(withBank(3));
    CaptureBank& bank = *driver.captureBank();
    driver.publish(silentGraph());
    host::ManualAudioDevice device;
    // A constant level per channel: peak and RMS are that level.
    device.setInputGenerator([](int channel, std::int64_t) { return channel == 0 ? 0.5f : -0.25f; });
    driver.start(device, config());

    bank.arm(0, 0, 2);
    bank.arm(2, 1, 1);
    const auto before = rt::allocationViolations();
    device.pump(2);  // stopped
    CHECK(rt::allocationViolations() == before);
    const realtime::InputMeterReading stopped = bank.meter(0);
    CHECK(stopped.blocks == 2);
    REQUIRE(stopped.channels == 2);
    CHECK(stopped.peak[0] == 0.5f);
    CHECK(stopped.peak[1] == 0.25f);
    CHECK(std::abs(stopped.rms[0] - 0.5f) < 1e-6f);
    CHECK(std::abs(stopped.rms[1] - 0.25f) < 1e-6f);
    const realtime::InputMeterReading mono = bank.meter(2);
    REQUIRE(mono.channels == 1);
    CHECK(mono.peak[0] == 0.25f);
    CHECK(bank.meter(1).blocks == 0);  // never armed: no reading

    driver.play();
    device.pump(3);
    CHECK(bank.meter(0).blocks == 5);
    CHECK(bank.meter(0).peak[0] == 0.5f);

    bank.disarm(0);
    device.pump(2);
    CHECK(bank.meter(0).blocks == 5);  // a disarmed slot is not metered
    CHECK(bank.meter(2).blocks == 7);
    driver.stop();
}

TEST_CASE("The cycle wrap is suspended while capture is active", "[record][bank][cycle]") {
    GraphDriver driver(withBank(1));
    driver.publish(silentGraph());
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.pushCycle(realtime::CycleCommand{true, 2 * kBlock, 4 * kBlock + 10, 1});
    driver.play();
    driver.start(device, config());
    CHECK_FALSE(driver.captureActive());

    driver.setCaptureActive(true);
    CHECK(driver.captureActive());
    device.pump(8);
    CHECK(driver.cycleWraps() == 0);
    CHECK(driver.playhead() == 8 * kBlock);  // straight through the right locator

    // Capture over: a playhead past the right locator plays on, one before it wraps.
    driver.setCaptureActive(false);
    device.pump(2);
    CHECK(driver.cycleWraps() == 0);
    driver.pushLocate(realtime::TransportCommand{2, kBlock, true});
    device.pump(12);  // the locate's duck, then from frame 64 across the right locator
    CHECK(driver.cycleWraps() >= 1);
    driver.stop();
}
