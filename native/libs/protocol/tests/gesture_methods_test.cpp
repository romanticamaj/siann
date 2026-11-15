// gesture.begin, gesture.update, gesture.hold, gesture.end and gesture.cancel
// (spec, Protocol v0 item 24, m5-mixer; docs/schemas/protocol-gestures-v0.md)
// through the GesturePort: the server side only, on a fake port that commits
// on the fixture's session the way the engine host's PlaybackEngine does. The
// engine's real port is tested in apps/engine/tests.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "siann/command/command.hpp"
#include "siann/protocol/gesture_port.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::GestureEnd;
using protocol::GesturePort;
using protocol::GesturePortError;
using protocol::GestureTarget;
using protocol::ServerOptions;

namespace {

using Clock = std::chrono::steady_clock;

// Commits like PlaybackEngine::endGesture: one track.set_gain, set_pan or
// set_mute carrying the last value (master.set_gain for the master target,
// m5b-engine-master; bus.set_gain and send.set_level for a bus or a send,
// m5b-engine-buses-sends), nothing when the gesture never moved.
class FakeGesturePort final : public GesturePort {
public:
    double begin(const GestureTarget& target) override {
        calls.push_back("begin " + key(target));
        if (target.ref() == "master:master") {
            open[key(target)] = std::nullopt;
            return masterValue();
        }
        if (target.kind != GestureTarget::Kind::track) {
            const std::optional<double> value = mixValue(target);
            if (!value) {
                throw GesturePortError("not_found", "no " + target.ref());
            }
            open[key(target)] = std::nullopt;
            return *value;
        }
        const model::Track* track = session->history().head().document.track(target.id);
        if (track == nullptr) {
            throw GesturePortError("not_found", "no track with id " + target.id);
        }
        open[key(target)] = std::nullopt;
        return documentValue(*track, target.param);
    }

    void update(const GestureTarget& target, double value) override {
        calls.push_back("update " + key(target) + " " + std::to_string(static_cast<long long>(value)));
        updates.push_back(value);
        open.at(key(target)) = value;
    }

    GestureEnd end(const GestureTarget& target, std::string actor, std::string time) override {
        calls.push_back("end " + key(target));
        const std::optional<double> last = open.at(key(target));
        open.erase(key(target));
        if (target.ref() == "master:master") {
            const double start = masterValue();
            if (!last) {
                return GestureEnd{start, start, nullptr};
            }
            const command::Revision& revision = session->commit(
                {command::Command::fromJson(json::Value(json::Object{{"op", json::Value("master.set_gain")},
                                                                     {"gainMilliDb", json::Value(*last)}}))},
                std::move(actor), std::move(time));
            lastActor = revision.envelope.actor;
            return GestureEnd{start, *last, &revision};
        }
        if (target.kind != GestureTarget::Kind::track) {
            const double start = *mixValue(target);
            if (!last) {
                return GestureEnd{start, start, nullptr};
            }
            const bool isBus = target.kind == GestureTarget::Kind::bus;
            const json::Object op{{"op", json::Value(isBus ? "bus.set_gain" : "send.set_level")},
                                  {isBus ? "busId" : "sendId", json::Value(target.id)},
                                  {isBus ? "gainMilliDb" : "levelMilliDb", json::Value(*last)}};
            const command::Revision& revision =
                session->commit({command::Command::fromJson(json::Value(op))}, std::move(actor), std::move(time));
            lastActor = revision.envelope.actor;
            return GestureEnd{start, *last, &revision};
        }
        const model::Track& track = *session->history().head().document.track(target.id);
        const double start = documentValue(track, target.param);
        if (!last) {
            return GestureEnd{start, start, nullptr};
        }
        if (refuseEnd) {
            throw command::CommandError(*refuseEnd, "the commit refused the value");
        }
        json::Object op{{"trackId", json::Value(target.id)}};
        if (target.param == "gain") {
            op.emplace_back("op", json::Value("track.set_gain"));
            op.emplace_back("gainMilliDb", json::Value(*last));
        } else if (target.param == "pan") {
            op.emplace_back("op", json::Value("track.set_pan"));
            op.emplace_back("pan", json::Value(*last));
        } else {
            op.emplace_back("op", json::Value("track.set_mute"));
            op.emplace_back("mute", json::Value(*last != 0.0));
        }
        const command::Revision& revision =
            session->commit({command::Command::fromJson(json::Value(std::move(op)))}, std::move(actor), std::move(time));
        lastActor = revision.envelope.actor;
        return GestureEnd{start, *last, &revision};
    }

    void cancel(const GestureTarget& target) override {
        calls.push_back("cancel " + key(target));
        open.erase(key(target));
    }

