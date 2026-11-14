// Recording through the protocol (m5b-engine-record, Protocol v0 items 22 and 27):
// engine.select_device's inputId, record.arm, transport.record and
// record.recover_take through the RecordPort, record.changed, pendingTakes in
// the auth reply and session.sync, the capabilities and the published revision
// of a commit the engine host made itself. The server side only, on a fake port;
// the engine host's port is tested in apps/engine/tests.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "siann/command/command.hpp"
#include "siann/protocol/record_port.hpp"
#include "siann/protocol/transport_port.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::RecordState;
using protocol::RecordTakeState;
using protocol::ServerOptions;
using protocol::TransportPortError;
using protocol::TransportState;

namespace {

// A transport and record port in one, as the engine host is. Refusals and the
// record state are set by the test; recording commits through `onCommit`.
class FakeRecorder final : public protocol::TransportPort, public protocol::RecordPort {
public:
    FakeRecorder(session::Session& served, std::vector<protocol::PendingTake> listed)
        : session(&served), pending(std::move(listed)) {}

    TransportState play() override { return state(); }
    TransportState stop() override {
        if (recordState_.recording) {
            endRecording();
        }
        playing = false;
        return state();
    }
    TransportState locate(std::int64_t) override { return state(); }
    TransportState setCycle(bool) override { return state(); }
    TransportState setClick(bool, std::optional<std::int32_t>) override { return state(); }
    protocol::EngineStatus status() const override {
        protocol::EngineStatus out;
        out.device = protocol::DeviceInfo{"fake", 48'000, 256, 256, 256};
        out.playing = playing;
        out.recording = recordState_.recording;
        out.armed = recordState_.armed;
        return out;
    }
    std::vector<protocol::DeviceDescription> devices() const override {
        protocol::DeviceDescription fake{"fake", "fake", "fake", false, true};
        fake.inputChannels = 2;
        fake.outputChannels = 2;
        protocol::DeviceDescription unknown{"Windows Audio/Speakers", "Windows Audio", "Speakers", true, false};
        return {fake, unknown};
    }
    protocol::DeviceInfo selectDevice(const std::string& id) override { return selectDeviceWithInput(id, std::nullopt); }
    protocol::DeviceInfo selectDeviceWithInput(const std::string& id, const std::optional<std::string>& inputId) override {
        selections.emplace_back(id, inputId);
        if (inputId && *inputId != "fake") {
            throw TransportPortError("not_found", "no input " + *inputId);
        }
        protocol::DeviceInfo device{id, 48'000, 256, 256, 256};
        if (inputId) {
            device.input = protocol::InputInfo{*inputId, 2, 256};
        }
        return device;
    }

    RecordState arm(const std::string& trackId, bool armed) override {
        ++calls;
        refuseIfAsked();
        auto& list = recordState_.armed;
        list.erase(std::remove(list.begin(), list.end(), trackId), list.end());
        if (armed) {
            list.push_back(trackId);
            std::sort(list.begin(), list.end());
        }
        return recordState_;
    }
    TransportState record(bool enabled) override {
        ++calls;
        refuseIfAsked();
        if (enabled && !recordState_.recording) {
            recordState_.recording = true;
            recordState_.takes.clear();
            for (const std::string& trackId : recordState_.armed) {
                recordState_.takes.push_back(RecordTakeState{"take_" + trackId, trackId, std::nullopt, 0, {}, 0});
            }
            playing = true;
        } else if (!enabled && recordState_.recording) {
            endRecording();
        }
        return state();
    }
    RecordState recordState() const override { return recordState_; }
    std::vector<protocol::PendingTake> pendingTakes() const override { return pending; }
    protocol::RecoverResult recoverTake(const std::string& takeId, bool accept,
                                        const std::optional<std::string>& trackId, std::string actor,
                                        std::string time) override {
        ++calls;
        recoverTrackIds.push_back(trackId);
        refuseIfAsked();
        const auto found = std::find_if(pending.begin(), pending.end(),
                                        [&](const protocol::PendingTake& one) { return one.takeId == takeId; });
        if (accept) {
            if (found != pending.end()) {
                committed = &session->commit({command::Command::fromJson(json::parse(
                                                 R"({"op":"track.add","trackId":"trk_rec","name":"Rec","channels":1})"))},
                                             std::move(actor), std::move(time));
                pending.erase(found);
            }
            return {committed, false};
        }
        if (found != pending.end()) {
            pending.erase(found);
        }
        return {nullptr, true};
    }

