// Cycle playback (m5-ui-engine-loop-click; spec, "Realtime data flow", "Cycle"):
// with cycle on and locators in the heard document, playback wraps from the
// right locator to the left sample-accurately, with no duck and no flush, so
// the output equals the range laid end to end. Everything runs on a manual
// device with the butler driven by the test, so every block is deterministic.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

#include "support/live_rig.hpp"
#include "siann/realtime/stream_resampler.hpp"
#include "siann/rt/realtime_thread.hpp"

using namespace live_rig;

namespace {

std::string setLocators(std::int64_t left, std::int64_t right) {
    return R"({"op":"session.set_locators","left":")" + std::to_string(left) + R"(","right":")" +
           std::to_string(right) + R"("})";
}

// The rig's two tracks plus a long stereo track, so the cycle range has audio
// on every frame.
struct CycleFixture : Fixture {
    explicit CycleFixture(std::int64_t frames = 300'000) {
        importWav("med_long", 2, frames);
        exec(addTrack("trk_c"));
        exec(place("clp_c", "trk_c", "med_long", 0, 0, frames));
    }
};

PlaybackOptions stoppedOptions() {
    PlaybackOptions o = testOptions();
    o.playOnStart = false;
    return o;
}

// One pumped block at a time, without keeping the whole output.
struct Runner {
    Live& live;
    std::vector<std::vector<float>> block{2};

    // Pumps one block and returns it.
    const std::vector<std::vector<float>>& step() {
        block[0].clear();
        block[1].clear();
        live.device.pumpAll(1, block);
        live.engine.tick();
        live.engine.butler().runOnce();
        live.engine.tick();
        return block;
    }

    // Pumps until the transport plays; returns the first playing block, which
    // started at the locate's target (the start is applied at its boundary).
    const std::vector<std::vector<float>>& untilPlaying(int limit = 64) {
        for (int i = 0; i < limit; ++i) {
            step();
            if (live.engine.driver().playing()) {
                return block;
            }
        }
        FAIL("the transport never started");
        return block;
    }
};

// The expected timeline position of each output frame: from `position`,
// wrapping from `right` to `left` while `cycle` is on and the position started
// before `right`.
struct Expected {
    const std::vector<std::vector<float>>& reference;
    std::int64_t position;
    std::int64_t left;
    std::int64_t right;
    bool cycle = true;
    std::int64_t wraps = 0;

    // Compares `frames` output frames from `offset` of `block` and advances.
    std::size_t compare(const std::vector<std::vector<float>>& block, std::size_t offset = 0) {
        std::size_t mismatches = 0;
        for (std::size_t i = offset; i < block[0].size(); ++i) {
            const auto at = static_cast<std::size_t>(position);
            if (at >= reference[0].size() || block[0][i] != reference[0][at] || block[1][i] != reference[1][at]) {
                ++mismatches;
            }
            advance();
        }
        return mismatches;
    }

    void skip(std::size_t frames) {
        for (std::size_t i = 0; i < frames; ++i) {
            advance();
        }
    }

    void advance() {
        ++position;
        if (cycle && position == right) {
            position = left;
            ++wraps;
        }
    }
};

}  // namespace