    std::size_t count(const std::string& prefix) const {
        return static_cast<std::size_t>(std::count_if(calls.begin(), calls.end(), [&](const std::string& call) {
            return call.rfind(prefix, 0) == 0;
        }));
    }

    session::Session* session = nullptr;
    std::vector<std::string> calls;
    std::vector<double> updates;
    std::map<std::string, std::optional<double>> open;
    std::optional<std::string> refuseEnd;
    std::string lastActor;

private:
    static std::string key(const GestureTarget& target) { return target.ref() + "/" + target.param; }

    // A bus gain or a send level in the head document, or nothing when absent.
    std::optional<double> mixValue(const GestureTarget& target) const {
        const model::Document& document = session->history().head().document;
        if (target.kind == GestureTarget::Kind::bus) {
            const model::Bus* bus = document.bus(target.id);
            return bus ? std::optional<double>(bus->gain.milliDb) : std::nullopt;
        }
        const model::Send* send = document.send(target.id);
        return send ? std::optional<double>(send->level.milliDb) : std::nullopt;
    }

    // The head document's master gain; 0 while the entity is absent.
    double masterValue() const {
        const auto* value = session->history().head().document.master();
        return value != nullptr ? static_cast<double>(value->gain.milliDb) : 0.0;
    }

    static double documentValue(const model::Track& track, const std::string& param) {
        if (param == "pan") {
            return static_cast<double>(track.pan);
        }
        if (param == "mute") {
            return track.mute ? 1.0 : 0.0;
        }
        return static_cast<double>(track.gain.milliDb);
    }
};

// A fixture with the port, an injected steady clock and two tracks.
struct GestureFixture {
    explicit GestureFixture(bool withPort = true) : f(options(withPort)) {
        port.session = &f.session;
        f.commit(f.authed(), Array{trackAdd("trk_1"), trackAdd("trk_2")});
    }

