#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <thread>
#include <vector>

#include "siann/host/fake_audio_device.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/realtime/disk_stream.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/realtime/transport.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "support/streaming_rig.hpp"

using namespace siann;
using namespace siann::realtime_test;
using namespace std::chrono_literals;
using realtime::Butler;
using realtime::DiskStream;
using realtime::GraphDriver;
using realtime::Transport;
using Clock = std::chrono::steady_clock;

namespace {

// A streaming graph on the manual device with the transport stopped. Tests
// never call driver.play() or pushLocate(): every transport change goes
// through Transport, and the test advances the dispatcher's clock itself.
struct TransportRig {
    TempDir dir;
    Clips clips;
    Reference reference;
    DiskStream stream;
    Butler butler;
    GraphDriver driver;
    host::ManualAudioDevice device;
    Transport transport;
    Clock::time_point clock{};

    TransportRig()
        : clips(makeClips(writeMedia(dir.path() / "media.wav", 50'000))),
          reference(clips.reference),
          stream(2, clips.streamed, 8'192),
          butler(Butler::Options{2'048, 512, std::chrono::microseconds(200)}),
          driver(GraphDriver::Options{kBlock, std::chrono::milliseconds(500), GraphDriver::kDefaultMeterCapacity, {}}),
          transport(driver, butler, Transport::Options{std::chrono::milliseconds(1'000)}) {
        butler.addStream(stream);
        driver.publish(streamingGraph(stream));
        driver.start(device, config());
    }
    ~TransportRig() { driver.stop(); }

    // One dispatcher tick, 1 ms after the previous one.
    std::size_t tick() {
        clock += 1ms;
        return transport.tick(clock);
    }

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

    // Pumps blocks with the butler stalled.
    std::vector<float> pumpWithoutButler(int blocks) {
        std::vector<float> out;
        device.pump(blocks, &out);
        return out;
    }

    // Play from timeline 0 and pump past the initial fade-in.
    void startPlaying() {
        transport.play();
        butler.runOnce();
        REQUIRE(tick() == 1);
        pump(2);
        REQUIRE(transport.playing());
    }
};

}  // namespace

TEST_CASE("A locate goes dispatcher -> butler seek -> ready -> transportInbox with a new generation",
          "[transport][locate]") {
    TransportRig rig;
    rig.startPlaying();
    rig.pump(8);
    const std::uint64_t previous = rig.transport.generation();

    rig.transport.locate(30'000);
    CHECK(rig.transport.pendingLocate());
    const std::uint64_t g1 = rig.transport.generation();
    CHECK(g1 > previous);
    CHECK(rig.transport.position() == 30'000);

    // The butler has not prepared it: the dispatcher holds the locate and
    // playback continues from the old position.
    const std::int64_t before = rig.driver.playhead();
    CHECK(rig.tick() == 0);
    rig.pumpWithoutButler(4);
    CHECK(rig.tick() == 0);
    CHECK(rig.transport.pendingLocate());
    CHECK(rig.driver.playhead() == before + 4 * kBlock);
    CHECK(rig.stream.underruns() == 0);

    rig.butler.runOnce();
    REQUIRE(rig.butler.ready(g1));
    CHECK(rig.tick() == 1);
    CHECK_FALSE(rig.transport.pendingLocate());
    CHECK(rig.transport.position() == 30'000);  // sent, not yet applied by the audio thread

    const auto out = rig.pump(20);
    // Block 0 ducks the old position; the locate lands at its end, block 1
    // fades in at the target, and from block 2 on the output is exact.
    const auto expected = rig.reference.left(30'000, 19 * kBlock);
    CHECK(slice(out, 2 * kBlock, 18 * kBlock) == slice(expected, kBlock, 18 * kBlock));
    CHECK(rig.driver.playhead() == 30'000 + 19 * kBlock);
    CHECK(rig.transport.position() == rig.driver.playhead());
    CHECK(rig.stream.underruns() == 0);
    CHECK(rig.transport.lateLocates() == 0);
    CHECK(rig.transport.generation() == g1);

    rig.transport.locate(1'000);
    CHECK(rig.transport.generation() == g1 + 1);
}

TEST_CASE("A newer locate cancels an older one", "[transport][locate]") {
    TransportRig rig;
    rig.startPlaying();
    rig.pump(5);

    SECTION("both before the butler's pass") {
        rig.transport.locate(10'000);
        const std::uint64_t g1 = rig.transport.generation();
        rig.transport.locate(40'000);
        const std::uint64_t g2 = rig.transport.generation();
        CHECK(g2 == g1 + 1);
        CHECK(rig.tick() == 0);
        rig.butler.runOnce();
        CHECK_FALSE(rig.butler.ready(g1));
        REQUIRE(rig.butler.ready(g2));
    }
    SECTION("the older one already prepared but not yet sent") {
        rig.transport.locate(10'000);
        const std::uint64_t g1 = rig.transport.generation();
        rig.butler.runOnce();
        REQUIRE(rig.butler.ready(g1));
        rig.transport.locate(40'000);
        const std::uint64_t g2 = rig.transport.generation();
        CHECK(rig.tick() == 0);  // only the newest locate is pending
        rig.butler.runOnce();
        CHECK_FALSE(rig.butler.ready(g1));
        REQUIRE(rig.butler.ready(g2));
    }

    CHECK(rig.tick() == 1);
    CHECK(rig.tick() == 0);  // the older generation is never sent
    const auto out = rig.pump(12);
    const auto expected = rig.reference.left(40'000, 11 * kBlock);
    CHECK(slice(out, 2 * kBlock, 10 * kBlock) == slice(expected, kBlock, 10 * kBlock));
    // A single jump, straight to the newer target.
    CHECK(rig.driver.playhead() == 40'000 + 11 * kBlock);
    const auto older = rig.reference.left(10'000, kBlock);
    for (int b = 0; b < 12; ++b) {
        CHECK(slice(out, static_cast<std::size_t>(b) * kBlock, kBlock) != older);
    }
    CHECK(rig.transport.lateLocates() == 0);
    CHECK(rig.stream.underruns() == 0);
}

TEST_CASE("Repeated locates during playback stay sample-identical", "[transport][locate]") {
    TransportRig rig;
    rig.startPlaying();
    std::uint64_t last = rig.transport.generation();
    for (const std::int64_t target : {5'000, 25'000, 45'000, 2'000}) {
        INFO("target " << target);
        rig.transport.locate(target);
        CHECK(rig.transport.generation() == last + 1);
        last = rig.transport.generation();
        rig.butler.runOnce();
        REQUIRE(rig.tick() == 1);
        const auto out = rig.pump(12);
        const auto expected = rig.reference.left(target, 11 * kBlock);
        CHECK(slice(out, 2 * kBlock, 10 * kBlock) == slice(expected, kBlock, 10 * kBlock));
        CHECK(rig.driver.playhead() == target + 11 * kBlock);
        CHECK(rig.stream.underruns() == 0);
    }
    CHECK(rig.transport.lateLocates() == 0);
}

TEST_CASE("A locate the butler does not prepare within the timeout proceeds and its underruns are reported",
          "[transport][locate][timeout]") {
    TransportRig rig;
    rig.startPlaying();
    rig.pump(10);

    rig.transport.locate(50'000);
    const Clock::time_point t0 = rig.clock;
    CHECK(rig.transport.tick(t0) == 0);
    CHECK(rig.transport.tick(t0 + 999ms) == 0);
    CHECK(rig.transport.lateLocates() == 0);
    CHECK(rig.transport.pendingLocate());
    CHECK(rig.transport.tick(t0 + 1'001ms) == 1);
    CHECK(rig.transport.lateLocates() == 1);
    CHECK_FALSE(rig.transport.pendingLocate());

    // No butler: silence and counted underruns while the data is missing.
    const auto waiting = rig.pumpWithoutButler(6);
    CHECK(rig.stream.underruns() > 0);
    CHECK(silent(slice(waiting, kBlock, 5 * kBlock)));
    CHECK(rig.transport.status().underruns == rig.stream.underruns());
    CHECK(rig.butler.underruns() == rig.stream.underruns());

    rig.butler.runOnce();
    REQUIRE(rig.butler.ready(rig.transport.generation()));
    const std::int64_t resumeAt = rig.driver.playhead();
    const auto resumed = rig.pumpWithoutButler(10);
    // Skipped frames are dropped, so the stream lines up with the playhead.
    const auto expected = rig.reference.left(resumeAt, 10 * kBlock);
    CHECK(slice(resumed, kBlock, 9 * kBlock) == slice(expected, kBlock, 9 * kBlock));

    const std::uint64_t counted = rig.stream.underruns();
    rig.pump(10);
    CHECK(rig.stream.underruns() == counted);
    const Transport::Status status = rig.transport.status();
    CHECK(status.underruns == counted);
    CHECK(status.lateLocates == 1);
    CHECK(status.playing);
}

TEST_CASE("Play from stop is a locate to the current position followed by transport start", "[transport][play]") {
    TransportRig rig;
    CHECK_FALSE(rig.transport.playing());
    auto out = rig.pump(4);
    CHECK(silent(out));
    CHECK(rig.driver.playhead() == 0);

    // A locate while stopped moves the playhead without starting it.
    rig.transport.locate(20'000);
    rig.butler.runOnce();
    REQUIRE(rig.tick() == 1);
    out = rig.pump(1);
    CHECK(silent(out));
    CHECK(rig.driver.playhead() == 20'000);
    CHECK_FALSE(rig.transport.playing());

    const std::uint64_t before = rig.transport.generation();
    rig.transport.play();
    const std::uint64_t g = rig.transport.generation();
    CHECK(g == before + 1);
    CHECK(rig.transport.pendingLocate());
    CHECK(rig.transport.position() == 20'000);
    CHECK(rig.transport.playing());
    CHECK(rig.tick() == 0);  // waits for the butler like any locate
    rig.butler.runOnce();
    REQUIRE(rig.butler.ready(g));
    REQUIRE(rig.tick() == 1);

    out = rig.pump(12);
    auto expected = rig.reference.left(20'000, 12 * kBlock);
    // The locate carries the start: block 0 fades in at the target.
    CHECK(slice(out, 0, kBlock) != slice(expected, 0, kBlock));
    CHECK(slice(out, kBlock, 11 * kBlock) == slice(expected, kBlock, 11 * kBlock));
    CHECK_FALSE(silent(slice(out, kBlock, 11 * kBlock)));
    CHECK(rig.driver.playhead() == 20'000 + 12 * kBlock);
    CHECK(rig.transport.playing());

    rig.transport.play();  // already playing: nothing to do
    CHECK(rig.transport.generation() == g);
    CHECK_FALSE(rig.transport.pendingLocate());

    rig.transport.stop();
    CHECK_FALSE(rig.transport.playing());
    const std::int64_t p = rig.driver.playhead();
    out = rig.pump(3);
    CHECK(silent(out));
    CHECK(rig.driver.playhead() == p);
    CHECK(rig.transport.position() == p);

    // Play again without a locate: it continues from where it stopped.
    rig.transport.play();
    CHECK(rig.transport.position() == p);
    rig.butler.runOnce();
    REQUIRE(rig.tick() == 1);
    out = rig.pump(12);
    expected = rig.reference.left(p, 12 * kBlock);
    CHECK(slice(out, kBlock, 11 * kBlock) == slice(expected, kBlock, 11 * kBlock));
    CHECK(rig.driver.playhead() == p + 12 * kBlock);
    CHECK(rig.stream.underruns() == 0);
    CHECK(rig.transport.lateLocates() == 0);
}

TEST_CASE("Stop wins over a play that has not reached the audio thread", "[transport][play]") {
    TransportRig rig;

    SECTION("stop after the play was sent") {
        rig.transport.play();
        rig.butler.runOnce();
        REQUIRE(rig.tick() == 1);
        rig.transport.stop();
    }
    SECTION("stop while the play waits for the butler") {
        rig.transport.play();
        rig.transport.stop();
        CHECK(rig.transport.pendingLocate());  // the locate itself is kept
        rig.butler.runOnce();
        REQUIRE(rig.tick() == 1);
    }

    CHECK_FALSE(rig.transport.playing());
    auto out = rig.pump(3);
    CHECK(silent(out));
    CHECK(rig.driver.playhead() == 0);
    CHECK_FALSE(rig.transport.playing());

    rig.transport.play();
    rig.butler.runOnce();
    REQUIRE(rig.tick() == 1);
    out = rig.pump(6);
    const auto expected = rig.reference.left(0, 6 * kBlock);
    CHECK(slice(out, kBlock, 5 * kBlock) == slice(expected, kBlock, 5 * kBlock));
    CHECK(rig.transport.playing());
}

TEST_CASE("On a paced device with a butler thread, play, locate and stop run clean", "[transport][threads]") {
    TempDir dir;
    Clips clips = makeClips(writeMedia(dir.path() / "media.wav", 50'000));
    DiskStream stream(2, clips.streamed, 16'384);
    Butler butler(Butler::Options{2'048, 512, std::chrono::microseconds(200)});
    butler.addStream(stream);
    GraphDriver driver(GraphDriver::Options{kBlock, std::chrono::milliseconds(500), GraphDriver::kDefaultMeterCapacity, {}});
    driver.publish(streamingGraph(stream));
    host::FakeAudioDevice::Options options;
    options.paced = true;
    host::FakeAudioDevice device(options);
    Transport transport(driver, butler, Transport::Options{std::chrono::milliseconds(1'000)});
    butler.start();
    const auto before = rt::allocationViolations();
    driver.start(device, config());

    // The dispatcher's loop; the deadline only guards against hangs.
    const auto deadline = Clock::now() + 10s;
    const auto dispatchUntil = [&](auto done) {
        while (!done() && Clock::now() < deadline) {
            transport.tick();
            driver.poll();
            std::this_thread::sleep_for(1ms);
        }
    };
    transport.play();
    dispatchUntil([&] { return driver.playhead() >= 12'000; });
    transport.locate(20'000);
    dispatchUntil([&] { return driver.playhead() >= 30'000; });
    transport.stop();
    driver.stop();
    butler.stop();

    CHECK(driver.playhead() >= 30'000);
    CHECK(stream.underruns() == 0);
    CHECK(transport.lateLocates() == 0);
    CHECK_FALSE(transport.playing());
    CHECK(rt::allocationViolations() == before);
    CHECK_FALSE(device.contractViolated());
}

TEST_CASE("On a paced device with a stalled butler, a locate proceeds after the timeout", "[transport][threads]") {
    TempDir dir;
    Clips clips = makeClips(writeMedia(dir.path() / "media.wav", 50'000));
    DiskStream stream(2, clips.streamed, 16'384);
    Butler butler(Butler::Options{2'048, 512, std::chrono::microseconds(200)});
    butler.addStream(stream);
    GraphDriver driver(GraphDriver::Options{kBlock, std::chrono::milliseconds(500), GraphDriver::kDefaultMeterCapacity, {}});
    driver.publish(streamingGraph(stream));
    host::FakeAudioDevice::Options options;
    options.paced = true;
    host::FakeAudioDevice device(options);
    Transport transport(driver, butler, Transport::Options{std::chrono::milliseconds(50)});
    const auto before = rt::allocationViolations();
    driver.start(device, config());

    const auto deadline = Clock::now() + 10s;
    const auto dispatchUntil = [&](auto done) {
        while (!done() && Clock::now() < deadline) {
            transport.tick();  // real clock
            driver.poll();
            std::this_thread::sleep_for(1ms);
        }
    };
    // The butler thread never runs; the test makes single passes itself.
    transport.play();
    butler.runOnce();
    dispatchUntil([&] { return driver.playhead() >= 4'096; });
    REQUIRE(driver.playhead() >= 4'096);
    CHECK(transport.lateLocates() == 0);

    transport.locate(20'000);
    dispatchUntil([&] { return transport.lateLocates() > 0; });
    CHECK(transport.lateLocates() == 1);
    dispatchUntil([&] { return stream.underruns() > 0; });
    CHECK(stream.underruns() > 0);

    butler.runOnce();
    REQUIRE(butler.ready(transport.generation()));
    std::int64_t from = driver.playhead();
    dispatchUntil([&] { return driver.playhead() >= from + 4 * kBlock; });
    const std::uint64_t settled = stream.underruns();
    from = driver.playhead();
    dispatchUntil([&] { return driver.playhead() >= from + 4'096; });
    CHECK(driver.playhead() >= from + 4'096);
    CHECK(stream.underruns() == settled);
    CHECK(transport.status().underruns == stream.underruns());
    transport.stop();
    driver.stop();

    CHECK(transport.lateLocates() == 1);
    CHECK(rt::allocationViolations() == before);
    CHECK_FALSE(device.contractViolated());
}

// The engine's control thread reads this while the butler thread takes and drops
// streams for a structural edit. Each add can reallocate the butler's list.
TEST_CASE("underruns can be read while the butler thread adds and removes streams", "[transport]") {
    TempDir dir;
    Clips clips = makeClips(writeMedia(dir.path() / "media.wav", 50'000));
    Butler butler(Butler::Options{1'024, 512, std::chrono::microseconds(1)});
    butler.start();
    std::atomic<bool> done{false};
    std::thread reader([&butler, &done] {
        while (!done.load(std::memory_order_acquire)) {
            CHECK(butler.underruns() == 0);
        }
    });
    for (int round = 0; round < 40; ++round) {
        std::vector<std::unique_ptr<DiskStream>> streams;
        for (int i = 0; i < 48; ++i) {
            streams.push_back(std::make_unique<DiskStream>(2, clips.streamed, 1'024));
            butler.addStream(*streams.back(), 0, 0);
        }
        for (const auto& stream : streams) {
            while (!stream->ready()) {
                std::this_thread::yield();
            }
        }
        for (const auto& stream : streams) {
            butler.removeStream(*stream);
        }
        for (const auto& stream : streams) {
            while (!stream->released()) {
                std::this_thread::yield();
            }
        }
    }
    done.store(true, std::memory_order_release);
    reader.join();
    butler.stop();
}
