// audition.hear and the proposal methods through the AuditionPort (spec,
// "siann-protocol", AuditionPort; Protocol v0 item 14): a real
// playback::Auditioner on a ManualAudioDevice behind the port, pumped by the
// test. The binary links the realtime allocation guard.

#include <catch2/catch_test_macros.hpp>

#include <optional>
#include <string>
#include <utility>

#include "live_rig.hpp"
#include "siann/playback/audition.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "siann/engine_app/auditioner_port.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using protocol::ConnectionId;
using protocol::ServerOptions;
using protocol::testing::at;
using engine_app::AuditionerPort;
using protocol::testing::canonical;
using protocol::testing::errorCode;
using protocol::testing::Harness;
using protocol::testing::manualOptions;
using json::Array;
using json::Object;
using json::Value;

namespace {

// live_rig's session (trk_a, trk_b, two WAV media) played on a manual device,
// its auditioner behind the port, and a protocol server over the session.
struct Rig {
    explicit Rig(playback::PlaybackOptions playbackOptions = live_rig::testOptions())
        : live(media.session, playbackOptions),
          auditioner(live.engine, media.session),
          port(auditioner),
          harness(media.session, withPort(port)) {}

    static ServerOptions withPort(AuditionerPort& p) {
        ServerOptions options = manualOptions();
        options.auditionPort = &p;
        return options;
    }

    // Submits, approves and proposes a plan adding trk_c with a stereo clip;
    // returns the branch.
    std::string proposeTrackC(ConnectionId c) {
        const Array steps{json::parse(live_rig::addTrack("trk_c")),
                          json::parse(live_rig::place("clp_c", "trk_c", "med_st", 2'000, 3'000, 40'000))};
        const Value plan = harness.ok(c, "plan.submit", Value(Object{{"steps", Value(steps)}}));
        const std::string hash = at(plan, "hash").asString();
        harness.ok(c, "plan.approve", Value(Object{{"plan", Value(hash)}}));
        return at(harness.ok(c, "plan.propose", Value(Object{{"plan", Value(hash)}})), "branch").asString();
    }

    live_rig::Fixture media;
    live_rig::Live live;
    playback::Auditioner auditioner;
    AuditionerPort port;
    Harness harness;
};

Value side(const std::string& name) {
    return Value(Object{{"side", Value(name)}});
}

Value branch(const std::string& name) {
    return Value(Object{{"branch", Value(name)}});
}

}  // namespace

TEST_CASE("audition.hear switches the heard side through the auditioner and back to main",
          "[protocol][audition]") {
    Rig rig;
    rig.live.pump(10);
    const ConnectionId c = rig.harness.authed();
    const std::string b = rig.proposeTrackC(c);
    CHECK(at(rig.harness.ok(c, "session.inspect"), "heard").asString() == "main");
    const auto allocations = rt::allocationViolations();

    CHECK(at(rig.harness.ok(c, "audition.hear", side(b)), "heard").asString() == b);
    CHECK(rig.auditioner.heard() == std::optional<command::BranchId>{b});
    rig.live.pump(30);
    CHECK(rig.live.engine.slots().count(playback::trackSlotKey("trk_c")) == 1);  // the branch graph is live
    CHECK(at(rig.harness.ok(c, "session.inspect"), "heard").asString() == b);

    CHECK(at(rig.harness.ok(c, "audition.hear", side("main")), "heard").asString() == "main");
    CHECK_FALSE(rig.auditioner.heard().has_value());
    rig.live.pump(30);
    CHECK(rig.live.engine.slots().count(playback::trackSlotKey("trk_c")) == 0);
    CHECK(rt::allocationViolations() == allocations);

    CHECK(errorCode(rig.harness.call(c, "audition.hear", side("p9"))) == "audition_not_found");
    CHECK(errorCode(rig.harness.call(c, "audition.hear", Value(Object{}))) == "invalid_params");
}

TEST_CASE("proposal.merge through the port makes main heard with the merged document", "[protocol][audition]") {
    Rig rig;
    rig.live.pump(10);
    const ConnectionId c = rig.harness.authed();
    const std::string b = rig.proposeTrackC(c);
    rig.harness.ok(c, "audition.hear", side(b));
    rig.live.pump(30);

    const Value merged = rig.harness.ok(c, "proposal.merge", branch(b));
    CHECK(at(at(merged, "revision"), "cause").asString() == "branch-merge");
    CHECK_FALSE(rig.auditioner.heard().has_value());  // main is heard at once
    CHECK(at(rig.harness.ok(c, "session.inspect"), "heard").asString() == "main");
    rig.live.pump(30);
    CHECK(rig.live.engine.slots().count(playback::trackSlotKey("trk_c")) == 1);  // main has trk_c now
}

TEST_CASE("proposal.discard through the port returns to main", "[protocol][audition]") {
    Rig rig;
    const ConnectionId c = rig.harness.authed();
    const std::string b = rig.proposeTrackC(c);
    rig.harness.ok(c, "audition.hear", side(b));
    rig.harness.ok(c, "proposal.discard", branch(b));
    CHECK_FALSE(rig.auditioner.heard().has_value());
    CHECK(rig.media.session.history().branches().empty());
}

TEST_CASE("a budget refusal answers audition_budget_exceeded with the budget as data", "[protocol][audition]") {
    playback::PlaybackOptions options = live_rig::testOptions();
    options.auditionBudget.maxBytes = 0;
    Rig rig(options);
    const ConnectionId c = rig.harness.authed();
    const std::string b = rig.proposeTrackC(c);

    const Value response = rig.harness.call(c, "audition.hear", side(b));
    INFO(canonical(response));
    const Value& error = at(response, "error");
    CHECK(at(error, "code").asString() == "audition_budget_exceeded");
    const Value& data = at(error, "data");
    CHECK(at(data, "resource").asString() == "memory");
    CHECK(at(data, "budget").asString() == "0");
    CHECK(std::stoull(at(data, "needed").asString()) > 0);
    CHECK_FALSE(rig.auditioner.heard().has_value());
}

TEST_CASE("without an audition port audition.hear is audition_unavailable", "[protocol][audition]") {
    protocol::testing::Fixture f;
    const ConnectionId c = f.authed();
    CHECK(errorCode(f.call(c, "audition.hear", side("main"))) == "audition_unavailable");
    CHECK(at(f.ok(c, "session.inspect"), "branches").asArray().empty());
}
