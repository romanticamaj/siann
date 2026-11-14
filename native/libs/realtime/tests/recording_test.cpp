#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <random>
#include <span>
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
#include "support/signal_metrics.hpp"

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

host::AudioDeviceConfig config(int inputs, std::int64_t sampleRate = 48'000) {
    host::AudioDeviceConfig c;
    c.sampleRate = sampleRate;
    c.bufferFrames = kBlock;
    c.inputChannels = inputs;
    c.outputChannels = 2;
    return c;
}

// Frames in the data chunk as the WAV header on disk states them (-1 if the
// header cannot be read). Parsed here, not with the writer under test.
std::int64_t wavHeaderDataFrames(const fs::path& file, int channels) {
    std::ifstream in(file, std::ios::binary);
    char riff[12];
    if (!in.read(riff, 12) || std::string(riff, 4) != "RIFF" || std::string(riff + 8, 4) != "WAVE") {
        return -1;
    }
    char chunk[8];
    while (in.read(chunk, 8)) {
        const auto size = static_cast<std::uint32_t>(static_cast<unsigned char>(chunk[4])) |
                          static_cast<std::uint32_t>(static_cast<unsigned char>(chunk[5])) << 8 |
                          static_cast<std::uint32_t>(static_cast<unsigned char>(chunk[6])) << 16 |
                          static_cast<std::uint32_t>(static_cast<unsigned char>(chunk[7])) << 24;
        if (std::string(chunk, 4) == "data") {
            return static_cast<std::int64_t>(size) / (channels * 4);
        }
        in.seekg(static_cast<std::streamoff>(size + (size & 1u)), std::ios::cur);
    }
    return -1;
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
    CHECK(result.endedBy == realtime::EndedBy::stop);
    CHECK(realtime::endedByName(result.endedBy) == "stop");
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

TEST_CASE("maxFrames stops the capture after exactly that many frames, mid-block", "[record][maxframes]") {
    TempDir dir;
    GraphDriver driver({});
    driver.publish(clipGraph({}));
    Recorder::Options options;
    options.maxFrames = 3 * kBlock + 17;
    options.writerThread = false;
    Recorder recorder(2, options);
    driver.attachRecorder(&recorder);
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.play();
    driver.start(device, config(2));
    device.pump(2);

    recorder.start(dir.path() / "take.wav", 48'000);
    CHECK_FALSE(recorder.captureComplete());
    const auto before = rt::allocationViolations();
    device.pump(3);
    CHECK_FALSE(recorder.captureComplete());
    device.pump(7);
    CHECK(rt::allocationViolations() == before);
    CHECK(recorder.captureComplete());
    recorder.drain();
    const auto result = recorder.stop();

    // A new take starts a new count.
    recorder.start(dir.path() / "second.wav", 48'000);
    CHECK_FALSE(recorder.captureComplete());
    device.pump(1);
    CHECK(recorder.stop().frames == kBlock);
    driver.stop();

    CHECK(result.frames == 3 * kBlock + 17);
    CHECK(result.startPosition == 2 * kBlock);
    CHECK(result.overflows == 0);
    const auto take = readWav(result.file);
    REQUIRE(take.info.frames == 3 * kBlock + 17);
    for (std::int64_t i = 0; i < take.info.frames; ++i) {
        const std::int64_t frame = 2 * kBlock + i;
        if (take.samples[static_cast<std::size_t>(i * 2)] != inputValue(0, frame) ||
            take.samples[static_cast<std::size_t>(i * 2 + 1)] != inputValue(1, frame)) {
            FAIL("recorded sample differs at frame " << i);
        }
    }
}

TEST_CASE("onCheckpoint reports the frames the WAV header makes durable", "[record][checkpoint]") {
    TempDir dir;
    GraphDriver driver({});
    driver.publish(clipGraph({}));
    Recorder::Options options;
    options.writerThread = false;
    options.checkpointInterval = std::chrono::milliseconds(0);  // every drain() checkpoints
    Recorder recorder(1, options);
    driver.attachRecorder(&recorder);
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.play();
    driver.start(device, config(1));

    const fs::path file = dir.path() / "take.wav";
    std::vector<std::int64_t> reported;
    std::vector<std::int64_t> onDisk;
    recorder.start(file, 48'000, {}, [&](std::int64_t durableFrames) {
        reported.push_back(durableFrames);
        onDisk.push_back(wavHeaderDataFrames(file, 1));
    });
    device.pump(5);
    recorder.drain();
    REQUIRE(reported.size() == 1);
    CHECK(reported.back() == 5 * kBlock);
    CHECK(onDisk.back() == reported.back());
    CHECK(wavHeaderDataFrames(file, 1) == 5 * kBlock);

    device.pump(3);
    recorder.drain();
    REQUIRE(reported.size() == 2);
    CHECK(reported.back() == 8 * kBlock);
    CHECK(onDisk.back() == 8 * kBlock);

    device.pump(2);
    const auto result = recorder.stop();  // the final checkpoint is reported too
    driver.stop();
    REQUIRE(reported.size() >= 3);
    CHECK(reported.back() == result.frames);
    CHECK(result.frames == 10 * kBlock);
    CHECK(wavHeaderDataFrames(file, 1) == result.frames);
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

// The writer falls behind (a stalled disk), then catches up: the block that
// did not fit must not leave a hole in the take. The take ends at the last
// frame before the overflow (spec, "Recording": an overflow stops the take,
// keeps everything captured before it and is reported).
TEST_CASE("An overflow ends the take at the last contiguous frame, even after the writer catches up",
          "[record][overflow]") {
    TempDir dir;
    GraphDriver driver({});
    driver.publish(clipGraph({}));
    Recorder::Options options;
    options.ringFrames = 2 * kBlock;
    options.writerThread = false;  // the test is the writer: it stalls, then drains
    Recorder recorder(2, options);
    driver.attachRecorder(&recorder);
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.play();
    driver.start(device, config(2));
    device.pump(3);

    recorder.start(dir.path() / "take.wav", 48'000);
    CHECK_FALSE(recorder.overflowed());
    const auto before = rt::allocationViolations();
    device.pump(2);  // fills the ring
    device.pump(1);  // the writer is stalled: this block does not fit
    CHECK(recorder.overflowed());
    CHECK(recorder.captureEnded());
    recorder.drain();  // the writer catches up
    device.pump(4);    // later blocks would fit again, but the take has ended
    CHECK(rt::allocationViolations() == before);
    const auto result = recorder.stop();
    driver.stop();

    CHECK(result.overflows == 5);  // the block that did not fit and the four after it
    CHECK(result.endedBy == realtime::EndedBy::overflow);
    CHECK(realtime::endedByName(result.endedBy) == "overflow");
    CHECK(result.frames == 2 * kBlock);
    CHECK(result.startPosition == 3 * kBlock);
    const auto take = readWav(result.file);
    REQUIRE(take.info.frames == 2 * kBlock);
    for (std::int64_t i = 0; i < take.info.frames; ++i) {
        const std::int64_t frame = 3 * kBlock + i;
        if (take.samples[static_cast<std::size_t>(i * 2)] != inputValue(0, frame) ||
            take.samples[static_cast<std::size_t>(i * 2 + 1)] != inputValue(1, frame)) {
            FAIL("the take is not one contiguous run of the input at frame " << i);
        }
    }
}

namespace {

// A take writer whose disk fills after `limit` frames: appends past it throw, as
// a full disk or a failed write does. What fitted is written to a real WAV.
class FullDiskWriter final : public realtime::TakeWriter {
public:
    FullDiskWriter(const fs::path& file, int channels, std::int64_t sampleRate, std::int64_t limit)
        : inner_(file, channels, sampleRate), limit_(limit) {}
    void append(const host::AudioBufferView& source, int frames) override {
        if (inner_.frames() + frames > limit_) {
            throw std::runtime_error("no space left on the device");
        }
        inner_.append(source, frames);
    }
    void checkpoint() override { inner_.checkpoint(); }
    void close() override { inner_.close(); }
    std::int64_t frames() const noexcept override { return inner_.frames(); }

private:
    media::WavStreamWriter inner_;
    std::int64_t limit_;
};

Recorder::Options fullDiskAfter(std::int64_t limit, bool writerThread) {
    Recorder::Options options;
    options.writerThread = writerThread;
    options.writerFactory = [limit](const fs::path& file, int channels, std::int64_t sampleRate) {
        return std::make_unique<FullDiskWriter>(file, channels, sampleRate, limit);
    };
    return options;
}

}  // namespace

// m5b-engine-record (spec, "Recording": a write failure stops recording, keeps
// everything written so far, and reports it): the writer catches the failure,
// the audio thread captures nothing more, and the result says `disk`.
TEST_CASE("A writer failure ends the take, keeps what was written and reports disk", "[record][disk]") {
    TempDir dir;
    GraphDriver driver({});
    driver.publish(clipGraph({}));
    Recorder recorder(2, fullDiskAfter(3 * kBlock, false));
    driver.attachRecorder(&recorder);
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.play();
    driver.start(device, config(2));

    recorder.start(dir.path() / "take.wav", 48'000);
    device.pump(3);
    CHECK_NOTHROW(recorder.drain());  // three blocks fit
    CHECK_FALSE(recorder.diskFailed());
    device.pump(2);
    CHECK_NOTHROW(recorder.drain());  // the fourth does not
    CHECK(recorder.diskFailed());
    CHECK(recorder.captureEnded());
    const auto before = rt::allocationViolations();
    device.pump(4);  // nothing more is captured
    CHECK(rt::allocationViolations() == before);
    Recorder::Result result;
    CHECK_NOTHROW(result = recorder.stop());
    driver.stop();

    CHECK(result.endedBy == realtime::EndedBy::disk);
    CHECK(realtime::endedByName(result.endedBy) == "disk");
    CHECK(result.overflows == 0);
    CHECK(result.frames == 3 * kBlock);
    const auto take = readWav(result.file);  // readable, with every frame that was written
    REQUIRE(take.info.frames == 3 * kBlock);
    for (std::int64_t i = 0; i < take.info.frames; ++i) {
        if (take.samples[static_cast<std::size_t>(i * 2)] != inputValue(0, i)) {
            FAIL("kept sample differs at frame " << i);
        }
    }
}

TEST_CASE("No exception escapes the writer thread", "[record][disk]") {
    TempDir dir;
    GraphDriver driver({});
    driver.publish(clipGraph({}));
    Recorder recorder(2, fullDiskAfter(0, true));  // the first append fails, on the writer thread
    driver.attachRecorder(&recorder);
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.play();
    driver.start(device, config(2));
    recorder.start(dir.path() / "take.wav", 48'000);
    device.pump(20);
    // An escaped exception would have ended the process; stop() joins the thread.
    const Recorder::Result result = recorder.stop();
    driver.stop();
    CHECK(recorder.diskFailed());
    CHECK(result.endedBy == realtime::EndedBy::disk);
    CHECK(result.frames == 0);
}

TEST_CASE("A failing onStart is a disk failure too", "[record][disk]") {
    TempDir dir;
    GraphDriver driver({});
    driver.publish(clipGraph({}));
    Recorder::Options options;
    options.writerThread = false;
    Recorder recorder(1, options);
    driver.attachRecorder(&recorder);
    host::ManualAudioDevice device;
    driver.play();
    driver.start(device, config(1));
    recorder.start(dir.path() / "take.wav", 48'000,
                   [](std::int64_t) { throw std::runtime_error("the manifest cannot be written"); });
    device.pump(2);
    CHECK_NOTHROW(recorder.drain());
    CHECK(recorder.diskFailed());
    const Recorder::Result result = recorder.stop();
    driver.stop();
    CHECK(result.endedBy == realtime::EndedBy::disk);
    CHECK(result.frames == 0);  // nothing is written without a known position
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
    const std::int64_t offset = driver.latency().recordOffsetFrames;
    CHECK(offset == 0 + driver.deviceStatus().outputLatencyFrames + driver.deviceStatus().inputLatencyFrames);
    CHECK(offset == 128);
    CHECK(result.startPosition - offset + found == 10'000);
}

TEST_CASE("Loopback null test through input and output SRC", "[record][latency][src]") {
    TempDir dir;
    // A 44.1 kHz session on a device fixed at 48 kHz; the impulse at timeline
    // sample 14,700 (1/3 s). Device latencies of 160 and 320 frames are 147 and
    // 294 session frames.
    auto impulse = std::make_shared<graph::PlanarAudio>();
    impulse->channels = 1;
    impulse->frames = 1;
    impulse->data = {{1.0f}};
    GraphDriver driver({});
    driver.publish(clipGraph({{14'700, 0, 1, 1.0f, impulse}}));
    Recorder recorder(1, Recorder::Options{});
    driver.attachRecorder(&recorder);

    host::FakeAudioDevice::Options options;
    options.fixedSampleRate = 48'000;
    options.loopback = true;
    options.inputLatencyFrames = 160;
    options.outputLatencyFrames = 320;
    host::FakeAudioDevice device(options);
    recorder.start(dir.path() / "take.wav", 44'100);
    driver.play();
    const auto before = rt::allocationViolations();
    driver.start(device, config(1, 44'100));
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (driver.playhead() < 22'050 && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    driver.stop();
    CHECK(rt::allocationViolations() == before);
    const auto result = recorder.stop();
    CHECK(result.overflows == 0);

    const auto latency = driver.latency();
    CHECK(driver.resampling().active);
    CHECK(latency.inputLatencyFrames == 147);
    CHECK(latency.outputLatencyFrames == 294);
    CHECK(latency.recordOffsetFrames ==
          294 + 147 + latency.srcOutputLatencyFrames + latency.srcInputLatencyFrames);

    const auto take = readWav(result.file);
    CHECK(take.info.sampleRate == 44'100);
    const auto peak = test::peakIndex(std::span<const float>(take.samples.data(), take.samples.size()));
    REQUIRE(peak >= 0);
    const std::int64_t placed = result.startPosition - latency.recordOffsetFrames + peak;
    INFO("placed at " << placed);
    CHECK(std::llabs(placed - 14'700) <= 1);
}
