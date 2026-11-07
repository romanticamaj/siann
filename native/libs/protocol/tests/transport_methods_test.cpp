// transport.play, transport.stop, transport.locate and engine.status (spec,
// Protocol v0 item 18, m4-engine-device) through the TransportPort: the server
// side only, on a fake port. The engine's real port is tested in
// apps/engine/tests.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "siann/protocol/transport_port.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::EngineStatus;
using protocol::ServerOptions;
using protocol::TransportPort;
using protocol::TransportPortError;
using protocol::TransportState;

namespace {

class FakePort final : public TransportPort {
public:
    TransportState play() override {
        ++calls;
        refuseIfAsked();
        playing = true;
        return state();
    }
    TransportState stop() override {
        ++calls;
        refuseIfAsked();
        playing = false;
        return state();
    }
    TransportState locate(std::int64_t frames) override {
        ++calls;
        refuseIfAsked();
        position = frames;
        return state();
    }
    EngineStatus status() const override { return reported; }

    int calls = 0;
    bool playing = false;
    std::int64_t position = 1'024;
    std::optional<std::string> refusal;
    EngineStatus reported;

private:
    TransportState state() const { return TransportState{playing, position}; }
    void refuseIfAsked() const {
        if (refusal) {
            throw TransportPortError(*refusal, "the port refused");
        }
    }
};

ServerOptions withPort(TransportPort& port) {
    ServerOptions options = manualOptions();
    options.transportPort = &port;
    return options;
}

Value frames(const std::string& text) {
    return Value(Object{{"frames", Value(text)}});
}

std::set<std::string> keysOf(const Value& object) {
    std::set<std::string> keys;
    for (const auto& [key, value] : object.asObject()) {
        (void)value;
        keys.insert(key);
    }
    return keys;
}

}  // namespace

