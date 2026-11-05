#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "siann/graph/nodes.hpp"
#include "siann/playback/audition.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "support/live_rig.hpp"

// Proposal audition (architecture spec, "Proposal audition (A/B)" and
// "Publishing and retiring graphs", decisions of 2026-11-05): hearing a
// proposal branch is an ordinary structural transition with duck-and-swap,
// only the live graph exists, and a switch over the memory or CPU budget is
// refused with a reason before anything is allocated.

using namespace live_rig;
using playback::AuditionError;
using playback::Auditioner;

namespace {

// The duck block fades the old graph out and the rise block fades the new one
// in (M2 ducks the whole mix, see the M2 interim note).
bool withinDuckEnvelope(const Live& p, const std::vector<std::vector<float>>& oldRef,
                        const std::vector<std::vector<float>>& newRef, int duck) {
    for (int c = 0; c < 2; ++c) {
        for (int i = 0; i < kBlock; ++i) {
            const auto at = static_cast<std::size_t>(duck * kBlock + i);
            const float duckGain = static_cast<float>(kBlock - i) / static_cast<float>(kBlock);
            const float riseGain = 1.0f - duckGain;
            const auto& o = p.out[static_cast<std::size_t>(c)];
            if (std::abs(o[at]) > std::abs(oldRef[static_cast<std::size_t>(c)][at]) * duckGain + 1e-6f ||
                std::abs(o[at + kBlock]) >
                    std::abs(newRef[static_cast<std::size_t>(c)][at + kBlock]) * riseGain + 1e-6f) {
                return false;
            }
        }
    }
    return true;
}

// A proposal that adds trk_c with a stereo clip.
command::BranchId proposeTrackC(Fixture& f) {
    const command::BranchId b = f.session.branch(f.session.history().head().envelope.id);
    f.session.commitOn(b, {cmd(addTrack("trk_c")), cmd(place("clp_c", "trk_c", "med_st", 2'000, 3'000, 40'000))},
                       "agent", "t");
    return b;
}

const Document& branchDoc(Fixture& f, const command::BranchId& b) {
    return f.session.history().branchHead(b).document;
}

std::string auditionCode(const std::function<void()>& action) {
    try {
        action();
    } catch (const AuditionError& error) {
        return error.code();
    }
    return "no error";
}

}  // namespace

TEST_CASE("Auditioning a proposal switches the live graph with duck-and-swap and plays the branch document",
          "[playback][audition]") {
    Fixture f;
    Live p(f.session);
    p.pump(40);
    const Document mainDoc = f.doc();
    const command::BranchId b = proposeTrackC(f);
    const std::uint64_t epoch = p.engine.driver().liveEpoch();
    const std::size_t compiles = p.engine.compileCount();
    Auditioner a(p.engine, f.session);
    CHECK_FALSE(a.heard().has_value());

    const auto allocations = rt::allocationViolations();
    a.audition(b);
    p.pump(30);

    CHECK(a.heard() == std::optional<command::BranchId>{b});
    CHECK(p.engine.driver().liveEpoch() != epoch);
    CHECK(p.engine.compileCount() == compiles + 1);
    CHECK(p.engine.slots().count(playback::trackSlotKey("trk_c")) == 1);
    CHECK(f.doc().documentHash() == mainDoc.documentHash());  // main is untouched
    const int duck = p.lastDuckBlock();
    REQUIRE(duck >= 40);
    const auto mainRef = offline(mainDoc, f.bundle(), framesOf(p));
    const auto branchRef = offline(branchDoc(f, b), f.bundle(), framesOf(p));
    CHECK(matches(p, mainRef, 1, duck));
    CHECK(matches(p, branchRef, duck + 2, p.blockCount()));
    CHECK(withinDuckEnvelope(p, mainRef, branchRef, duck));
    CHECK(p.engine.underruns() == 0);
    CHECK(rt::allocationViolations() == allocations);
}

TEST_CASE("Switching back to main is another duck-and-swap and only the live graph exists", "[playback][audition]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const Document mainDoc = f.doc();
    const std::size_t mainStreams = p.engine.streamCount();
    const command::BranchId b = proposeTrackC(f);
    Auditioner a(p.engine, f.session);
    a.audition(b);
    p.pump(30);
    const int firstDuck = p.lastDuckBlock();
    REQUIRE(p.engine.streamCount() == mainStreams + 1);
    CHECK(p.engine.driver().ownedGraphs() == 1);
    const std::size_t compiles = p.engine.compileCount();
    const auto allocations = rt::allocationViolations();

    a.hear(Auditioner::Side::main);
    p.pump(30);

    CHECK_FALSE(a.heard().has_value());
    CHECK(p.engine.compileCount() == compiles + 1);
    const int duck = p.lastDuckBlock();
    REQUIRE(duck > firstDuck + 1);
    const auto mainRef = offline(mainDoc, f.bundle(), framesOf(p));
    const auto branchRef = offline(branchDoc(f, b), f.bundle(), framesOf(p));
    CHECK(matches(p, branchRef, firstDuck + 2, duck));
    CHECK(matches(p, mainRef, duck + 2, p.blockCount()));
    CHECK(withinDuckEnvelope(p, branchRef, mainRef, duck));
    // No cached branch graph or streams: one graph, main's streams only.
    CHECK(p.engine.driver().ownedGraphs() == 1);
    CHECK_FALSE(p.engine.driver().transitionInFlight());
    CHECK(p.engine.streamCount() == mainStreams);
    CHECK(p.engine.streamFor("trk_c") == nullptr);
    CHECK(p.engine.underruns() == 0);
    CHECK(rt::allocationViolations() == allocations);
    // The branch keeps only its document.
    CHECK(f.session.history().branches() == std::vector<command::BranchId>{b});
}

TEST_CASE("Auditioning another proposal replaces the one heard", "[playback][audition]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const command::BranchId b1 = proposeTrackC(f);
    const command::BranchId b2 = f.session.branch(f.session.history().head().envelope.id);
    f.session.commitOn(b2, {cmd(R"({"op":"track.remove","trackId":"trk_b"})")}, "agent", "t");
    Auditioner a(p.engine, f.session);

    a.audition(b1);
    p.pump(30);
    REQUIRE(p.engine.streamCount() == 3);
    a.audition(b2);
    p.pump(30);

    CHECK(a.heard() == std::optional<command::BranchId>{b2});
    const int duck = p.lastDuckBlock();
    const auto ref = offline(branchDoc(f, b2), f.bundle(), framesOf(p));
    CHECK(matches(p, ref, duck + 2, p.blockCount()));
    CHECK(p.engine.streamCount() == 1);
    CHECK(p.engine.streamFor("trk_c") == nullptr);
    CHECK(p.engine.streamFor("trk_b") == nullptr);
    CHECK(p.engine.driver().ownedGraphs() == 1);
    CHECK(p.engine.underruns() == 0);

    CHECK(auditionCode([&] { a.audition("p9"); }) == "audition_not_found");
    CHECK(a.heard() == std::optional<command::BranchId>{b2});
}

TEST_CASE("A memory budget refusal returns a reason and changes nothing", "[playback][audition][budget]") {
    Fixture f;
    PlaybackOptions options = testOptions();
    options.auditionBudget.maxBytes = 1'000;  // one new stereo stream needs 2 x 8,192 x 2 x 4 bytes
    Live p(f.session, options);
    p.pump(20);
    const command::BranchId b = proposeTrackC(f);
    Auditioner a(p.engine, f.session);

    const playback::AuditionCost cost = p.engine.estimateCost(branchDoc(f, b));
    CHECK(cost.bytes == 2u * 8'192u * 2u * sizeof(float));  // two ring slots of 8,192 stereo frames
    CHECK(p.engine.estimateCost(f.doc()).bytes == 0);  // every live stream is reused

    const std::uint64_t epoch = p.engine.driver().liveEpoch();
    const std::size_t compiles = p.engine.compileCount();
    const std::size_t streams = p.engine.streamCount();
    try {
        a.audition(b);
        FAIL("expected audition_budget_exceeded");
    } catch (const AuditionError& error) {
        CHECK(error.code() == "audition_budget_exceeded");
        const std::string reason = error.what();
        CHECK(reason.find("131072 bytes") != std::string::npos);
        CHECK(reason.find("1000") != std::string::npos);
    }
    CHECK(p.engine.streamCount() == streams);  // the estimate allocates no stream
    p.pump(10);
    CHECK_FALSE(a.heard().has_value());
    CHECK(p.engine.driver().liveEpoch() == epoch);
    CHECK(p.engine.compileCount() == compiles);
    CHECK(p.engine.streamCount() == streams);
    CHECK(p.inFlightBefore == std::vector<bool>(p.inFlightBefore.size(), false));

    SECTION("a proposal that needs no new stream fits") {
        const command::BranchId faders = f.session.branch(f.session.history().head().envelope.id);
        f.session.commitOn(faders, {cmd(R"({"op":"track.set_gain","trackId":"trk_a","gainMilliDb":-6000})")}, "agent",
                           "t");
        a.audition(faders);
        p.pump(4);
        CHECK(a.heard() == std::optional<command::BranchId>{faders});
        const auto ref = offline(branchDoc(f, faders), f.bundle(), framesOf(p));
        CHECK(matches(p, ref, p.blockCount() - 2, p.blockCount()));
    }
}

TEST_CASE("A CPU budget refusal returns a reason", "[playback][audition][budget]") {
    Fixture f;
    PlaybackOptions options = testOptions();
    options.auditionBudget.maxNodes = 1;
    Live p(f.session, options);
    p.pump(20);
    const command::BranchId b = proposeTrackC(f);
    Auditioner a(p.engine, f.session);

    const playback::AuditionCost cost = p.engine.estimateCost(branchDoc(f, b));
    const auto compiled = playback::compileForPlayback(branchDoc(f, b), f.bundle(), testOptions());
    CHECK(cost.nodes == compiled.graph->nodeCount());

    const std::uint64_t epoch = p.engine.driver().liveEpoch();
    const std::size_t compiles = p.engine.compileCount();
    const std::size_t streams = p.engine.streamCount();
    try {
        a.audition(b);
        FAIL("expected audition_budget_exceeded");
    } catch (const AuditionError& error) {
        CHECK(error.code() == "audition_budget_exceeded");
        const std::string reason = error.what();
        CHECK(reason.find(std::to_string(cost.nodes) + " nodes") != std::string::npos);
        CHECK(reason.find("budget of 1") != std::string::npos);
    }
    p.pump(10);
    CHECK_FALSE(a.heard().has_value());
    CHECK(p.engine.driver().liveEpoch() == epoch);
    CHECK(p.engine.compileCount() == compiles);
    CHECK(p.engine.streamCount() == streams);
}

TEST_CASE("A gesture ended while a proposal is heard commits onto that branch", "[playback][audition]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const command::BranchId b = proposeTrackC(f);
    const std::string branchTip = f.session.history().branchHead(b).envelope.id;
    const std::string mainHead = f.session.history().head().envelope.id;
    Auditioner a(p.engine, f.session);
    a.audition(b);
    p.pump(30);
    const std::size_t compiles = p.engine.compileCount();

    constexpr auto kGain = graph::TrackFaderNode::kGainMilliDb;
    p.engine.beginGesture("trk_a", kGain);
    p.engine.updateGesture("trk_a", kGain, -6'000, 0);
    p.pump(2);
    const command::Revision* revision = p.engine.endGesture("trk_a", kGain, "user", "t");
    REQUIRE(revision != nullptr);
    CHECK(revision->envelope.parents == std::vector<std::string>{branchTip});
    CHECK(revision->branch == std::optional<command::BranchId>{b});
    CHECK(f.session.history().head().envelope.id == mainHead);
    CHECK(f.doc().track("trk_a")->gain.milliDb == 0);
    CHECK(branchDoc(f, b).track("trk_a")->gain.milliDb == -6'000);
    a.onBranchCommitted(b);

    // A main commit while the proposal is heard does not touch the sound.
    f.session.commit({cmd(R"({"op":"track.set_gain","trackId":"trk_b","gainMilliDb":-12000})")}, "user", "t");
    a.onMainCommitted();
    const int from = p.blockCount() + 1;
    p.pump(10);
    CHECK(p.engine.compileCount() == compiles);
    const auto ref = offline(branchDoc(f, b), f.bundle(), framesOf(p));
    CHECK(matches(p, ref, from, p.blockCount()));
    CHECK(p.engine.underruns() == 0);

    // Hearing main again plays main's head, with its own trk_b edit.
    a.hear(Auditioner::Side::main);
    p.pump(30);
    const auto mainRef = offline(f.doc(), f.bundle(), framesOf(p));
    CHECK(matches(p, mainRef, p.lastDuckBlock() + 2, p.blockCount()));
    // Gestures commit onto main again.
    p.engine.beginGesture("trk_a", kGain);
    p.engine.updateGesture("trk_a", kGain, -3'000, 0);
    const command::Revision* onMain = p.engine.endGesture("trk_a", kGain, "user", "t");
    REQUIRE(onMain != nullptr);
    CHECK_FALSE(onMain->branch.has_value());
    CHECK(f.session.history().head().envelope.id == onMain->envelope.id);
}

TEST_CASE("Merging the auditioned proposal makes main the heard document without a second swap of sound",
          "[playback][audition]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const command::BranchId b = proposeTrackC(f);
    Auditioner a(p.engine, f.session);
    a.audition(b);
    p.pump(30);
    const int duck = p.lastDuckBlock();
    const std::uint64_t epoch = p.engine.driver().liveEpoch();
    const std::size_t compiles = p.engine.compileCount();

    // Merging through the auditioner: main is heard as soon as the merge lands.
    const command::Revision& merged = a.merge(b, "user", "t");
    const Document mergedDoc = merged.document;
    CHECK_FALSE(a.heard().has_value());
    CHECK_FALSE(p.engine.gestureBranch().has_value());
    CHECK(f.session.history().head().envelope.id == merged.envelope.id);
    p.pump(20);

    CHECK(p.engine.compileCount() == compiles);
    CHECK(p.engine.driver().liveEpoch() == epoch);
    CHECK(p.lastDuckBlock() == duck);
    const auto ref = offline(mergedDoc, f.bundle(), framesOf(p));
    CHECK(matches(p, ref, duck + 2, p.blockCount()));
    CHECK(p.engine.driver().ownedGraphs() == 1);
    CHECK(p.engine.underruns() == 0);

    // Gestures commit onto main again.
    constexpr auto kGain = graph::TrackFaderNode::kGainMilliDb;
    p.engine.beginGesture("trk_a", kGain);
    p.engine.updateGesture("trk_a", kGain, -3'000, 0);
    const command::Revision* onMain = p.engine.endGesture("trk_a", kGain, "user", "t");
    REQUIRE(onMain != nullptr);
    CHECK_FALSE(onMain->branch.has_value());
    CHECK(auditionCode([&] { (void)a.merge(b, "user", "t"); }) == "audition_not_found");
}

TEST_CASE("Merging a proposal while main is heard makes the sound follow main's new head", "[playback][audition]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const command::BranchId b = proposeTrackC(f);
    Auditioner a(p.engine, f.session);
    REQUIRE_FALSE(a.heard().has_value());
    const std::size_t compiles = p.engine.compileCount();

    const command::Revision& merged = a.merge(b, "user", "t");
    const Document mergedDoc = merged.document;
    CHECK_FALSE(a.heard().has_value());
    CHECK_FALSE(p.engine.gestureBranch().has_value());
    p.pump(30);

    CHECK(p.engine.compileCount() == compiles + 1);
    const int duck = p.lastDuckBlock();
    REQUIRE(duck >= 20);
    const auto ref = offline(mergedDoc, f.bundle(), framesOf(p));
    CHECK(matches(p, ref, duck + 2, p.blockCount()));
    CHECK(p.engine.driver().ownedGraphs() == 1);
    CHECK(p.engine.underruns() == 0);

    // Merging one proposal while another is heard leaves the heard one alone.
    const command::BranchId other = f.session.branch(f.session.history().head().envelope.id);
    f.session.commitOn(other, {cmd(R"({"op":"track.set_gain","trackId":"trk_b","gainMilliDb":-6000})")}, "agent",
                       "t");
    const command::BranchId heardBranch = f.session.branch(f.session.history().head().envelope.id);
    f.session.commitOn(heardBranch, {cmd(R"({"op":"track.set_gain","trackId":"trk_a","gainMilliDb":-3000})")},
                       "agent", "t");
    a.audition(heardBranch);
    p.pump(30);
    const std::size_t heardCompiles = p.engine.compileCount();
    const int heardDuck = p.lastDuckBlock();
    (void)a.merge(other, "user", "t");
    p.pump(20);
    CHECK(a.heard() == std::optional<command::BranchId>{heardBranch});
    CHECK(p.engine.compileCount() == heardCompiles);
    CHECK(p.lastDuckBlock() == heardDuck);
}

TEST_CASE("A conflicting merge through the auditioner keeps the proposal heard", "[playback][audition]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const command::BranchId b = f.session.branch(f.session.history().head().envelope.id);
    f.session.commitOn(b, {cmd(R"({"op":"track.set_gain","trackId":"trk_a","gainMilliDb":-6000})")}, "agent", "t");
    f.session.commit({cmd(R"({"op":"track.set_gain","trackId":"trk_a","gainMilliDb":-3000})")}, "user", "t");
    Auditioner a(p.engine, f.session);
    a.audition(b);
    p.pump(10);

    try {
        (void)a.merge(b, "user", "t");
        FAIL("expected branch_conflict");
    } catch (const command::CommandError& error) {
        CHECK(error.code() == "branch_conflict");
    }
    CHECK(a.heard() == std::optional<command::BranchId>{b});
    CHECK(p.engine.gestureBranch() == std::optional<command::BranchId>{b});
}

TEST_CASE("A gesture ending after the heard proposal was closed on the session commits nothing",
          "[playback][audition]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const command::BranchId b = proposeTrackC(f);
    Auditioner a(p.engine, f.session);
    a.audition(b);
    p.pump(10);
    // Bypassing the auditioner: the session merges the heard branch directly.
    f.session.merge(b, "user", "t");
    const std::size_t revisions = f.session.history().revisions().size();

    constexpr auto kGain = graph::TrackFaderNode::kGainMilliDb;
    p.engine.beginGesture("trk_a", kGain);
    p.engine.updateGesture("trk_a", kGain, -6'000, 0);
    CHECK(auditionCode([&] { (void)p.engine.endGesture("trk_a", kGain, "user", "t"); }) == "audition_not_found");
    CHECK(f.session.history().revisions().size() == revisions);
    // hear(main) recovers.
    a.hear(Auditioner::Side::main);
    CHECK_FALSE(a.heard().has_value());
    p.engine.beginGesture("trk_a", kGain);
    p.engine.updateGesture("trk_a", kGain, -6'000, 0);
    const command::Revision* onMain = p.engine.endGesture("trk_a", kGain, "user", "t");
    REQUIRE(onMain != nullptr);
    CHECK_FALSE(onMain->branch.has_value());
}

TEST_CASE("Discarding the auditioned proposal returns the sound to main", "[playback][audition]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const Document mainDoc = f.doc();
    const command::BranchId b = proposeTrackC(f);
    const std::string branchRev = f.session.history().branchHead(b).envelope.id;
    Auditioner a(p.engine, f.session);
    a.audition(b);
    p.pump(30);
    const int firstDuck = p.lastDuckBlock();

    a.discard(b);
    p.pump(30);

    CHECK_FALSE(a.heard().has_value());
    CHECK(f.session.history().branches().empty());
    CHECK(f.session.history().find(branchRev) != nullptr);
    CHECK_FALSE(f.session.history().reachable(branchRev));
    const int duck = p.lastDuckBlock();
    REQUIRE(duck > firstDuck + 1);
    const auto ref = offline(mainDoc, f.bundle(), framesOf(p));
    CHECK(matches(p, ref, duck + 2, p.blockCount()));
    CHECK(p.engine.streamCount() == 2);
    CHECK(p.engine.driver().ownedGraphs() == 1);
    CHECK(auditionCode([&] { a.audition(b); }) == "audition_not_found");
}

TEST_CASE("An approved plan proposed onto a branch can be auditioned end to end", "[playback][audition][plan]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const Document mainDoc = f.doc();
    const std::string base = f.session.history().head().envelope.id;
    const std::string hash =
        *f.session
             .submitPlan({cmd(addTrack("trk_c")), cmd(place("clp_c", "trk_c", "med_st", 2'000, 3'000, 40'000)),
                          cmd(R"({"op":"track.set_gain","trackId":"trk_a","gainMilliDb":-6000})")},
                         {}, base)
             .hashText;
    f.session.approvePlan(hash, "user", "t");
    const command::BranchId b = f.session.proposePlan(hash, "agent", "t");
    CHECK(f.session.history().branchHead(b).envelope.parents == std::vector<std::string>{base});
    Auditioner a(p.engine, f.session);

    a.audition(b);
    p.pump(30);
    const int duck = p.lastDuckBlock();
    REQUIRE(duck >= 20);
    const auto mainRef = offline(mainDoc, f.bundle(), framesOf(p));
    const auto planRef = offline(branchDoc(f, b), f.bundle(), framesOf(p));
    CHECK(matches(p, mainRef, 1, duck));
    CHECK(matches(p, planRef, duck + 2, p.blockCount()));
    CHECK(withinDuckEnvelope(p, mainRef, planRef, duck));

    a.hear(Auditioner::Side::main);
    p.pump(30);
    const auto mainAgain = offline(mainDoc, f.bundle(), framesOf(p));
    CHECK(matches(p, mainAgain, p.lastDuckBlock() + 2, p.blockCount()));
    CHECK(p.engine.driver().ownedGraphs() == 1);
    CHECK(p.engine.streamCount() == 2);
    CHECK(p.engine.underruns() == 0);

    // Merging the proposal lands the plan at the merge revision.
    const std::string mergedId = a.merge(b, "user", "t").envelope.id;
    CHECK(f.session.plans().find(hash)->state == command::PlanState::applied);
    CHECK(f.session.plans().find(hash)->appliedRevision == std::optional<std::string>{mergedId});
}
