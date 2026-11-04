#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

#include "siann/rt/realtime_thread.hpp"
#include "support/live_rig.hpp"

// Structural edits while playing (architecture spec, revision 3.1,
// "Publishing and retiring graphs", "State migration"): the playback engine
// recompiles the latest document, reuses unchanged disk streams, prefills new
// ones from the playhead, publishes with duck-and-swap and destroys a stream
// only after its last graph retired and the butler released it.

using namespace live_rig;

TEST_CASE("Adding a track while playing swaps with duck-and-swap and then matches the offline render of the new "
          "document",
          "[playback][live]") {
    Fixture f;
    Live p(f.session);
    p.pump(40);
    const Document before = f.doc();
    const std::uint64_t epoch = p.engine.driver().liveEpoch();
    const std::size_t compiles = p.engine.compileCount();

    f.session.commit({cmd(addTrack("trk_c")), cmd(place("clp_c", "trk_c", "med_st", 2'000, 3'000, 40'000))}, "test",
                     "t");
    const auto allocations = rt::allocationViolations();
    p.engine.update(f.doc());
    p.pump(30);

    CHECK(p.engine.driver().liveEpoch() != epoch);
    CHECK(p.engine.compileCount() == compiles + 1);
    CHECK(p.engine.slots().count(playback::trackSlotKey("trk_c")) == 1);
    CHECK(p.engine.streamCount() == 3);
    const int duck = p.lastDuckBlock();
    REQUIRE(duck >= 40);
    const int n = p.blockCount();
    const auto oldReference = offline(before, f.bundle(), framesOf(p));
    const auto newReference = offline(f.doc(), f.bundle(), framesOf(p));
    CHECK(matches(p, oldReference, 1, duck));
    CHECK(matches(p, newReference, duck + 2, n));

    // The duck block fades the old graph out; the rise block fades the new one in.
    // M2 ducks the whole mix, unaffected tracks included (spec, M2 interim note).
    bool withinEnvelope = true;
    for (int c = 0; c < 2; ++c) {
        for (int i = 0; i < kBlock; ++i) {
            const auto at = static_cast<std::size_t>(duck * kBlock + i);
            const float duckGain = static_cast<float>(kBlock - i) / static_cast<float>(kBlock);
            const float riseGain = 1.0f - static_cast<float>(kBlock - i) / static_cast<float>(kBlock);
            const auto& o = p.out[static_cast<std::size_t>(c)];
            const auto& oldRef = oldReference[static_cast<std::size_t>(c)];
            const auto& newRef = newReference[static_cast<std::size_t>(c)];
            withinEnvelope = withinEnvelope && std::abs(o[at]) <= std::abs(oldRef[at]) * duckGain + 1e-6f;
            withinEnvelope = withinEnvelope && std::abs(o[at + kBlock]) <= std::abs(newRef[at + kBlock]) * riseGain + 1e-6f;
        }
    }
    CHECK(withinEnvelope);
    CHECK(p.engine.underruns() == 0);
    CHECK(rt::allocationViolations() == allocations);
}

TEST_CASE("Removing a track destroys its stream only after retire and butler release", "[playback][live]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    REQUIRE(p.engine.streamCount() == 2);

    f.exec(R"({"op":"track.remove","trackId":"trk_b"})");
    p.engine.update(f.doc());
    p.engine.tick();  // compiles; every stream is reused, so it publishes at once
    REQUIRE(p.engine.driver().transitionInFlight());
    p.device.pumpAll(1, p.out);  // the duck block; the swap lands at its end
    CHECK(p.engine.streamCount() == 2);

    p.engine.tick();  // the swap acknowledgement retires the old graph
    REQUIRE_FALSE(p.engine.driver().transitionInFlight());
    CHECK(p.engine.streamCount() == 2);  // removal requested, not yet released
    p.engine.butler().runOnce();          // the butler releases it
    CHECK(p.engine.streamCount() == 2);  // destroyed on the command thread's tick
    p.engine.tick();
    CHECK(p.engine.streamCount() == 1);
    CHECK(p.engine.streamFor("trk_b") == nullptr);

    p.pump(20);
    const auto reference = offline(f.doc(), f.bundle(), framesOf(p));
    CHECK(matches(p, reference, 22, p.blockCount()));
    CHECK(p.engine.underruns() == 0);
}

TEST_CASE("A clip edit replaces only that track's stream", "[playback][live]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const realtime::DiskStream* streamA = p.engine.streamFor("trk_a");
    const realtime::DiskStream* streamB = p.engine.streamFor("trk_b");
    REQUIRE(streamA != nullptr);
    REQUIRE(streamB != nullptr);

    f.exec(R"({"op":"clip.move","clipId":"clp_b","position":{"domain":"audio","value":"9000"}})");
    p.engine.update(f.doc());
    p.pump(20);

    CHECK(p.engine.streamFor("trk_a") == streamA);
    CHECK(p.engine.streamFor("trk_b") != nullptr);
    CHECK(p.engine.streamFor("trk_b") != streamB);
    CHECK(p.engine.streamCount() == 2);
    const int duck = p.lastDuckBlock();
    REQUIRE(duck >= 20);
    const auto reference = offline(f.doc(), f.bundle(), framesOf(p));
    CHECK(matches(p, reference, duck + 2, p.blockCount()));
    CHECK(p.engine.underruns() == 0);
}

TEST_CASE("Rapid successive edits coalesce: the next compile uses the latest document", "[playback][live]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const std::size_t compiles = p.engine.compileCount();
    const auto allocations = rt::allocationViolations();

    f.exec(R"({"op":"track.remove","trackId":"trk_b"})");
    p.engine.update(f.doc());
    p.engine.tick();
    REQUIRE(p.engine.driver().transitionInFlight());  // doc1 is on its way
    CHECK(p.engine.compileCount() == compiles + 1);

    f.exec(addTrack("trk_c", 1));
    p.engine.update(f.doc());  // doc2: never compiled
    f.exec(place("clp_c", "trk_c", "med_mono", 4'000, 0, 30'000));
    p.engine.update(f.doc());  // doc3
    p.pump(30);

    CHECK(p.engine.compileCount() == compiles + 2);
    CHECK(p.engine.slots().size() == 2);
    CHECK(p.engine.slots().count(playback::trackSlotKey("trk_c")) == 1);
    CHECK(p.engine.streamCount() == 2);
    CHECK_FALSE(p.engine.driver().transitionInFlight());
    const int duck = p.lastDuckBlock();
    REQUIRE(duck >= 21);
    const auto reference = offline(f.doc(), f.bundle(), framesOf(p));
    CHECK(matches(p, reference, duck + 2, p.blockCount()));
    CHECK(p.engine.underruns() == 0);
    CHECK(rt::allocationViolations() == allocations);
}

TEST_CASE("A locate that lands between the compile and the publish reaches the new track's stream",
          "[playback][live][locate]") {
    Fixture f;
    Live p(f.session);
    p.pump(100);  // the playhead is well past the locate target
    constexpr std::int64_t kTarget = 2'000;

    f.session.commit({cmd(addTrack("trk_c")), cmd(place("clp_c", "trk_c", "med_st", 0, 3'000, 40'000))}, "test", "t");
    p.engine.update(f.doc());
    p.engine.tick();  // compiles from the playhead; the new stream is not prefilled yet
    REQUIRE_FALSE(p.engine.driver().transitionInFlight());

    // The butler takes the new stream and prepares the locate for every stream;
    // the locate then lands on the old graph before the new one is published.
    p.engine.butler().seek(2, kTarget);
    p.engine.butler().runOnce();
    REQUIRE(p.engine.butler().ready(2));
    REQUIRE(p.engine.driver().pushLocate(realtime::TransportCommand{2, kTarget}));
    const int locateBlock = p.blockCount();
    p.inFlightBefore.push_back(p.engine.driver().transitionInFlight());
    p.device.pumpAll(1, p.out);  // the old graph ducks; the jump lands at the block's end
    p.pump(30);                  // publishes, swaps and plays the new graph

    REQUIRE_FALSE(p.engine.driver().transitionInFlight());
    CHECK(p.engine.slots().count(playback::trackSlotKey("trk_c")) == 1);
    const int duck = p.lastDuckBlock();
    REQUIRE(duck > locateBlock);
    // From the block after the locate on, block b plays the timeline from
    // kTarget + (b - locateBlock - 1) blocks.
    const auto reference = offline(f.doc(), f.bundle(), kTarget + framesOf(p));
    bool inTime = true;
    for (int b = duck + 2; b < p.blockCount(); ++b) {
        const std::int64_t at = kTarget + static_cast<std::int64_t>(b - locateBlock - 1) * kBlock;
        for (int c = 0; c < 2; ++c) {
            const auto& o = p.out[static_cast<std::size_t>(c)];
            const auto& r = reference[static_cast<std::size_t>(c)];
            inTime = inTime && std::equal(o.begin() + static_cast<std::ptrdiff_t>(b) * kBlock,
                                          o.begin() + static_cast<std::ptrdiff_t>(b + 1) * kBlock,
                                          r.begin() + static_cast<std::ptrdiff_t>(at));
        }
    }
    CHECK(inTime);
    CHECK(p.engine.underruns() == 0);
}

TEST_CASE("An edit that only changes fader parameters does not recompile", "[playback][live]") {
    Fixture f;
    Live p(f.session);
    p.pump(10);
    const std::size_t compiles = p.engine.compileCount();
    const std::uint64_t epoch = p.engine.driver().liveEpoch();

    f.session.commit({cmd(R"({"op":"track.set_gain","trackId":"trk_a","gainMilliDb":-6000})"),
                      cmd(R"({"op":"track.set_pan","trackId":"trk_b","pan":-3000})")},
                     "test", "t");
    p.engine.update(f.doc());
    p.pump(12);

    CHECK(p.engine.compileCount() == compiles);
    CHECK(p.engine.driver().liveEpoch() == epoch);
    CHECK(p.inFlightBefore == std::vector<bool>(p.inFlightBefore.size(), false));
    // Block 10 was rendered before the dispatcher's tick; block 11 on carries the edit.
    const auto reference = offline(f.doc(), f.bundle(), framesOf(p));
    CHECK(matches(p, reference, 11, p.blockCount()));
    CHECK(p.engine.underruns() == 0);
}