TEST_CASE("transport methods play, stop and locate through the port", "[protocol][transport]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();

    const Value played = f.ok(c, "transport.play");
    CHECK(at(played, "playing").asBool());
    CHECK(at(played, "position").asString() == "1024");

    const Value located = f.ok(c, "transport.locate", frames("96000"));
    CHECK(at(located, "playing").asBool());
    CHECK(at(located, "position").asString() == "96000");
    CHECK(port.position == 96'000);

    const Value stopped = f.ok(c, "transport.stop");
    CHECK_FALSE(at(stopped, "playing").asBool());
    CHECK(at(stopped, "position").asString() == "96000");
    CHECK(port.calls == 3);
}

TEST_CASE("transport.locate takes a decimal string and nothing else", "[protocol][transport]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();

    const std::vector<Value> bad = {
        Value(Object{}),                            // missing
        Value(Object{{"frames", Value(96000)}}),    // a number
        Value(Object{{"frames", Value(nullptr)}}),  // null
        frames(""), frames("-1"), frames("12a"), frames("1.5"),
        frames("9999999999999999999"),  // past what a position holds
    };
    for (const Value& params : bad) {
        INFO(canonical(params));
        CHECK(errorCode(f.call(c, "transport.locate", params)) == "invalid_params");
    }
    CHECK(port.calls == 0);
}

TEST_CASE("a port's refusal is the method's error code", "[protocol][transport]") {
    FakePort port;
    port.refusal = "no_device";
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();

    CHECK(errorCode(f.call(c, "transport.play")) == "no_device");
    CHECK(errorCode(f.call(c, "transport.stop")) == "no_device");
    const Value refused = f.call(c, "transport.locate", frames("0"));
    CHECK(errorCode(refused) == "no_device");
    CHECK(at(at(refused, "error"), "message").asString() == "the port refused");
}

TEST_CASE("engine.status carries the device and the driver's timing, counts as decimal strings",
          "[protocol][transport]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();

    SECTION("with a device") {
        port.reported.device = protocol::DeviceInfo{"fake", 48'000, 256, 256, 128};
        port.reported.playing = true;
        port.reported.xruns = 7;
        port.reported.maxCallbackMicros = 20'000.5;
        port.reported.unmeasuredCallbacks = 3;
        port.reported.underruns = 18'446'744'073'709'551'615U;
        port.reported.srcUnderruns = 5;

        const Value status = f.ok(c, "engine.status");
        CHECK(keysOf(status) == std::set<std::string>{"device", "playing", "xruns", "maxCallbackMicros",
                                                      "unmeasuredCallbacks", "underruns", "srcUnderruns"});
        const Value& device = at(status, "device");
        CHECK(keysOf(device) == std::set<std::string>{"id", "sampleRate", "bufferFrames", "inputLatencyFrames",
                                                      "outputLatencyFrames"});
        CHECK(at(device, "id").asString() == "fake");
        CHECK(at(device, "sampleRate").asNumber() == 48'000);
        CHECK(at(device, "bufferFrames").asNumber() == 256);
        CHECK(at(device, "inputLatencyFrames").asNumber() == 256);
        CHECK(at(device, "outputLatencyFrames").asNumber() == 128);
        CHECK(at(status, "playing").asBool());
        CHECK(at(status, "xruns").asString() == "7");
        CHECK(at(status, "maxCallbackMicros").asNumber() == 20'000.5);
        CHECK(at(status, "unmeasuredCallbacks").asString() == "3");
        CHECK(at(status, "underruns").asString() == "18446744073709551615");
        CHECK(at(status, "srcUnderruns").asString() == "5");
    }
    SECTION("without a device") {
        port.reported.deviceError = protocol::DeviceProblem{"no_device", "no output device"};

        const Value status = f.ok(c, "engine.status");
        CHECK(at(status, "device").kind() == Value::Kind::null);
        CHECK(keysOf(at(status, "deviceError")) == std::set<std::string>{"code", "message"});
        CHECK(at(at(status, "deviceError"), "code").asString() == "no_device");
        CHECK(at(at(status, "deviceError"), "message").asString() == "no output device");
        CHECK_FALSE(at(status, "playing").asBool());
        CHECK(at(status, "xruns").asString() == "0");
    }
}

TEST_CASE("without a port the four methods are not_supported", "[protocol][transport]") {
    Fixture f;
    const ConnectionId c = f.authed();
    CHECK(errorCode(f.call(c, "transport.play")) == "not_supported");
    CHECK(errorCode(f.call(c, "transport.stop")) == "not_supported");
    CHECK(errorCode(f.call(c, "transport.locate", frames("0"))) == "not_supported");
    CHECK(errorCode(f.call(c, "engine.status")) == "not_supported");
}

TEST_CASE("engine.capabilities lists the methods and says whether a port is there", "[protocol][transport]") {
    const auto hasMethod = [](const Value& capabilities, const std::string& name) {
        const auto& methods = at(capabilities, "methods").asArray();
        return std::any_of(methods.begin(), methods.end(), [&](const Value& m) { return m.asString() == name; });
    };
    for (const bool withTransport : {false, true}) {
        INFO("with a port: " << withTransport);
        FakePort port;
        Fixture f(withTransport ? withPort(port) : manualOptions());
        const Value capabilities = f.ok(f.authed(), "engine.capabilities");
        for (const char* name : {"transport.play", "transport.stop", "transport.locate", "engine.status"}) {
            INFO(name);
            CHECK(hasMethod(capabilities, name));
        }
        CHECK(at(at(capabilities, "features"), "transport").asBool() == withTransport);
    }
}

TEST_CASE("a duplicate requestId returns the cached response and runs nothing twice", "[protocol][transport]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();

    const std::string request = f.request("req_play", "transport.play", Value(Object{}));
    f.transport.deliver(c, request);
    f.server.pump();
    f.transport.deliver(c, request);
    f.server.pump();
    CHECK(port.calls == 1);
    const auto sent = f.transport.sent(c);
    REQUIRE(sent.size() >= 2);
    CHECK(sent[sent.size() - 1] == sent[sent.size() - 2]);
}

TEST_CASE("a stale expectedRevision runs nothing", "[protocol][transport]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();

    const std::vector<std::pair<std::string, Value>> methods = {{"transport.play", Value(Object{})},
                                                                {"transport.stop", Value(Object{})},
                                                                {"transport.locate", frames("0")},
                                                                {"engine.status", Value(Object{})}};
    int id = 0;
    for (const auto& [method, params] : methods) {
        INFO(method);
        const std::string requestId = "stale_" + std::to_string(++id);
        f.transport.deliver(c, jcs::canonicalize(Value(Object{{"requestId", Value(requestId)},
                                                              {"sessionId", Value(f.server.sessionId())},
                                                              {"method", Value(method)},
                                                              {"params", params},
                                                              {"expectedRevision", Value("rev_not_the_head")}})));
        f.server.pump();
        const auto sent = f.transport.sent(c);
        REQUIRE_FALSE(sent.empty());
        CHECK(errorCode(json::parse(sent.back())) == "revision_mismatch");
    }
    CHECK(port.calls == 0);
}