TEST_CASE("A four-bar cycle plays 100 passes that null against the range laid end to end",
          "[playback][cycle][null]") {
    // 240 BPM: a quarter is 12,000 frames, four bars 192,000. Neither locator
    // falls on a block boundary.
    CycleFixture f(260'000);
    f.exec(R"({"op":"session.set_tempo","tempo":[{"ticks":"0","milliBpm":240000}]})");
    constexpr std::int64_t left = 50'001;
    constexpr std::int64_t right = left + 192'000;
    static_assert(left % kBlock != 0 && right % kBlock != 0);
    f.exec(setLocators(left, right));
    const auto reference = offline(f.doc(), f.bundle(), right);

    Live live(f.session, stoppedOptions());
    live.engine.setCycle(true);
    const std::int64_t start = left - 5'000;  // the start-up rise ends long before L
    live.engine.transport().locate(start);
    live.engine.transport().play();

    Runner run{live};
    Expected expected{reference, start, left, right};
    const auto& first = run.untilPlaying();
    // The first block rises from silence (fadeFrames is one block): skip it.
    expected.skip(first[0].size());
    std::size_t mismatches = 0;
    while (expected.wraps < 100) {
        mismatches += expected.compare(run.step());
    }
    CHECK(mismatches == 0);
    CHECK(expected.wraps == 100);
    CHECK(live.engine.underruns() == 0);
    CHECK(live.engine.driver().srcUnderruns() == 0);
    CHECK(live.engine.transport().lateLocates() == 0);
}

TEST_CASE("Turning cycle off mid-pass plays on past the right locator", "[playback][cycle]") {
    CycleFixture f;
    constexpr std::int64_t left = 10'003;
    constexpr std::int64_t right = 30'007;
    f.exec(setLocators(left, right));
    const auto reference = offline(f.doc(), f.bundle(), 120'000);

    Live live(f.session, stoppedOptions());
    live.engine.setCycle(true);
    live.engine.transport().locate(left);
    live.engine.transport().play();
    Runner run{live};
    Expected expected{reference, left, left, right};
    expected.skip(run.untilPlaying()[0].size());
    std::size_t mismatches = 0;
    while (expected.wraps < 2) {
        mismatches += expected.compare(run.step());
    }
    // Mid-pass: off. The rest plays straight through R.
    for (int b = 0; b < 20; ++b) {
        mismatches += expected.compare(run.step());
    }
    live.engine.setCycle(false);
    CHECK_FALSE(live.engine.cycle());
    expected.cycle = false;
    while (expected.position < 100'000) {
        mismatches += expected.compare(run.step());
    }
    CHECK(mismatches == 0);
    CHECK(expected.wraps == 2);
    CHECK(live.engine.driver().playhead() > right);
    CHECK(live.engine.underruns() == 0);
}

TEST_CASE("Cycle enabled with the playhead at or past the right locator never wraps", "[playback][cycle]") {
    for (const std::int64_t offset : {std::int64_t{0}, std::int64_t{777}}) {
        INFO("start at R + " << offset);
        CycleFixture f;
        constexpr std::int64_t left = 10'003;
        constexpr std::int64_t right = 30'007;
        f.exec(setLocators(left, right));
        const auto reference = offline(f.doc(), f.bundle(), 120'000);

        Live live(f.session, stoppedOptions());
        live.engine.setCycle(true);
        live.engine.transport().locate(right + offset);
        live.engine.transport().play();
        Runner run{live};
        Expected expected{reference, right + offset, left, right};
        expected.cycle = false;
        expected.skip(run.untilPlaying()[0].size());
        std::size_t mismatches = 0;
        while (expected.position < 100'000) {
            mismatches += expected.compare(run.step());
        }
        CHECK(mismatches == 0);
        CHECK(live.engine.driver().playhead() >= 100'000);
    }
}

TEST_CASE("Cycle without locators has no effect", "[playback][cycle]") {
    CycleFixture f;
    const auto reference = offline(f.doc(), f.bundle(), 120'000);
    Live live(f.session, stoppedOptions());
    live.engine.setCycle(true);
    live.engine.transport().locate(1'000);
    live.engine.transport().play();
    Runner run{live};
    Expected expected{reference, 1'000, 0, 1};
    expected.cycle = false;
    expected.skip(run.untilPlaying()[0].size());
    std::size_t mismatches = 0;
    while (expected.position < 100'000) {
        mismatches += expected.compare(run.step());
    }
    CHECK(mismatches == 0);
}

TEST_CASE("Changing the locators while cycling wraps at the new right locator", "[playback][cycle]") {
    CycleFixture f;
    f.exec(setLocators(10'003, 30'007));
    const auto reference = offline(f.doc(), f.bundle(), 120'000);

    Live live(f.session, stoppedOptions());
    live.engine.setCycle(true);
    live.engine.transport().locate(10'003);
    live.engine.transport().play();
    Runner run{live};
    Expected expected{reference, 10'003, 10'003, 30'007};
    expected.skip(run.untilPlaying()[0].size());
    std::size_t mismatches = 0;
    while (expected.wraps < 1) {
        mismatches += expected.compare(run.step());
    }
    const std::size_t compiles = live.engine.compileCount();
    // A new pair after the playhead: one revision, heard through update().
    f.exec(setLocators(20'011, 50'021));
    live.engine.update(f.doc());
    expected.left = 20'011;
    expected.right = 50'021;
    while (expected.wraps < 4) {
        mismatches += expected.compare(run.step());
    }
    CHECK(mismatches == 0);
    CHECK(live.engine.compileCount() == compiles);  // the locators compile nothing
    CHECK(live.engine.underruns() == 0);
}

TEST_CASE("A loop shorter than the butler's prefill still wraps exactly at R", "[playback][cycle]") {
    CycleFixture f;
    constexpr std::int64_t left = 40'001;
    constexpr std::int64_t right = left + 1'000;  // shorter than a prefill of 2,048
    f.exec(setLocators(left, right));
    const auto reference = offline(f.doc(), f.bundle(), right);

    Live live(f.session, stoppedOptions());
    live.engine.setCycle(true);
    live.engine.transport().locate(left - 600);
    live.engine.transport().play();
    Runner run{live};
    Expected expected{reference, left - 600, left, right};
    expected.skip(run.untilPlaying()[0].size());
    std::size_t mismatches = 0;
    while (expected.wraps < 50) {
        mismatches += expected.compare(run.step());
    }
    CHECK(mismatches == 0);
    CHECK(live.engine.driver().playhead() >= left);
    CHECK(live.engine.driver().playhead() < right);
}

TEST_CASE("A user locate during a prepared wrap wins, and the next wrap is still exact", "[playback][cycle]") {
    CycleFixture f;
    constexpr std::int64_t left = 10'003;
    constexpr std::int64_t right = 30'007;
    f.exec(setLocators(left, right));
    const auto reference = offline(f.doc(), f.bundle(), 120'000);

    Live live(f.session, stoppedOptions());
    live.engine.setCycle(true);
    live.engine.transport().locate(left);
    live.engine.transport().play();
    Runner run{live};
    run.untilPlaying();
    // A few blocks in: the wrap is armed and the butler has prepared it.
    for (int b = 0; b < 10; ++b) {
        run.step();
    }
    REQUIRE(live.engine.driver().playhead() < right);
    constexpr std::int64_t target = 22'222;
    live.engine.transport().locate(target);
    const std::uint64_t generation = live.engine.transport().generation();
    // Until applied, the old position plays; the locate ducks and rises.
    for (int b = 0; b < 64 && live.engine.driver().appliedLocate() < generation; ++b) {
        run.step();
    }
    REQUIRE(live.engine.driver().appliedLocate() >= generation);
    // The block after the duck rises from the target: skip it, then compare.
    const std::int64_t at = live.engine.driver().playhead();
    REQUIRE(at >= target);
    REQUIRE(at < right);
    Expected expected{reference, at, left, right};
    expected.skip(run.step()[0].size());
    std::size_t mismatches = 0;
    while (expected.wraps < 3) {
        mismatches += expected.compare(run.step());
    }
    CHECK(mismatches == 0);
    CHECK(live.engine.underruns() == 0);
}

TEST_CASE("No audio-thread allocation across cycle wraps", "[playback][cycle][rt]") {
    CycleFixture f;
    f.exec(setLocators(10'003, 13'007));
    Live live(f.session, stoppedOptions());
    live.engine.setCycle(true);
    live.engine.transport().locate(10'003);
    live.engine.transport().play();
    Runner run{live};
    run.untilPlaying();
    for (int b = 0; b < 20; ++b) {
        run.step();
    }
    const auto before = rt::allocationViolations();
    for (int b = 0; b < 200; ++b) {  // about 17 wraps
        run.step();
    }
    CHECK(rt::allocationViolations() == before);
    CHECK(live.engine.underruns() == 0);
}

TEST_CASE("Toggling cycle compiles nothing and creates no revision", "[playback][cycle]") {
    CycleFixture f;
    f.exec(setLocators(10'003, 30'007));
    Live live(f.session, stoppedOptions());
    live.engine.transport().play();
    Runner run{live};
    run.untilPlaying();
    const std::size_t compiles = live.engine.compileCount();
    const std::string head = f.session.history().head().envelope.id;
    for (int i = 0; i < 6; ++i) {
        live.engine.setCycle(i % 2 == 0);
        run.step();
    }
    CHECK(live.engine.compileCount() == compiles);
    CHECK(f.session.history().head().envelope.id == head);
}

TEST_CASE("Cycling through device-side SRC equals the range laid end to end through the same SRC",
          "[playback][cycle][src]") {
    // The SRC parity pattern of playback_test.cpp: a 48 kHz session on a 44.1 kHz
    // device, playing from 0 (nothing before frame 1,000, so the start-up rise
    // scales only silence), with a cycle of 9,001 frames.
    Fixture f;
    f.importWav("med_long", 2, 60'000);
    f.exec(addTrack("trk_c"));
    f.exec(place("clp_c", "trk_c", "med_long", 1'000, 0, 50'000));
    constexpr std::int64_t left = 2'003;
    constexpr std::int64_t right = left + 9'001;
    // trk_a starts at 0 in the rig: silence it so the rise scales nothing.
    f.exec(R"({"op":"track.set_mute","trackId":"trk_a","mute":true})");
    f.exec(R"({"op":"track.set_mute","trackId":"trk_b","mute":true})");
    f.exec(setLocators(left, right));
    constexpr std::int64_t sessionRate = 48'000;
    constexpr std::int64_t deviceRate = 44'100;

    host::ManualAudioDevice::Options fixed;
    fixed.fixedSampleRate = deviceRate;
    host::ManualAudioDevice device(fixed);
    PlaybackEngine engine(f.session, testOptions());
    engine.load();
    engine.setCycle(true);
    engine.start(device, deviceConfig());
    REQUIRE(engine.resampling().active);
    const realtime::LatencyReport latency = engine.driver().latency();
    constexpr int callbacks = 400;  // about 11 passes
    std::vector<std::vector<float>> played(2);
    for (int b = 0; b < callbacks; ++b) {
        device.pumpAll(1, played);
        engine.tick();
        engine.butler().runOnce();
        engine.tick();
    }
    CHECK(engine.driver().srcUnderruns() == 0);
    CHECK(engine.underruns() == 0);
    engine.stop();

    // The session-rate sequence: [0, R), then [L, R) again and again.
    const auto rendered = offline(f.doc(), f.bundle(), right);
    const std::int64_t renderFrames = static_cast<std::int64_t>(callbacks) * kBlock * sessionRate / deviceRate + kBlock;
    std::vector<std::vector<float>> sequence(2);
    for (std::int64_t at = 0, i = 0; i < renderFrames; ++i) {
        sequence[0].push_back(rendered[0][static_cast<std::size_t>(at)]);
        sequence[1].push_back(rendered[1][static_cast<std::size_t>(at)]);
        at = at + 1 == right ? left : at + 1;
    }

    realtime::StreamResampler src(static_cast<double>(sessionRate), static_cast<double>(deviceRate), 2, kBlock);
    REQUIRE(latency.srcOutputLatencyFrames == src.lookaheadFrames() + kBlock);
    std::vector<std::vector<float>> expected(2);
    std::vector<std::vector<float>> in(2, std::vector<float>(kBlock, 0.0f));
    std::vector<std::vector<float>> out(2, std::vector<float>(static_cast<std::size_t>(src.maxOutputFrames())));
    const float* inPointers[2] = {in[0].data(), in[1].data()};
    float* outPointers[2] = {out[0].data(), out[1].data()};
    const auto feed = [&](int frames) {
        const int produced = src.process(inPointers, frames, outPointers);
        for (std::size_t c = 0; c < 2; ++c) {
            expected[c].insert(expected[c].end(), out[c].begin(), out[c].begin() + produced);
        }
    };
    for (int done = 0; done < src.lookaheadFrames();) {
        const int n = std::min(kBlock, src.lookaheadFrames() - done);
        feed(n);
        done += n;
    }
    feed(kBlock);  // the primed FIFO block
    for (std::int64_t at = 0; at + kBlock <= renderFrames; at += kBlock) {
        for (std::size_t c = 0; c < 2; ++c) {
            std::copy_n(sequence[c].begin() + at, kBlock, in[c].begin());
        }
        feed(kBlock);
    }
    const std::size_t compared = static_cast<std::size_t>(callbacks) * kBlock;
    REQUIRE(played[0].size() == compared);
    REQUIRE(expected[0].size() >= compared);
    for (std::size_t c = 0; c < 2; ++c) {
        INFO("channel " << c);
        std::size_t mismatches = 0;
        for (std::size_t i = 0; i < compared; ++i) {
            mismatches += played[c][i] != expected[c][i] ? 1 : 0;
        }
        CHECK(mismatches == 0);
    }
}