    ServerOptions options(bool withPort) {
        ServerOptions out = manualOptions();
        if (withPort) {
            out.gesturePort = &port;
        }
        out.gestureLeaseMs = std::chrono::milliseconds(1'000);
        out.steadyClock = [this] { return now; };
        return out;
    }

    void advance(int ms) { now += std::chrono::milliseconds(ms); }

    std::size_t revisions() const { return f.session.history().revisions().size(); }

    FakeGesturePort port;
    Clock::time_point now{std::chrono::seconds(1'000)};
    Fixture f;
};

Value target(const std::string& ref, const std::string& param) {
    return Value(Object{{"ref", Value(ref)}, {"param", Value(param)}});
}

Value onTarget(const std::string& ref = "track:trk_1", const std::string& param = "gain") {
    return Value(Object{{"target", target(ref, param)}});
}

Value withValue(double value, const std::string& ref = "track:trk_1", const std::string& param = "gain") {
    return Value(Object{{"target", target(ref, param)}, {"value", Value(value)}});
}

std::vector<Value> eventsOfType(const Harness& h, ConnectionId c, const std::string& type) {
    std::vector<Value> out;
    for (Value& event : h.events(c)) {
        if (at(event, "type").asString() == type) {
            out.push_back(std::move(event));
        }
    }
    return out;
}

const std::vector<std::string> kGestureMethods = {"gesture.begin", "gesture.update", "gesture.hold", "gesture.end",
                                                  "gesture.cancel"};

}  // namespace

TEST_CASE("begin, update and end reach the port with the same target and values", "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();

    const Value begun = g.f.ok(c, "gesture.begin", onTarget());
    CHECK(canonical(at(begun, "target")) == canonical(target("track:trk_1", "gain")));
    CHECK(at(begun, "startValue").asNumber() == 0.0);
    CHECK(at(begun, "leaseMs").asNumber() == 1'000);

    for (const double value : {-1'000.0, -2'500.0, -3'500.0}) {
        const Value updated = g.f.ok(c, "gesture.update", withValue(value));
        CHECK(updated.asObject().empty());
    }
    g.f.ok(c, "gesture.end", onTarget());

    CHECK(g.port.calls == std::vector<std::string>{"begin track:trk_1/gain", "update track:trk_1/gain -1000",
                                                   "update track:trk_1/gain -2500", "update track:trk_1/gain -3500",
                                                   "end track:trk_1/gain"});
}

TEST_CASE("end returns startValue, value and the revision envelope, and publishes one session.changed",
          "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    const ConnectionId watcher = g.f.authed(true);
    const std::size_t before = g.revisions();

    g.f.ok(c, "gesture.begin", onTarget());
    g.f.ok(c, "gesture.update", withValue(-4'000));
    g.f.ok(c, "gesture.update", withValue(-3'500));
    CHECK(g.revisions() == before);  // updates never commit
    const Value ended = g.f.ok(c, "gesture.end", onTarget());

    CHECK(g.revisions() == before + 1);
    CHECK(canonical(at(ended, "target")) == canonical(target("track:trk_1", "gain")));
    CHECK(at(ended, "startValue").asNumber() == 0.0);
    CHECK(at(ended, "value").asNumber() == -3'500);
    const Value& revision = at(ended, "revision");
    CHECK(at(revision, "id").asString() == g.f.head().envelope.id);
    CHECK(at(revision, "cause").asString() == "command");
    CHECK(at(revision, "actor").asString() == "protocol");  // the server's actor
    CHECK(canonical(at(revision, "diff")) == canonical(Value(Array{Value("track:trk_1")})));
    CHECK(g.f.head().document.track("trk_1")->gain.milliDb == -3'500);

    const std::vector<Value> changed = eventsOfType(g.f, watcher, "session.changed");
    REQUIRE(changed.size() == 1);
    CHECK(at(changed[0], "revision").asString() == at(revision, "id").asString());
    CHECK(at(changed[0], "cause").asString() == "command");
    const std::vector<Value> endedEvents = eventsOfType(g.f, watcher, "gesture.ended");
    REQUIRE(endedEvents.size() == 1);
    CHECK(at(endedEvents[0], "reason").asString() == "ended");
    CHECK(canonical(at(endedEvents[0], "target")) == canonical(target("track:trk_1", "gain")));
    CHECK(at(endedEvents[0], "startValue").asNumber() == 0.0);
    CHECK(at(endedEvents[0], "value").asNumber() == -3'500);
    CHECK(at(endedEvents[0], "committed").asString() == at(revision, "id").asString());
    // After the commit's session.changed.
    CHECK(std::stoull(at(endedEvents[0], "seq").asString()) > std::stoull(at(changed[0], "seq").asString()));
}

TEST_CASE("end with a value is one last update first", "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    g.f.ok(c, "gesture.begin", onTarget("track:trk_2", "pan"));
    const Value ended = g.f.ok(c, "gesture.end", withValue(2'500, "track:trk_2", "pan"));
    CHECK(at(ended, "value").asNumber() == 2'500);
    CHECK(g.port.updates == std::vector<double>{2'500});
    CHECK(g.f.head().document.track("trk_2")->pan == 2'500);
}

TEST_CASE("a gesture that never moved ends with revision null and commits nothing", "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    const ConnectionId watcher = g.f.authed(true);
    const std::size_t before = g.revisions();

    g.f.ok(c, "gesture.begin", onTarget());
    const Value ended = g.f.ok(c, "gesture.end", onTarget());
    CHECK(at(ended, "revision").kind() == Value::Kind::null);
    CHECK(at(ended, "value").asNumber() == at(ended, "startValue").asNumber());
    CHECK(g.revisions() == before);
    CHECK(eventsOfType(g.f, watcher, "session.changed").empty());
    const std::vector<Value> endedEvents = eventsOfType(g.f, watcher, "gesture.ended");
    REQUIRE(endedEvents.size() == 1);
    CHECK(at(endedEvents[0], "committed").kind() == Value::Kind::null);
}

TEST_CASE("cancel closes the gesture without a commit", "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    const ConnectionId watcher = g.f.authed(true);
    const std::size_t before = g.revisions();
    g.f.ok(c, "gesture.begin", onTarget());
    g.f.ok(c, "gesture.update", withValue(-9'000));
    CHECK(g.f.ok(c, "gesture.cancel", onTarget()).asObject().empty());
    CHECK(g.port.count("cancel ") == 1);
    CHECK(g.revisions() == before);
    const std::vector<Value> endedEvents = eventsOfType(g.f, watcher, "gesture.ended");
    REQUIRE(endedEvents.size() == 1);
    CHECK(at(endedEvents[0], "reason").asString() == "cancelled");
    CHECK(errorCode(g.f.call(c, "gesture.end", onTarget())) == "no_gesture");
}

TEST_CASE("a target another connection holds is gesture_held", "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId owner = g.f.authed();
    const ConnectionId other = g.f.authed();
    g.f.ok(owner, "gesture.begin", onTarget());
    for (const std::string& method : kGestureMethods) {
        INFO(method);
        const Value params = method == "gesture.update" ? withValue(-1'000) : onTarget();
        CHECK(errorCode(g.f.call(other, method, params)) == "gesture_held");
    }
    CHECK(g.port.count("begin ") == 1);
    CHECK(g.port.count("update ") == 0);
    // Another target is free.
    g.f.ok(other, "gesture.begin", onTarget("track:trk_1", "pan"));
}

TEST_CASE("update, hold, end and cancel without a begin are no_gesture", "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    CHECK(errorCode(g.f.call(c, "gesture.update", withValue(-1'000))) == "no_gesture");
    CHECK(errorCode(g.f.call(c, "gesture.hold", onTarget())) == "no_gesture");
    CHECK(errorCode(g.f.call(c, "gesture.end", onTarget())) == "no_gesture");
    CHECK(errorCode(g.f.call(c, "gesture.cancel", onTarget())) == "no_gesture");
    CHECK(g.port.calls.empty());
}

TEST_CASE("a second begin on the same connection and target is gesture_open", "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    g.f.ok(c, "gesture.begin", onTarget());
    CHECK(errorCode(g.f.call(c, "gesture.begin", onTarget())) == "gesture_open");
    CHECK(g.port.count("begin ") == 1);
}

TEST_CASE("a bad target or a value that is not a number is invalid_params", "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    const std::vector<Value> badTargets = {
        Value(Object{}),
        Value(Object{{"target", Value("track:trk_1")}}),
        onTarget("clip:clp_1", "gain"),
        onTarget("track:", "gain"),
        onTarget("trk_1", "gain"),
        onTarget("track:trk_1", "volume"),
        Value(Object{{"target", Value(Object{{"ref", Value("track:trk_1")}})}}),
        Value(Object{{"target", Value(Object{{"ref", Value(3)}, {"param", Value("gain")}})}}),
    };
    for (const std::string& method : kGestureMethods) {
        for (const Value& params : badTargets) {
            INFO(method << " " << canonical(params));
            CHECK(errorCode(g.f.call(c, method, params)) == "invalid_params");
        }
    }
    g.f.ok(c, "gesture.begin", onTarget());
    g.f.ok(c, "gesture.begin", onTarget("track:trk_1", "mute"));
    const std::vector<Value> badValues = {
        Value(Object{{"target", target("track:trk_1", "gain")}}),
        Value(Object{{"target", target("track:trk_1", "gain")}, {"value", Value("-3000")}}),
        Value(Object{{"target", target("track:trk_1", "gain")}, {"value", Value(nullptr)}}),
        Value(Object{{"target", target("track:trk_1", "mute")}, {"value", Value(2)}}),
        Value(Object{{"target", target("track:trk_1", "mute")}, {"value", Value(0.5)}}),
    };
    for (const Value& params : badValues) {
        INFO(canonical(params));
        CHECK(errorCode(g.f.call(c, "gesture.update", params)) == "invalid_params");
    }
    CHECK(errorCode(g.f.call(c, "gesture.end",
                             Value(Object{{"target", target("track:trk_1", "gain")}, {"value", Value(true)}}))) ==
          "invalid_params");
    CHECK(g.port.updates.empty());
}

TEST_CASE("the port's not_found and the commit's code pass through; a refused commit cancels",
          "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    const ConnectionId watcher = g.f.authed(true);
    CHECK(errorCode(g.f.call(c, "gesture.begin", onTarget("track:trk_nope", "gain"))) == "not_found");
    // Nothing is held after a refused begin.
    CHECK(errorCode(g.f.call(c, "gesture.hold", onTarget("track:trk_nope", "gain"))) == "no_gesture");

    g.port.refuseEnd = "invalid_gain";
    g.f.ok(c, "gesture.begin", onTarget());
    g.f.ok(c, "gesture.update", withValue(-1'000));
    CHECK(errorCode(g.f.call(c, "gesture.end", onTarget())) == "invalid_gain");
    CHECK(errorCode(g.f.call(c, "gesture.end", onTarget())) == "no_gesture");
    const std::vector<Value> endedEvents = eventsOfType(g.f, watcher, "gesture.ended");
    REQUIRE(endedEvents.size() == 1);
    CHECK(at(endedEvents[0], "reason").asString() == "cancelled");
    CHECK(at(endedEvents[0], "committed").kind() == Value::Kind::null);
    // The target is free again.
    g.port.refuseEnd.reset();
    g.f.ok(g.f.authed(), "gesture.begin", onTarget());
}

TEST_CASE("an unrenewed lease expires on pump and commits the last value", "[protocol][gesture][lease]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    const ConnectionId watcher = g.f.authed(true);
    const std::size_t before = g.revisions();

    g.f.ok(c, "gesture.begin", onTarget());
    g.f.ok(c, "gesture.update", withValue(-2'000));
    g.advance(999);
    g.f.server.pump();
    CHECK(g.port.count("end ") == 0);
    g.advance(2);
    g.f.server.pump();
    CHECK(g.port.count("end ") == 1);
    CHECK(g.revisions() == before + 1);
    CHECK(g.port.lastActor == "protocol");
    CHECK(g.f.head().document.track("trk_1")->gain.milliDb == -2'000);

    REQUIRE(eventsOfType(g.f, watcher, "session.changed").size() == 1);
    const std::vector<Value> endedEvents = eventsOfType(g.f, watcher, "gesture.ended");
    REQUIRE(endedEvents.size() == 1);
    CHECK(at(endedEvents[0], "reason").asString() == "lease_expired");
    CHECK(at(endedEvents[0], "value").asNumber() == -2'000);
    CHECK(at(endedEvents[0], "committed").asString() == g.f.head().envelope.id);
    // The owner's next request finds no gesture.
    CHECK(errorCode(g.f.call(c, "gesture.update", withValue(-1'000))) == "no_gesture");
}

TEST_CASE("gesture.hold and gesture.update renew the lease", "[protocol][gesture][lease]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    g.f.ok(c, "gesture.begin", onTarget());
    g.advance(600);
    CHECK(g.f.ok(c, "gesture.hold", onTarget()).asObject().empty());
    g.advance(600);  // 1200 ms since begin, 600 since the hold
    g.f.server.pump();
    CHECK(g.port.count("end ") == 0);
    g.f.ok(c, "gesture.update", withValue(-500));
    g.advance(900);
    g.f.server.pump();
    CHECK(g.port.count("end ") == 0);
    g.advance(200);
    g.f.server.pump();
    CHECK(g.port.count("end ") == 1);
}

TEST_CASE("a connection's close ends its gestures and never another connection's", "[protocol][gesture][lease]") {
    GestureFixture g;
    const ConnectionId closing = g.f.authed();
    const ConnectionId staying = g.f.authed();
    const ConnectionId watcher = g.f.authed(true);
    const std::size_t before = g.revisions();

    g.f.ok(closing, "gesture.begin", onTarget("track:trk_1", "gain"));
    g.f.ok(closing, "gesture.update", withValue(-7'000, "track:trk_1", "gain"));
    g.f.ok(closing, "gesture.begin", onTarget("track:trk_1", "pan"));  // never moved
    g.f.ok(staying, "gesture.begin", onTarget("track:trk_2", "gain"));
    g.f.ok(staying, "gesture.update", withValue(-1'000, "track:trk_2", "gain"));

    g.f.transport.disconnect(closing);
    CHECK(g.port.count("end ") == 0);  // the command thread ends them, on its next pump
    g.f.server.pump();

    CHECK(g.port.count("end track:trk_1/gain") == 1);
    CHECK(g.port.count("end track:trk_1/pan") == 1);
    CHECK(g.port.count("end track:trk_2") == 0);
    CHECK(g.revisions() == before + 1);
    CHECK(g.f.head().document.track("trk_1")->gain.milliDb == -7'000);
    const std::vector<Value> endedEvents = eventsOfType(g.f, watcher, "gesture.ended");
    REQUIRE(endedEvents.size() == 2);
    for (const Value& event : endedEvents) {
        CHECK(at(event, "reason").asString() == "disconnected");
        CHECK(at(at(event, "target"), "ref").asString() == "track:trk_1");
    }
    // The other connection still holds its gesture.
    g.f.ok(staying, "gesture.hold", onTarget("track:trk_2", "gain"));
    const Value ended = g.f.ok(staying, "gesture.end", onTarget("track:trk_2", "gain"));
    CHECK(at(ended, "value").asNumber() == -1'000);
}

TEST_CASE("update is not cached and runs twice; end is cached and runs once", "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    g.f.ok(c, "gesture.begin", onTarget());

    const std::string update = g.f.request("req_update", "gesture.update", withValue(-1'200));
    g.f.transport.deliver(c, update);
    g.f.server.pump();
    g.f.transport.deliver(c, update);
    g.f.server.pump();
    CHECK(g.port.updates == std::vector<double>{-1'200, -1'200});

    const std::string hold = g.f.request("req_hold", "gesture.hold", onTarget());
    g.advance(800);
    g.f.transport.deliver(c, hold);
    g.f.server.pump();
    g.advance(800);
    g.f.transport.deliver(c, hold);  // the repeat renews too, so the lease is alive
    g.f.server.pump();
    g.advance(800);
    g.f.server.pump();
    CHECK(g.port.count("end ") == 0);

    const std::string end = g.f.request("req_end", "gesture.end", onTarget());
    g.f.transport.deliver(c, end);
    g.f.server.pump();
    g.f.transport.deliver(c, end);
    g.f.server.pump();
    CHECK(g.port.count("end ") == 1);
    const auto sent = g.f.transport.sent(c);
    REQUIRE(sent.size() >= 2);
    CHECK(sent[sent.size() - 1] == sent[sent.size() - 2]);
    CHECK(at(json::parse(sent.back()), "ok").asBool());
}

TEST_CASE("a stale expectedRevision runs nothing", "[protocol][gesture]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    int id = 0;
    for (const std::string& method : kGestureMethods) {
        INFO(method);
        const Value params = method == "gesture.update" ? withValue(-1'000) : onTarget();
        g.f.transport.deliver(c, jcs::canonicalize(Value(Object{{"requestId", Value("stale_" + std::to_string(++id))},
                                                                {"sessionId", Value(g.f.server.sessionId())},
                                                                {"method", Value(method)},
                                                                {"params", params},
                                                                {"expectedRevision", Value("rev_not_the_head")}})));
        g.f.server.pump();
        const auto sent = g.f.transport.sent(c);
        REQUIRE_FALSE(sent.empty());
        CHECK(errorCode(json::parse(sent.back())) == "revision_mismatch");
    }
    CHECK(g.port.calls.empty());
}

TEST_CASE("without a port the five methods are not_supported", "[protocol][gesture]") {
    GestureFixture g(false);
    const ConnectionId c = g.f.authed();
    for (const std::string& method : kGestureMethods) {
        INFO(method);
        const Value params = method == "gesture.update" ? withValue(-1'000) : onTarget();
        CHECK(errorCode(g.f.call(c, method, params)) == "not_supported");
    }
}

TEST_CASE("engine.capabilities lists the five methods and features.gestures", "[protocol][gesture]") {
    for (const bool withPort : {false, true}) {
        INFO("with a port: " << withPort);
        GestureFixture g(withPort);
        const Value capabilities = g.f.ok(g.f.authed(), "engine.capabilities");
        const auto& methods = at(capabilities, "methods").asArray();
        for (const std::string& name : kGestureMethods) {
            INFO(name);
            CHECK(std::any_of(methods.begin(), methods.end(), [&](const Value& m) { return m.asString() == name; }));
        }
        CHECK(at(at(capabilities, "features"), "gestures").asBool() == withPort);
    }
}

// ---- m5b-engine-master: the master gain target {ref: master:master, param: gain}

TEST_CASE("the master target takes gain only; pan, mute and another id are invalid_params", "[protocol][gesture][master]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    for (const std::string& method : kGestureMethods) {
        for (const Value& params : {onTarget("master:master", "pan"), onTarget("master:master", "mute"),
                                    onTarget("master:other", "gain"), onTarget("master:", "gain"),
                                    onTarget("locators:locators", "gain")}) {
            INFO(method << " " << canonical(params));
            CHECK(errorCode(g.f.call(c, method, params)) == "invalid_params");
        }
    }
    CHECK(g.port.calls.empty());
    const Value begun = g.f.ok(c, "gesture.begin", onTarget("master:master", "gain"));
    CHECK(canonical(at(begun, "target")) == canonical(target("master:master", "gain")));
    CHECK(at(begun, "leaseMs").asNumber() == 1'000);
    CHECK(g.port.calls == std::vector<std::string>{"begin master:master/gain"});
}

TEST_CASE("a master gesture with no entity starts at 0, never not_found, and its end commits one master.set_gain",
          "[protocol][gesture][master]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    const ConnectionId watcher = g.f.authed(true);
    const std::size_t before = g.revisions();
    REQUIRE(g.f.head().document.master() == nullptr);

    const Value begun = g.f.ok(c, "gesture.begin", onTarget("master:master", "gain"));
    CHECK(at(begun, "startValue").asNumber() == 0.0);
    g.f.ok(c, "gesture.update", withValue(-2'000, "master:master", "gain"));
    g.f.ok(c, "gesture.update", withValue(-6'000, "master:master", "gain"));
    CHECK(g.revisions() == before);
    const Value ended = g.f.ok(c, "gesture.end", onTarget("master:master", "gain"));
    CHECK(g.revisions() == before + 1);
    CHECK(at(ended, "startValue").asNumber() == 0.0);
    CHECK(at(ended, "value").asNumber() == -6'000);
    CHECK(canonical(at(at(ended, "revision"), "diff")) == canonical(Value(Array{Value("master:master")})));
    REQUIRE(g.f.head().document.master() != nullptr);
    CHECK(g.f.head().document.master()->gain.milliDb == -6'000);

    const std::vector<Value> changed = eventsOfType(g.f, watcher, "session.changed");
    REQUIRE(changed.size() == 1);
    CHECK(at(at(changed[0], "changedIds").asArray()[0], "ref").asString() == "master:master");
    const std::vector<Value> endedEvents = eventsOfType(g.f, watcher, "gesture.ended");
    REQUIRE(endedEvents.size() == 1);
    CHECK(at(endedEvents[0], "reason").asString() == "ended");
    CHECK(canonical(at(endedEvents[0], "target")) == canonical(target("master:master", "gain")));
    CHECK(at(endedEvents[0], "committed").asString() == g.f.head().envelope.id);

    // The next gesture starts from the committed value; back to 0 removes the entity.
    CHECK(at(g.f.ok(c, "gesture.begin", onTarget("master:master", "gain")), "startValue").asNumber() == -6'000);
    const Value back = g.f.ok(c, "gesture.end", withValue(0, "master:master", "gain"));
    CHECK(at(back, "startValue").asNumber() == -6'000);
    CHECK(g.f.head().document.master() == nullptr);
}

TEST_CASE("a master gesture that never moved ends with revision null", "[protocol][gesture][master]") {
    GestureFixture g;
    const ConnectionId c = g.f.authed();
    const std::size_t before = g.revisions();
    g.f.ok(c, "gesture.begin", onTarget("master:master", "gain"));
    const Value ended = g.f.ok(c, "gesture.end", onTarget("master:master", "gain"));
    CHECK(at(ended, "revision").kind() == Value::Kind::null);
    CHECK(at(ended, "value").asNumber() == 0.0);
    CHECK(g.revisions() == before);
}

TEST_CASE("the master target follows a track fader's lease rules", "[protocol][gesture][master][lease]") {
    GestureFixture g;
    const ConnectionId owner = g.f.authed();
    const ConnectionId other = g.f.authed();
    const ConnectionId watcher = g.f.authed(true);

    // gesture_held for another connection, gesture_open for a second begin.
    g.f.ok(owner, "gesture.begin", onTarget("master:master", "gain"));
    CHECK(errorCode(g.f.call(owner, "gesture.begin", onTarget("master:master", "gain"))) == "gesture_open");
    for (const std::string& method : kGestureMethods) {
        INFO(method);
        const Value params =
            method == "gesture.update" ? withValue(-1'000, "master:master", "gain") : onTarget("master:master", "gain");
        CHECK(errorCode(g.f.call(other, method, params)) == "gesture_held");
    }
    // A track's gain is another target, free for the other connection.
    g.f.ok(other, "gesture.begin", onTarget("track:trk_1", "gain"));
    g.f.ok(other, "gesture.cancel", onTarget("track:trk_1", "gain"));

    // Lease expiry commits the last value.
    g.f.ok(owner, "gesture.update", withValue(-3'000, "master:master", "gain"));
    g.advance(1'001);
    g.f.server.pump();
    CHECK(g.port.count("end master:master/gain") == 1);
    CHECK(g.f.head().document.master()->gain.milliDb == -3'000);
    std::vector<Value> endedEvents = eventsOfType(g.f, watcher, "gesture.ended");
    REQUIRE(endedEvents.size() == 2);  // the track's cancel, then the master's expiry
    CHECK(at(endedEvents[1], "reason").asString() == "lease_expired");
    CHECK(at(at(endedEvents[1], "target"), "ref").asString() == "master:master");
    CHECK(errorCode(g.f.call(owner, "gesture.hold", onTarget("master:master", "gain"))) == "no_gesture");

    // A close ends it as well.
    g.f.ok(other, "gesture.begin", onTarget("master:master", "gain"));
    g.f.ok(other, "gesture.update", withValue(-4'500, "master:master", "gain"));
    g.f.transport.disconnect(other);
    g.f.server.pump();
    CHECK(g.port.count("end master:master/gain") == 2);
    CHECK(g.f.head().document.master()->gain.milliDb == -4'500);
    endedEvents = eventsOfType(g.f, watcher, "gesture.ended");
    REQUIRE(endedEvents.size() == 3);
    CHECK(at(endedEvents[2], "reason").asString() == "disconnected");
    CHECK(at(at(endedEvents[2], "target"), "ref").asString() == "master:master");

    // Cancel commits nothing.
    const std::size_t before = g.revisions();
    g.f.ok(owner, "gesture.begin", onTarget("master:master", "gain"));
    g.f.ok(owner, "gesture.update", withValue(-9'000, "master:master", "gain"));
    g.f.ok(owner, "gesture.cancel", onTarget("master:master", "gain"));
    CHECK(g.revisions() == before);
    CHECK(g.f.head().document.master()->gain.milliDb == -4'500);
}

// ---- m5b-engine-buses-sends: bus gain and send level targets ----------------

namespace {

// The gesture fixture with a bus b1 and a send s1 from trk_1 to it.
void addBusAndSend(GestureFixture& g) {
    g.f.commit(g.f.authed(), Array{Value(Object{{"op", Value("bus.add")}, {"busId", Value("b1")}, {"name", Value("B")}}),
                                   Value(Object{{"op", Value("send.add")},
                                                {"sendId", Value("s1")},
                                                {"trackId", Value("trk_1")},
                                                {"busId", Value("b1")}})});
}

}  // namespace

TEST_CASE("bus:<id> takes gain and send:<id> takes level; any other param is invalid_params",
          "[protocol][gesture][buses]") {
    GestureFixture g;
    addBusAndSend(g);
    const ConnectionId c = g.f.authed();
    for (const std::string& method : kGestureMethods) {
        for (const Value& params : {onTarget("bus:b1", "pan"), onTarget("bus:b1", "mute"), onTarget("bus:b1", "level"),
                                    onTarget("send:s1", "gain"), onTarget("send:s1", "enabled"),
                                    onTarget("bus:", "gain"), onTarget("send:bad id", "level")}) {
            INFO(method << " " << canonical(params));
            CHECK(errorCode(g.f.call(c, method, params)) == "invalid_params");
        }
    }
    CHECK(g.port.calls.empty());
    const Value bus = g.f.ok(c, "gesture.begin", onTarget("bus:b1", "gain"));
    CHECK(canonical(at(bus, "target")) == canonical(target("bus:b1", "gain")));
    CHECK(at(bus, "startValue").asNumber() == 0.0);
    const Value send = g.f.ok(c, "gesture.begin", onTarget("send:s1", "level"));
    CHECK(canonical(at(send, "target")) == canonical(target("send:s1", "level")));
    CHECK(g.port.calls == std::vector<std::string>{"begin bus:b1/gain", "begin send:s1/level"});
    // An unknown bus or send is the port's not_found.
    CHECK(errorCode(g.f.call(c, "gesture.begin", onTarget("bus:b9", "gain"))) == "not_found");
    CHECK(errorCode(g.f.call(c, "gesture.begin", onTarget("send:s9", "level"))) == "not_found");
}

TEST_CASE("a bus gesture commits one bus.set_gain and a send gesture one send.set_level", "[protocol][gesture][buses]") {
    GestureFixture g;
    addBusAndSend(g);
    const ConnectionId c = g.f.authed();
    const std::size_t before = g.revisions();
    g.f.ok(c, "gesture.begin", onTarget("bus:b1", "gain"));
    g.f.ok(c, "gesture.update", withValue(-6'000, "bus:b1", "gain"));
    const Value ended = g.f.ok(c, "gesture.end", onTarget("bus:b1", "gain"));
    CHECK(g.revisions() == before + 1);
    CHECK(at(ended, "value").asNumber() == -6'000);
    CHECK(canonical(at(at(ended, "revision"), "diff")) == canonical(Value(Array{Value("bus:b1")})));
    CHECK(g.f.head().document.bus("b1")->gain.milliDb == -6'000);

    g.f.ok(c, "gesture.begin", onTarget("send:s1", "level"));
    const Value sent = g.f.ok(c, "gesture.end", withValue(-12'000, "send:s1", "level"));
    CHECK(g.revisions() == before + 2);
    CHECK(canonical(at(at(sent, "revision"), "diff")) == canonical(Value(Array{Value("send:s1")})));
    CHECK(g.f.head().document.send("s1")->level.milliDb == -12'000);
    CHECK(at(g.f.ok(c, "gesture.begin", onTarget("send:s1", "level")), "startValue").asNumber() == -12'000);
}

TEST_CASE("bus and send targets follow a track fader's lease rules", "[protocol][gesture][buses][lease]") {
    GestureFixture g;
    addBusAndSend(g);
    const ConnectionId owner = g.f.authed();
    const ConnectionId other = g.f.authed();
    const ConnectionId watcher = g.f.authed(true);
    g.f.ok(owner, "gesture.begin", onTarget("bus:b1", "gain"));
    CHECK(errorCode(g.f.call(other, "gesture.begin", onTarget("bus:b1", "gain"))) == "gesture_held");
    g.f.ok(owner, "gesture.update", withValue(-3'000, "bus:b1", "gain"));
    g.advance(1'001);
    g.f.server.pump();
    CHECK(g.port.count("end bus:b1/gain") == 1);
    CHECK(g.f.head().document.bus("b1")->gain.milliDb == -3'000);
    std::vector<Value> endedEvents = eventsOfType(g.f, watcher, "gesture.ended");
    REQUIRE(endedEvents.size() == 1);
    CHECK(at(endedEvents[0], "reason").asString() == "lease_expired");
    CHECK(at(at(endedEvents[0], "target"), "ref").asString() == "bus:b1");

    g.f.ok(other, "gesture.begin", onTarget("send:s1", "level"));
    g.f.ok(other, "gesture.update", withValue(-9'000, "send:s1", "level"));
    g.f.transport.disconnect(other);
    g.f.server.pump();
    CHECK(g.port.count("end send:s1/level") == 1);
    CHECK(g.f.head().document.send("s1")->level.milliDb == -9'000);
    endedEvents = eventsOfType(g.f, watcher, "gesture.ended");
    REQUIRE(endedEvents.size() == 2);
    CHECK(at(endedEvents[1], "reason").asString() == "disconnected");
    CHECK(at(at(endedEvents[1], "target"), "param").asString() == "level");
}
