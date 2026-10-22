#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/fake_audio_device.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/media/audio.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/realtime/recorder.hpp"
#include "siann/rt/realtime_thread.hpp"

namespace fs = std::filesystem;
using namespace siann;
using realtime::GraphDriver;
using realtime::Recorder;

namespace {

constexpr int kBlock = 64;

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-record-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

std::unique_ptr<graph::PreparedGraph> clipGraph(std::vector<graph::ClipPlayerNode::Clip> clips) {
    graph::GraphBuilder b;
    b.setOutput(b.add(std::make_unique<graph::ClipPlayerNode>(2, std::move(clips)), "clips"));
    return std::move(b).compile(kBlock);
}

media::AudioBuffer readWav(const fs::path& file) {
    std::ifstream in(file, std::ios::binary);
    return media::decodeWav(std::string(std::istreambuf_iterator<char>(in), {}));
}

host::AudioDeviceConfig config(int inputs) {
    host::AudioDeviceConfig c;
    c.sampleRate = 48'000;
    c.bufferFrames = kBlock;
    c.inputChannels = inputs;
    c.outputChannels = 2;
    return c;
}

float inputValue(int channel, std::int64_t frame) {
    const float v = static_cast<float>(frame % 50'000) / 100'000.0f;
    return channel == 0 ? v : -v;
}

}  // namespace

TEST_CASE("Recording captures the input from the block where it was armed", "[record]") {
    TempDir dir;
    GraphDriver driver({});
    driver.publish(clipGraph({}));
    Recorder recorder(2, Recorder::Options{});
    driver.attachRecorder(&recorder);
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.play();
    driver.start(device, config(2));
    device.pump(10);

    std::int64_t reportedStart = Recorder::kNoStart;
    const auto before = rt::allocationViolations();
    recorder.start(dir.path() / "take.wav", 48'000, [&](std::int64_t start) { reportedStart = start; });
    device.pump(50);
    const auto result = recorder.stop();
    CHECK(rt::allocationViolations() == before);
    driver.stop();

    CHECK(result.frames == 50 * kBlock);
    CHECK(result.startPosition == 10 * kBlock);
    CHECK(reportedStart == 10 * kBlock);
    CHECK(result.overflows == 0);
    const auto take = readWav(result.file);
    REQUIRE(take.info.frames == 50 * kBlock);
    for (std::int64_t i = 0; i < take.info.frames; ++i) {
        const std::int64_t frame = 10 * kBlock + i;
        if (take.samples[static_cast<std::size_t>(i * 2)] != inputValue(0, frame) ||
            take.samples[static_cast<std::size_t>(i * 2 + 1)] != inputValue(1, frame)) {
            FAIL("recorded sample differs at frame " << i);
        }
    }
}

TEST_CASE("Nothing is captured while the transport is stopped", "[record]") {
    TempDir dir;
    GraphDriver driver({});
    driver.publish(clipGraph({}));
    Recorder recorder(2, Recorder::Options{});
    driver.attachRecorder(&recorder);
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.start(device, config(2));  // not playing
    recorder.start(dir.path() / "take.wav", 48'000);
    device.pump(20);
    const auto result = recorder.stop();
    driver.stop();
    CHECK(result.frames == 0);
}

TEST_CASE("A full ring is counted as an overflow and never blocks", "[record]") {
    TempDir dir;
    GraphDriver driver({});
    driver.publish(clipGraph({}));
    Recorder::Options options;
    options.ringFrames = 128;
    options.writerThread = false;  // nothing drains while we pump
    Recorder recorder(2, options);
    driver.attachRecorder(&recorder);
    host::ManualAudioDevice device;
    driver.play();
    driver.start(device, config(2));
    recorder.start(dir.path() / "take.wav", 48'000);
    device.pump(10);
    const auto result = recorder.stop();
    driver.stop();
    CHECK(result.overflows == 8);  // two blocks fit, eight did not
    CHECK(result.frames == 128);
}

TEST_CASE("Loopback null test: a recorded take lands where it was played", "[record][latency]") {
    TempDir dir;
    // An impulse at timeline sample 10,000.
    auto impulse = std::make_shared<graph::PlanarAudio>();
    impulse->channels = 1;
    impulse->frames = 1;
    impulse->data = {{1.0f}};
    GraphDriver driver({});
    driver.publish(clipGraph({{10'000, 0, 1, 1.0f, impulse}}));
    Recorder recorder(1, Recorder::Options{});
    driver.attachRecorder(&recorder);

    host::FakeAudioDevice::Options options;
    options.loopback = true;
    options.inputLatencyFrames = 48;
    options.outputLatencyFrames = 80;
    host::FakeAudioDevice device(options);
    recorder.start(dir.path() / "take.wav", 48'000);
    driver.play();
    driver.start(device, config(1));
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (driver.playhead() < 20'000 && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    driver.stop();
    const auto result = recorder.stop();

    const auto take = readWav(result.file);
    std::int64_t found = -1;
    for (std::int64_t i = 0; i < take.info.frames; ++i) {
        if (take.samples[static_cast<std::size_t>(i)] != 0.0f) {
            found = i;
            break;
        }
    }
    REQUIRE(found >= 0);
    // Recording offset (spec, "Latency model"): the monitored path's latency
    // (0 here) plus the device's output and input latency.
    const std::int64_t offset = 0 + driver.deviceStatus().outputLatencyFrames + driver.deviceStatus().inputLatencyFrames;
    CHECK(offset == 128);
    CHECK(result.startPosition - offset + found == 10'000);
}
