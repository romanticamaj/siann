#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <thread>
#include <vector>

#include "siann/host/fake_audio_device.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/realtime/disk_stream.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "support/streaming_rig.hpp"

using namespace siann;
using namespace siann::realtime_test;
using realtime::Butler;
using realtime::DiskStream;
using realtime::FrameRing;
using realtime::GraphDriver;
using realtime::TransportCommand;

namespace {

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
          driver(GraphDriver::Options{kBlock, std::chrono::milliseconds(500), {}}) {
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
    GraphDriver driver(GraphDriver::Options{kBlock, std::chrono::milliseconds(500), {}});
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

// ---- Live recompile: streams added and removed while running ------------------

namespace {

// Processes a graph directly, block after block from `from`; returns channel 0.
std::vector<float> processFrom(graph::PreparedGraph& g, std::int64_t from, int blocks) {
    std::vector<float> out;
    for (int b = 0; b < blocks; ++b) {
        g.process(graph::ProcessContext{from + static_cast<std::int64_t>(b) * kBlock, kBlock});
        out.insert(out.end(), g.output().channel(0), g.output().channel(0) + kBlock);
    }
    return out;
}

bool allZero(const std::vector<float>& v) {
    return std::all_of(v.begin(), v.end(), [](float s) { return s == 0.0f; });
}

}  // namespace

TEST_CASE("The butler takes a stream while running and prefills it from the given position", "[stream][live]") {
    Rig rig;
    rig.pump(10);
    DiskStream stream2(2, rig.clips.streamed, 8'192);
    REQUIRE_NOTHROW(rig.butler.addStream(stream2, 30'000, 0));
    CHECK_FALSE(stream2.ready());  // the request waits for the butler's pass
    rig.butler.runOnce();
    CHECK(stream2.ready());
    // Filled from the requested position, not from 0.
    auto g = streamingGraph(stream2);
    CHECK(processFrom(*g, 30'000, 20) == rig.reference.left(30'000, 20 * kBlock));
    CHECK(stream2.underruns() == 0);
}

TEST_CASE("A streaming player aligns to the block position", "[stream][live]") {
    TempDir dir;
    Clips clips = makeClips(writeMedia(dir.path() / "media.wav", 50'000));
    Reference reference(clips.reference);
    Butler butler(Butler::Options{2'048, 512, std::chrono::microseconds(200)});

    SECTION("behind: the ring skips to the block start") {
        DiskStream stream(2, clips.streamed, 8'192);
        butler.addStream(stream);  // filled from 0
        auto g = streamingGraph(stream);
        CHECK(processFrom(*g, 5'000, 40) == reference.left(5'000, 40 * kBlock));
        CHECK(stream.underruns() == 0);
    }

    SECTION("ahead: silence and counted underruns until the timeline reaches the data") {
        DiskStream stream(2, clips.streamed, 8'192);
        butler.addStream(stream, 20'000, 0);
        butler.runOnce();
        REQUIRE(stream.ready());
        auto g = streamingGraph(stream);
        const auto early = processFrom(*g, 10'000, 4);
        CHECK(allZero(early));
        CHECK(stream.underruns() > 0);
        // The block that straddles 20'000 starts with silence, and from the
        // data's first frame on the stream is in time.
        constexpr std::int64_t kFirst = 10'000 + 4 * kBlock;
        const int blocks = static_cast<int>((20'000 - kFirst) / kBlock) + 12;
        const auto later = processFrom(*g, kFirst, blocks);
        const auto expected = reference.left(kFirst, blocks * kBlock);
        const auto from = static_cast<std::size_t>(20'000 - kFirst);
        CHECK(allZero(slice(later, 0, from)));
        CHECK(slice(later, from, later.size() - from) == slice(expected, from, expected.size() - from));
    }
}

TEST_CASE("A stream created at publish time plays in time after a later swap", "[stream][live]") {
    Rig rig;
    rig.pump(50);
    DiskStream stream2(2, rig.clips.streamed, 8'192);
    rig.butler.addStream(stream2, rig.driver.playhead(), 0);
    for (int i = 0; i < 10 && !stream2.ready(); ++i) {
        rig.butler.runOnce();
    }
    REQUIRE(stream2.ready());
    rig.pump(5);  // the timeline moves on before the graph is published
    const auto before = rt::allocationViolations();
    const std::uint64_t epoch = rig.driver.publish(streamingGraph(stream2));
    const std::int64_t start = rig.driver.playhead();
    const auto out = rig.pump(30);
    CHECK_FALSE(rig.driver.transitionInFlight());
    CHECK(rig.driver.liveEpoch() == epoch);
    // Block 0 ducks the old graph, block 1 rises with the new one.
    const auto expected = rig.reference.left(start, 30 * kBlock);
    CHECK(slice(out, 2 * kBlock, 28 * kBlock) == slice(expected, 2 * kBlock, 28 * kBlock));
    CHECK(stream2.underruns() == 0);
    CHECK(rt::allocationViolations() == before);
}

TEST_CASE("A graph published before the butler took its stream plays silence, then catches up", "[stream][live]") {
    Rig rig;
    rig.pump(10);
    DiskStream stream2(2, rig.clips.streamed, 8'192);
    rig.butler.addStream(stream2, rig.driver.playhead(), 0);
    rig.driver.publish(streamingGraph(stream2));  // as on the prefill timeout
    std::vector<float> early;
    rig.device.pump(4, &early);  // no butler pass: the stream is not taken yet
    rig.driver.poll();
    REQUIRE_FALSE(stream2.ready());
    CHECK(allZero(slice(early, kBlock, 3 * kBlock)));  // block 0 still ducks the old graph
    CHECK(stream2.underruns() > 0);

    rig.butler.runOnce();
    REQUIRE(stream2.ready());
    const std::int64_t start = rig.driver.playhead();
    const auto out = rig.pump(10);
    CHECK(out == rig.reference.left(start, 10 * kBlock));
}

TEST_CASE("removeStream releases a stream only on the butler's pass", "[stream][live]") {
    TempDir dir;
    Clips clips = makeClips(writeMedia(dir.path() / "media.wav", 50'000));
    Butler butler(Butler::Options{2'048, 256, std::chrono::microseconds(200)});
    DiskStream stream(2, clips.streamed, 1'024);
    butler.addStream(stream, 0, 0);
    butler.runOnce();
    REQUIRE(stream.ready());
    auto g = streamingGraph(stream);
    std::int64_t position = 0;
    const auto play = [&](int blocks) {
        for (int b = 0; b < blocks; ++b) {
            g->process(graph::ProcessContext{position, kBlock});
            position += kBlock;
            butler.runOnce();
        }
    };
    play(40);  // 2'560 frames through a 1'024-frame ring: the butler keeps up
    CHECK(stream.underruns() == 0);

    butler.removeStream(stream);
    CHECK_FALSE(stream.released());
    butler.runOnce();
    CHECK(stream.released());
    play(40);  // nobody refills the ring now
    CHECK(stream.underruns() > 0);
}

TEST_CASE("A stream added while a locate is prepared joins that locate", "[stream][live][locate]") {
    Rig rig;
    rig.pump(5);
    rig.butler.seek(2, 30'000);
    rig.butler.runOnce();
    REQUIRE(rig.butler.ready(2));

    DiskStream stream2(2, rig.clips.streamed, 8'192);
    rig.butler.addStream(stream2, rig.driver.playhead(), 0);
    rig.butler.runOnce();
    REQUIRE(stream2.ready());
    CHECK(rig.butler.ready(2));  // still ready: the new stream offered the generation too
    rig.driver.publish(streamingGraph(stream2));
    rig.pump(3);
    REQUIRE_FALSE(rig.driver.transitionInFlight());

    REQUIRE(rig.driver.pushLocate(TransportCommand{2, 30'000}));
    const auto out = rig.pump(20);
    const auto expected = rig.reference.left(30'000, 19 * kBlock);
    CHECK(slice(out, 2 * kBlock, 18 * kBlock) == slice(expected, kBlock, 18 * kBlock));
    CHECK(stream2.underruns() == 0);
}

TEST_CASE("A stream added before a locate lands follows that locate in the graph swapped in later",
          "[stream][live][locate]") {
    Rig rig;
    rig.pump(200);  // the playhead is well past the locate target
    constexpr std::int64_t kTarget = 1'000;
    // What a compile reads: the locate generation first, then the playhead.
    const std::uint64_t compiledGeneration = rig.driver.appliedLocate();
    const std::int64_t compiledAt = rig.driver.playhead();
    DiskStream stream2(2, rig.clips.streamed, 8'192);

    const auto locateOnOldGraph = [&] {
        rig.butler.seek(2, kTarget);
        rig.butler.runOnce();
        REQUIRE(rig.butler.ready(2));
        REQUIRE(rig.driver.pushLocate(TransportCommand{2, kTarget}));
        rig.pump(3);  // the old graph ducks, jumps and rises
        REQUIRE(rig.driver.playhead() < compiledAt);
        REQUIRE(rig.driver.appliedLocate() == 2);
    };
    const auto swapAndCheck = [&] {
        rig.driver.publish(streamingGraph(stream2));
        const std::int64_t start = rig.driver.playhead();
        const auto out = rig.pump(30);
        REQUIRE_FALSE(rig.driver.transitionInFlight());
        // Block 0 ducks the old graph, block 1 rises with the new one.
        const auto expected = rig.reference.left(start, 30 * kBlock);
        CHECK(slice(out, 2 * kBlock, 28 * kBlock) == slice(expected, 2 * kBlock, 28 * kBlock));
    };

    SECTION("the butler took the stream before the locate was prepared") {
        rig.butler.addStream(stream2, compiledAt, compiledGeneration);
        rig.butler.runOnce();
        REQUIRE(stream2.ready());
        locateOnOldGraph();
        swapAndCheck();
        CHECK(stream2.underruns() == 0);
    }

    SECTION("the butler took the stream after the old graph claimed the locate") {
        locateOnOldGraph();
        rig.butler.addStream(stream2, compiledAt, compiledGeneration);
        rig.butler.runOnce();
        REQUIRE(stream2.ready());
        swapAndCheck();
        CHECK(stream2.underruns() == 0);
    }

    SECTION("the graph was published before the butler took the stream") {
        locateOnOldGraph();
        rig.butler.addStream(stream2, compiledAt, compiledGeneration);
        rig.driver.publish(streamingGraph(stream2));  // as on the prefill timeout
        std::vector<float> early;
        rig.device.pump(4, &early);
        rig.driver.poll();
        REQUIRE_FALSE(stream2.ready());
        rig.butler.runOnce();
        REQUIRE(stream2.ready());
        const std::int64_t start = rig.driver.playhead();
        const auto out = rig.pump(10);
        CHECK(out == rig.reference.left(start, 10 * kBlock));
    }

    SECTION("a position read after the locate does not join it again") {
        locateOnOldGraph();
        rig.butler.addStream(stream2, rig.driver.playhead(), rig.driver.appliedLocate());
        rig.butler.runOnce();
        REQUIRE(stream2.ready());
        swapAndCheck();
        CHECK(stream2.underruns() == 0);
    }
}
