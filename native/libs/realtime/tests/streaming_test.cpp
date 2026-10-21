#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <memory>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/fake_audio_device.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/media/audio.hpp"
#include "siann/media/wav_file_reader.hpp"
#include "siann/realtime/disk_stream.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/rt/realtime_thread.hpp"

namespace fs = std::filesystem;
using namespace siann;
using realtime::Butler;
using realtime::DiskStream;
using realtime::FrameRing;
using realtime::GraphDriver;
using realtime::StreamClip;
using realtime::StreamingPlayerNode;
using realtime::TransportCommand;

namespace {

constexpr int kBlock = 64;

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-stream-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

// A stereo file whose every sample is distinct, so misalignment shows.
fs::path writeMedia(const fs::path& file, std::int64_t frames) {
    media::AudioBuffer b;
    b.info = media::AudioInfo{2, 48'000, frames};
    for (std::int64_t i = 0; i < frames; ++i) {
        b.samples.push_back(static_cast<float>(i % 9'973) / 10'000.0f);
        b.samples.push_back(-static_cast<float>(i % 7'919) / 10'000.0f);
    }
    const std::string bytes = media::encodeWavFloat32(b);
    std::ofstream(file, std::ios::binary).write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    return file;
}

struct Clips {
    std::vector<graph::ClipPlayerNode::Clip> reference;
    std::vector<StreamClip> streamed;
};

Clips makeClips(const fs::path& file) {
    const auto decoded = media::decodeWav([&] {
        std::ifstream in(file, std::ios::binary);
        return std::string(std::istreambuf_iterator<char>(in), {});
    }());
    auto planar = std::make_shared<graph::PlanarAudio>();
    planar->channels = 2;
    planar->frames = decoded.info.frames;
    planar->data.assign(2, std::vector<float>(static_cast<std::size_t>(planar->frames)));
    for (std::size_t i = 0; i < static_cast<std::size_t>(planar->frames); ++i) {
        planar->data[0][i] = decoded.samples[i * 2];
        planar->data[1][i] = decoded.samples[i * 2 + 1];
    }
    auto reader = std::make_shared<media::WavFileReader>(file);
    // Three clips, two of them overlapping, with gains and trims.
    const struct {
        std::int64_t at, from, length;
        float gain;
    } layout[] = {{1'000, 0, 20'000, 1.0f}, {15'000, 5'000, 30'000, 0.5f}, {60'000, 100, 10'000, 0.25f}};
    Clips clips;
    for (const auto& l : layout) {
        clips.reference.push_back({l.at, l.from, l.length, l.gain, planar});
        clips.streamed.push_back({l.at, l.from, l.length, l.gain, reader});
    }
    return clips;
}

// The reference: the offline clip player rendered at the given position.
class Reference {
public:
    explicit Reference(std::vector<graph::ClipPlayerNode::Clip> clips) {
        graph::GraphBuilder b;
        b.setOutput(b.add(std::make_unique<graph::ClipPlayerNode>(2, std::move(clips)), "clips"));
        graph_ = std::move(b).compile(kBlock);
    }
    std::vector<float> left(std::int64_t position, int frames) {
        std::vector<float> out;
        for (int done = 0; done < frames; done += kBlock) {
            graph_->process(graph::ProcessContext{position + done, kBlock});
            out.insert(out.end(), graph_->output().channel(0), graph_->output().channel(0) + kBlock);
        }
        return out;
    }

private:
    std::unique_ptr<graph::PreparedGraph> graph_;
};

std::unique_ptr<graph::PreparedGraph> streamingGraph(DiskStream& stream) {
    graph::GraphBuilder b;
    b.setOutput(b.add(std::make_unique<StreamingPlayerNode>(stream), "stream"));
    return std::move(b).compile(kBlock);
}

host::AudioDeviceConfig config() {
    host::AudioDeviceConfig c;
    c.sampleRate = 48'000;
    c.bufferFrames = kBlock;
    c.outputChannels = 2;
    return c;
}

std::vector<float> slice(const std::vector<float>& v, std::size_t from, std::size_t count) {
    return std::vector<float>(v.begin() + static_cast<std::ptrdiff_t>(from),
                              v.begin() + static_cast<std::ptrdiff_t>(from + count));
}

struct Rig {
    TempDir dir;
    Clips clips;
    Reference reference;
    DiskStream stream;
    Butler butler;
    GraphDriver driver;
    host::ManualAudioDevice device;

    Rig()
        : clips(makeClips(writeMedia(dir.path() / "media.wav", 50'000))),
          reference(clips.reference),
          stream(2, clips.streamed, 8'192),
          butler(Butler::Options{2'048, 512, std::chrono::microseconds(200)}),
          driver(GraphDriver::Options{kBlock, std::chrono::milliseconds(500)}) {
        butler.addStream(stream);
        driver.publish(streamingGraph(stream));
        driver.play();
        driver.start(device, config());
    }
    ~Rig() { driver.stop(); }

    // Pumps blocks, letting the butler run between them; returns channel 0.
    std::vector<float> pump(int blocks) {
        std::vector<float> out;
        for (int b = 0; b < blocks; ++b) {
            device.pump(1, &out);
            butler.runOnce();
            driver.poll();
        }
        return out;
    }
};

}  // namespace

TEST_CASE("FrameRing keeps frames in order across wrap-around", "[stream][ring]") {
    FrameRing ring(2, 100);  // rounds to 128
    CHECK(ring.capacity() == 128);
    std::vector<float> l(200), r(200);
    float* in[2] = {l.data(), r.data()};
    for (int i = 0; i < 200; ++i) {
        l[static_cast<std::size_t>(i)] = static_cast<float>(i);
        r[static_cast<std::size_t>(i)] = -static_cast<float>(i);
    }
    std::vector<float> ol(200), orr(200);
    float* out[2] = {ol.data(), orr.data()};
    CHECK(ring.write(host::AudioBufferView{in, 2, 200}, 200) == 128);
    CHECK(ring.read(host::AudioBufferView{out, 2, 200}, 0, 100) == 100);
    CHECK(ol[99] == 99.0f);
    CHECK(orr[99] == -99.0f);
    float* in2[2] = {l.data() + 128, r.data() + 128};
    CHECK(ring.write(host::AudioBufferView{in2, 2, 72}, 72) == 72);  // wraps
    CHECK(ring.skip(10) == 10);
    CHECK(ring.read(host::AudioBufferView{out, 2, 200}, 0, 200) == 90);
    CHECK(ol[0] == 110.0f);
    CHECK(ol[89] == 199.0f);
}

TEST_CASE("FrameRing across two threads", "[stream][ring]") {
    FrameRing ring(1, 256);
    constexpr int kTotal = 500'000;
    std::thread producer([&] {
        std::vector<float> buf(37);
        float* p[1] = {buf.data()};
        int next = 0;
        while (next < kTotal) {
            const int n = std::min(37, kTotal - next);
            for (int i = 0; i < n; ++i) {
                buf[static_cast<std::size_t>(i)] = static_cast<float>(next + i);
            }
            next += static_cast<int>(ring.write(host::AudioBufferView{p, 1, n}, static_cast<std::size_t>(n)));
        }
    });
    std::vector<float> buf(53);
    float* p[1] = {buf.data()};
    int expected = 0;
    int errors = 0;
    while (expected < kTotal) {
        const auto got = ring.read(host::AudioBufferView{p, 1, 53}, 0, 53);
        for (std::size_t i = 0; i < got; ++i) {
            errors += buf[i] != static_cast<float>(expected++) ? 1 : 0;
        }
    }
    producer.join();
    CHECK(errors == 0);
}

TEST_CASE("Streamed playback is sample-identical to the offline clip player", "[stream]") {
    Rig rig;
    const auto out = rig.pump(400);  // 25,600 frames across the overlapping clips
    const auto expected = rig.reference.left(0, 400 * kBlock);
    // Block 0 carries the driver's initial fade-in.
    CHECK(slice(out, kBlock, out.size() - kBlock) == slice(expected, kBlock, expected.size() - kBlock));
    CHECK(rig.stream.underruns() == 0);
}

TEST_CASE("A prepared locate switches to the target position without underruns", "[stream][locate]") {
    Rig rig;
    rig.pump(10);
    rig.butler.seek(2, 30'000);
    rig.butler.runOnce();
    REQUIRE(rig.butler.ready(2));
    REQUIRE(rig.driver.pushLocate(TransportCommand{2, 30'000}));
    const auto out = rig.pump(20);
    // Block 0 ducks the old position; the locate lands at its end, block 1
    // fades in at the target, and from block 2 on the output is exact.
    const auto expected = rig.reference.left(30'000, 19 * kBlock);
    CHECK(slice(out, 2 * kBlock, 18 * kBlock) == slice(expected, kBlock, 18 * kBlock));
    CHECK(rig.driver.playhead() == 30'000 + 19 * kBlock);
    CHECK(rig.stream.underruns() == 0);
}

TEST_CASE("A locate whose data is late stays aligned once the data arrives", "[stream][locate]") {
    Rig rig;
    rig.pump(10);
    REQUIRE(rig.driver.pushLocate(TransportCommand{3, 50'000}));  // the butler has not seen it
    std::vector<float> out;
    rig.device.pump(6, &out);  // no butler: silence while waiting
    CHECK(rig.stream.underruns() > 0);
    rig.butler.seek(3, 50'000);
    rig.butler.runOnce();
    REQUIRE(rig.butler.ready(3));
    const std::int64_t resumeAt = rig.driver.playhead();
    std::vector<float> resumed;
    rig.device.pump(10, &resumed);
    // Skipped frames are dropped, so the stream lines up with the playhead.
    const auto expected = rig.reference.left(resumeAt, 10 * kBlock);
    CHECK(slice(resumed, kBlock, 9 * kBlock) == slice(expected, kBlock, 9 * kBlock));
}

TEST_CASE("A newer locate withdraws an older offer that was never claimed", "[stream][locate]") {
    Rig rig;
    rig.pump(5);
    rig.butler.seek(2, 10'000);
    rig.butler.runOnce();
    REQUIRE(rig.butler.ready(2));
    rig.butler.seek(3, 40'000);
    rig.butler.runOnce();
    CHECK_FALSE(rig.butler.ready(2));
    REQUIRE(rig.butler.ready(3));
    REQUIRE(rig.driver.pushLocate(TransportCommand{3, 40'000}));
    const auto out = rig.pump(12);
    const auto expected = rig.reference.left(40'000, 11 * kBlock);
    CHECK(slice(out, 2 * kBlock, 10 * kBlock) == slice(expected, kBlock, 10 * kBlock));
    CHECK(rig.stream.underruns() == 0);
}

TEST_CASE("A stalled butler causes counted underruns and silence", "[stream]") {
    Rig rig;
    std::vector<float> out;
    rig.device.pump(8'192 / kBlock + 20, &out);  // drain the ring with no refills
    CHECK(rig.stream.underruns() > 0);
    CHECK(out.back() == 0.0f);
}

TEST_CASE("With a butler thread and a paced device, playback and a locate run clean", "[stream][threads]") {
    TempDir dir;
    Clips clips = makeClips(writeMedia(dir.path() / "media.wav", 50'000));
    DiskStream stream(2, clips.streamed, 16'384);
    Butler butler(Butler::Options{2'048, 512, std::chrono::microseconds(200)});
    butler.addStream(stream);
    GraphDriver driver(GraphDriver::Options{kBlock, std::chrono::milliseconds(500)});
    driver.publish(streamingGraph(stream));
    host::FakeAudioDevice::Options options;
    options.paced = true;
    host::FakeAudioDevice device(options);
    butler.start();
    driver.play();
    const auto before = rt::allocationViolations();
    driver.start(device, config());

    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (driver.playhead() < 12'000 && std::chrono::steady_clock::now() < deadline) {
        driver.poll();
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    butler.seek(2, 20'000);
    while (!butler.ready(2) && std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    REQUIRE(butler.ready(2));
    REQUIRE(driver.pushLocate(TransportCommand{2, 20'000}));
    while (driver.playhead() < 30'000 && std::chrono::steady_clock::now() < deadline) {
        driver.poll();
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    driver.stop();
    butler.stop();
    CHECK(driver.playhead() >= 30'000);
    CHECK(stream.underruns() == 0);
    CHECK(rt::allocationViolations() == before);
}