    // Ends the recording as the host does: a commit, then the final state.
    void endRecording() {
        const std::string trackId = "trk_take" + std::to_string(++recordings);
        session->commit({command::Command::fromJson(json::parse(R"({"op":"track.add","trackId":")" + trackId +
                                                                R"(","name":"Take","channels":1})"))},
                        "siann-engine", "t");
        recordState_.recording = false;
        for (RecordTakeState& take : recordState_.takes) {
            take.endedBy = endedBy;
            take.overflows = overflows;
        }
    }

    session::Session* session;
    RecordState recordState_;
    std::vector<protocol::PendingTake> pending;
    const command::Revision* committed = nullptr;
    std::vector<std::pair<std::string, std::optional<std::string>>> selections;
    std::optional<std::string> refusal;
    std::string endedBy = "stop";
    std::uint64_t overflows = 0;
    bool playing = false;
    int calls = 0;
    std::vector<std::optional<std::string>> recoverTrackIds;  // each recoverTake's trackId
    int recordings = 0;

private:
    TransportState state() const {
        TransportState out{playing, 0, false, {}};
        out.recording = recordState_.recording;
        out.armed = recordState_.armed;
        return out;
    }
    void refuseIfAsked() const {
        if (refusal) {
            throw TransportPortError(*refusal, "the port refused");
        }
    }
};

struct RecordFixture : SessionHolder {
    FakeRecorder port;
    Harness harness;

    explicit RecordFixture(bool withRecordPort = true, std::vector<protocol::PendingTake> pending = {})
        : port(session, std::move(pending)), harness(session, options(withRecordPort)) {}

    ServerOptions options(bool withRecordPort) {
        ServerOptions out = manualOptions();
        out.transportPort = &port;
        if (withRecordPort) {
            out.recordPort = &port;
        }
        return out;
    }
};

Value armParams(const std::string& trackId, bool armed) {
    return Value(Object{{"trackId", Value(trackId)}, {"armed", Value(armed)}});
}

Value enabled(bool on) {
    return Value(Object{{"enabled", Value(on)}});
}

std::vector<Value> eventsOf(const Harness& f, ConnectionId connection, const std::string& type) {
    std::vector<Value> out;
    for (Value& event : f.events(connection)) {
        if (at(event, "type").asString() == type) {
            out.push_back(std::move(event));
        }
    }
    return out;
}

std::vector<std::string> strings(const Value& array) {
    std::vector<std::string> out;
    for (const Value& v : array.asArray()) {
        out.push_back(v.asString());
    }
    return out;
}

bool lists(const Value& array, const std::string& name) {
    const auto& items = array.asArray();
    return std::any_of(items.begin(), items.end(), [&](const Value& v) { return v.asString() == name; });
}

}  // namespace

TEST_CASE("engine.select_device passes inputId and returns the device with its input",
          "[protocol][record][devices]") {
    RecordFixture f;
    const ConnectionId c = f.harness.authed();

    const Value device = f.harness.ok(c, "engine.select_device",
                                      Value(Object{{"id", Value("fake")}, {"inputId", Value("fake")}}));
    const Value& input = at(device, "input");
    CHECK(at(input, "id").asString() == "fake");
    CHECK(at(input, "channels").asNumber() == 2);
    CHECK(at(input, "latencyFrames").asNumber() == 256);
    REQUIRE(f.port.selections.size() == 1);
    CHECK(f.port.selections[0].second == std::optional<std::string>("fake"));

    const Value plain = f.harness.ok(c, "engine.select_device", Value(Object{{"id", Value("fake")}}));
    CHECK(at(plain, "input").kind() == Value::Kind::null);
    CHECK_FALSE(f.port.selections.back().second.has_value());

    CHECK(errorCode(f.harness.call(c, "engine.select_device",
                                   Value(Object{{"id", Value("fake")}, {"inputId", Value(2)}}))) == "invalid_params");
    CHECK(errorCode(f.harness.call(c, "engine.select_device",
                                   Value(Object{{"id", Value("fake")}, {"inputId", Value("nope")}}))) == "not_found");
    CHECK(f.port.selections.size() == 3);  // the non-string inputId reached nothing

    const Value listed = f.harness.ok(c, "engine.devices");
    const auto& devices = at(listed, "devices").asArray();
    REQUIRE(devices.size() == 2);
    CHECK(at(devices[0], "inputChannels").asNumber() == 2);
    CHECK(at(devices[0], "outputChannels").asNumber() == 2);
    CHECK(at(devices[1], "inputChannels").kind() == Value::Kind::null);
    CHECK(at(devices[1], "outputChannels").kind() == Value::Kind::null);
}

TEST_CASE("record.arm validates its params and answers the record state", "[protocol][record][arm]") {
    RecordFixture f;
    const ConnectionId c = f.harness.authed();
    for (const Value& params : {Value(Object{}), Value(Object{{"trackId", Value("trk_1")}}),
                                Value(Object{{"armed", Value(true)}}),
                                Value(Object{{"trackId", Value(1)}, {"armed", Value(true)}}),
                                Value(Object{{"trackId", Value("trk_1")}, {"armed", Value("yes")}})}) {
        INFO(canonical(params));
        CHECK(errorCode(f.harness.call(c, "record.arm", params)) == "invalid_params");
    }
    CHECK(f.port.calls == 0);

    const Value state = f.harness.ok(c, "record.arm", armParams("trk_1", true));
    CHECK_FALSE(at(state, "recording").asBool());
    CHECK(strings(at(state, "armed")) == std::vector<std::string>{"trk_1"});
    CHECK(at(state, "takes").asArray().empty());

    for (const std::string& code : {std::string("no_device"), std::string("no_input"), std::string("not_found"),
                                    std::string("invalid_state")}) {
        f.port.refusal = code;
        CHECK(errorCode(f.harness.call(c, "record.arm", armParams("trk_2", true))) == code);
    }
}

TEST_CASE("record methods honour expectedRevision and the idempotency cache", "[protocol][record]") {
    RecordFixture f;
    const ConnectionId c = f.harness.authed();
    const std::string request = f.harness.request("req_arm", "record.arm", armParams("trk_1", true));
    f.harness.transport.deliver(c, request);
    f.harness.server.pump();
    f.harness.transport.deliver(c, request);
    f.harness.server.pump();
    const auto sent = f.harness.transport.sent(c);
    REQUIRE(sent.size() == 3);  // the auth reply and two identical responses
    CHECK(sent[1] == sent[2]);
    CHECK(f.port.calls == 1);

    const std::string stale = jcs::canonicalize(Value(Object{{"requestId", Value("req_stale")},
                                                             {"sessionId", Value(f.harness.server.sessionId())},
                                                             {"method", Value("transport.record")},
                                                             {"params", enabled(true)},
                                                             {"expectedRevision", Value("r999")}}));
    f.harness.transport.deliver(c, stale);
    f.harness.server.pump();
    CHECK(errorCode(json::parse(f.harness.transport.sent(c).back())) == "revision_mismatch");
    CHECK(f.port.calls == 1);
}

TEST_CASE("transport.record validates enabled and answers the transport state", "[protocol][record]") {
    RecordFixture f;
    const ConnectionId c = f.harness.authed();
    CHECK(errorCode(f.harness.call(c, "transport.record")) == "invalid_params");
    CHECK(errorCode(f.harness.call(c, "transport.record", Value(Object{{"enabled", Value(1)}}))) == "invalid_params");
    f.port.refusal = "nothing_armed";
    CHECK(errorCode(f.harness.call(c, "transport.record", enabled(true))) == "nothing_armed");
    f.port.refusal = "no_input";
    CHECK(errorCode(f.harness.call(c, "transport.record", enabled(true))) == "no_input");
    f.port.refusal.reset();

    f.harness.ok(c, "record.arm", armParams("trk_1", true));
    const Value started = f.harness.ok(c, "transport.record", enabled(true));
    CHECK(at(started, "recording").asBool());
    CHECK(at(started, "playing").asBool());
    CHECK(strings(at(started, "armed")) == std::vector<std::string>{"trk_1"});
    const Value status = f.harness.ok(c, "engine.status");
    CHECK(at(status, "recording").asBool());
    CHECK(strings(at(status, "armed")) == std::vector<std::string>{"trk_1"});
}

TEST_CASE("without a record port the record methods are not_supported", "[protocol][record]") {
    RecordFixture f(false);
    const ConnectionId c = f.harness.authed();
    CHECK(errorCode(f.harness.call(c, "record.arm", armParams("trk_1", true))) == "not_supported");
    CHECK(errorCode(f.harness.call(c, "transport.record", enabled(true))) == "not_supported");
    CHECK(errorCode(f.harness.call(
              c, "record.recover_take", Value(Object{{"takeId", Value("take_1")}, {"accept", Value(true)}}))) ==
          "not_supported");
    const Value capabilities = f.harness.ok(c, "engine.capabilities");
    CHECK_FALSE(at(at(capabilities, "features"), "recording").asBool());
}

TEST_CASE("record.changed reaches every subscribed connection whenever the record state changes",
          "[protocol][record][events]") {
    RecordFixture f;
    const ConnectionId a = f.harness.authed(true);
    const ConnectionId b = f.harness.authed(true);

    f.harness.ok(a, "record.arm", armParams("trk_1", true));
    for (const ConnectionId c : {a, b}) {
        const auto events = eventsOf(f.harness, c, "record.changed");
        REQUIRE(events.size() == 1);
        CHECK(strings(at(events[0], "armed")) == std::vector<std::string>{"trk_1"});
        CHECK_FALSE(at(events[0], "recording").asBool());
    }
    f.harness.ok(a, "record.arm", armParams("trk_1", true));  // unchanged: no event
    CHECK(eventsOf(f.harness, b, "record.changed").size() == 1);

    f.harness.ok(a, "transport.record", enabled(true));
    CHECK(eventsOf(f.harness, b, "record.changed").size() == 2);

    // The host's tick moves the take on; the next pump publishes it.
    f.port.recordState_.takes[0].startFrame = 96'000;
    f.harness.server.pump();
    f.port.recordState_.takes[0].durableFrames = 48'000;
    f.harness.server.pump();
    f.harness.server.pump();  // nothing changed: no event
    auto events = eventsOf(f.harness, b, "record.changed");
    REQUIRE(events.size() == 4);
    const Value& take = at(events[3], "takes").asArray().at(0);
    CHECK(at(take, "takeId").asString() == "take_trk_1");
    CHECK(at(take, "trackId").asString() == "trk_1");
    CHECK(at(take, "startFrame").asString() == "96000");
    CHECK(at(take, "durableFrames").asString() == "48000");
    CHECK(take.find("endedBy") == nullptr);

    // An early end the host's tick found: the end, with endedBy and overflows,
    // and the commit it made as session.changed.
    const std::string headBefore = f.session.history().head().envelope.id;
    f.port.endedBy = "overflow";
    f.port.overflows = 3;
    f.port.endRecording();
    f.harness.server.pump();
    events = eventsOf(f.harness, b, "record.changed");
    REQUIRE(events.size() == 5);
    CHECK_FALSE(at(events[4], "recording").asBool());
    const Value& ended = at(events[4], "takes").asArray().at(0);
    CHECK(at(ended, "endedBy").asString() == "overflow");
    CHECK(at(ended, "overflows").asString() == "3");
    const auto changed = eventsOf(f.harness, b, "session.changed");
    REQUIRE_FALSE(changed.empty());
    CHECK(at(changed.back(), "revision").asString() == f.session.history().head().envelope.id);
    CHECK(at(changed.back(), "revision").asString() != headBefore);
}

TEST_CASE("transport.record off and transport.stop publish the commit they made", "[protocol][record][events]") {
    RecordFixture f;
    const ConnectionId c = f.harness.authed(true);
    f.harness.ok(c, "record.arm", armParams("trk_1", true));
    f.harness.ok(c, "transport.record", enabled(true));
    const std::size_t before = eventsOf(f.harness, c, "session.changed").size();
    const Value ended = f.harness.ok(c, "transport.record", enabled(false));
    CHECK_FALSE(at(ended, "recording").asBool());
    auto changed = eventsOf(f.harness, c, "session.changed");
    REQUIRE(changed.size() == before + 1);
    CHECK(at(changed.back(), "revision").asString() == f.session.history().head().envelope.id);

    f.harness.ok(c, "transport.record", enabled(true));
    f.harness.ok(c, "transport.stop");
    changed = eventsOf(f.harness, c, "session.changed");
    REQUIRE(changed.size() == before + 2);
    CHECK(at(changed.back(), "revision").asString() == f.session.history().head().envelope.id);
}

TEST_CASE("the auth reply and session.sync carry the pending takes", "[protocol][record][sync]") {
    protocol::PendingTake take;
    take.takeId = "take_crash";
    take.trackId = "trk_1";
    take.channels = 1;
    take.sampleRate = 48'000;
    take.startFrame = 4'800;
    take.endedBy = "device";
    take.overflows = 0;
    RecordFixture f(true, {take});  // a take a crash left: listed from the start

    const ConnectionId c = f.harness.authed(true);
    const Value reply = json::parse(f.harness.transport.sent(c).at(0));
    const auto& listed = at(reply, "pendingTakes").asArray();
    REQUIRE(listed.size() == 1);
    CHECK(at(listed[0], "takeId").asString() == "take_crash");
    CHECK(at(listed[0], "trackId").asString() == "trk_1");
    CHECK(at(listed[0], "channels").asNumber() == 1);
    CHECK(at(listed[0], "sampleRate").asNumber() == 48'000);
    CHECK(at(listed[0], "startFrame").asString() == "4800");
    CHECK(at(listed[0], "endedBy").asString() == "device");

    const Value sync = f.harness.ok(c, "session.sync");
    REQUIRE(at(sync, "pendingTakes").asArray().size() == 1);
    CHECK(at(at(sync, "pendingTakes").asArray()[0], "takeId").asString() == "take_crash");

    const Value accepted = f.harness.ok(
        c, "record.recover_take", Value(Object{{"takeId", Value("take_crash")}, {"accept", Value(true)}}));
    CHECK(at(at(accepted, "revision"), "id").asString() == f.session.history().head().envelope.id);
    CHECK(at(f.harness.ok(c, "session.sync"), "pendingTakes").asArray().empty());
    const ConnectionId later = f.harness.authed(false);
    CHECK(at(json::parse(f.harness.transport.sent(later).at(0)), "pendingTakes").asArray().empty());
}

TEST_CASE("record.recover_take commits or trashes, and a repeat answers the same", "[protocol][record][recover]") {
    RecordFixture f;
    protocol::PendingTake keep;
    keep.takeId = "take_keep";
    keep.trackId = "trk_1";
    protocol::PendingTake drop = keep;
    drop.takeId = "take_drop";
    f.port.pending = {keep, drop};
    const ConnectionId c = f.harness.authed(true);

    CHECK(errorCode(f.harness.call(c, "record.recover_take", Value(Object{{"takeId", Value("take_keep")}}))) ==
          "invalid_params");
    CHECK(errorCode(f.harness.call(c, "record.recover_take", Value(Object{{"accept", Value(true)}}))) ==
          "invalid_params");

    const Value first = f.harness.ok(
        c, "record.recover_take", Value(Object{{"takeId", Value("take_keep")}, {"accept", Value(true)}}));
    const std::size_t changes = eventsOf(f.harness, c, "session.changed").size();
    CHECK(changes == 1);
    const Value again = f.harness.ok(
        c, "record.recover_take", Value(Object{{"takeId", Value("take_keep")}, {"accept", Value(true)}}));
    CHECK(canonical(again) == canonical(first));
    CHECK(eventsOf(f.harness, c, "session.changed").size() == changes);  // nothing new committed

    const Value trashed = f.harness.ok(
        c, "record.recover_take", Value(Object{{"takeId", Value("take_drop")}, {"accept", Value(false)}}));
    CHECK(at(trashed, "takeId").asString() == "take_drop");
    CHECK(at(trashed, "trashed").asBool());
    const Value trashedAgain = f.harness.ok(
        c, "record.recover_take", Value(Object{{"takeId", Value("take_drop")}, {"accept", Value(false)}}));
    CHECK(canonical(trashedAgain) == canonical(trashed));

    f.port.refusal = "take_not_found";
    CHECK(errorCode(f.harness.call(
              c, "record.recover_take", Value(Object{{"takeId", Value("take_x")}, {"accept", Value(true)}}))) ==
          "take_not_found");
}

TEST_CASE("engine.capabilities lists the record methods, track.set_input and features.recording",
          "[protocol][record][capabilities]") {
    RecordFixture f;
    const Value capabilities = f.harness.ok(f.harness.authed(), "engine.capabilities");
    for (const char* name : {"record.arm", "transport.record", "record.recover_take", "engine.select_device"}) {
        INFO(name);
        CHECK(lists(at(capabilities, "methods"), name));
    }
    CHECK(lists(at(capabilities, "commands"), "track.set_input"));
    CHECK(at(at(capabilities, "features"), "recording").asBool());
}

// m5b-engine-record: an orphan take (its track removed) is recovered onto the
// track the client names; trackId is passed through, and is optional.
TEST_CASE("record.recover_take passes an optional trackId to the record port", "[protocol][record][recover]") {
    RecordFixture f;
    protocol::PendingTake one;
    one.takeId = "take_orphan";
    one.trackId = "trk_gone";
    protocol::PendingTake two = one;
    two.takeId = "take_plain";
    f.port.pending = {one, two};
    const ConnectionId c = f.harness.authed(true);

    CHECK(errorCode(f.harness.call(c, "record.recover_take",
                                   Value(Object{{"takeId", Value("take_orphan")},
                                                {"accept", Value(true)},
                                                {"trackId", Value(42)}}))) == "invalid_params");
    f.harness.ok(c, "record.recover_take",
                 Value(Object{{"takeId", Value("take_orphan")}, {"accept", Value(true)}, {"trackId", Value("trk_1")}}));
    f.harness.ok(c, "record.recover_take",
                 Value(Object{{"takeId", Value("take_plain")}, {"accept", Value(false)}}));
    REQUIRE(f.port.recoverTrackIds.size() == 2);
    CHECK(f.port.recoverTrackIds[0] == std::optional<std::string>("trk_1"));
    CHECK_FALSE(f.port.recoverTrackIds[1].has_value());
}
