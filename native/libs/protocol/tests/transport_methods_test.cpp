// transport.play, transport.stop, transport.locate and engine.status (spec,
// Protocol v0 item 18, m4-engine-device), engine.devices and
// engine.select_device (item 22, m5-engine-sessions-devices) through the
// TransportPort: the server side only, on a fake port. The engine's real port is tested in
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
    std::vector<protocol::DeviceDescription> devices() const override {
        ++deviceListings;
        return listed;
    }
    protocol::DeviceInfo selectDevice(const std::string& id) override {
        ++calls;
        selected.push_back(id);
        refuseIfAsked();
        return protocol::DeviceInfo{id, 44'100, 128, 128, 64};
    }

    int calls = 0;
    mutable int deviceListings = 0;
    std::vector<std::string> selected;
    std::vector<protocol::DeviceDescription> listed;
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

TEST_CASE("engine.devices lists the port's devices with the five fields", "[protocol][transport][devices]") {
    FakePort port;
    port.listed = {{"fake", "fake", "fake", false, true},
                   {"Windows Audio/Speakers", "Windows Audio", "Speakers", true, false}};
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();

    const Value result = f.ok(c, "engine.devices");
    CHECK(keysOf(result) == std::set<std::string>{"devices"});
    const auto& devices = at(result, "devices").asArray();
    REQUIRE(devices.size() == 2);
    for (const Value& device : devices) {
        CHECK(keysOf(device) == std::set<std::string>{"id", "type", "name", "isDefault", "current"});
        CHECK(at(device, "isDefault").kind() == Value::Kind::boolean);
        CHECK(at(device, "current").kind() == Value::Kind::boolean);
    }
    CHECK(at(devices[0], "id").asString() == "fake");
    CHECK(at(devices[0], "type").asString() == "fake");
    CHECK(at(devices[0], "name").asString() == "fake");
    CHECK_FALSE(at(devices[0], "isDefault").asBool());
    CHECK(at(devices[0], "current").asBool());
    CHECK(at(devices[1], "id").asString() == "Windows Audio/Speakers");
    CHECK(at(devices[1], "type").asString() == "Windows Audio");
    CHECK(at(devices[1], "name").asString() == "Speakers");
    CHECK(at(devices[1], "isDefault").asBool());
    CHECK_FALSE(at(devices[1], "current").asBool());
    CHECK(port.deviceListings == 1);
}

TEST_CASE("engine.select_device returns the device object engine.status carries", "[protocol][transport][devices]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();

    const Value device = f.ok(c, "engine.select_device", Value(Object{{"id", Value("fake")}}));
    CHECK(keysOf(device) ==
          std::set<std::string>{"id", "sampleRate", "bufferFrames", "inputLatencyFrames", "outputLatencyFrames"});
    CHECK(at(device, "id").asString() == "fake");
    CHECK(at(device, "sampleRate").asNumber() == 44'100);
    CHECK(at(device, "bufferFrames").asNumber() == 128);
    CHECK(at(device, "inputLatencyFrames").asNumber() == 128);
    CHECK(at(device, "outputLatencyFrames").asNumber() == 64);
    CHECK(port.selected == std::vector<std::string>{"fake"});
}

TEST_CASE("engine.select_device needs a string id", "[protocol][transport][devices]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    const std::vector<Value> bad = {Value(Object{}), Value(Object{{"id", Value(3)}}),
                                    Value(Object{{"id", Value(nullptr)}}), Value(Object{{"id", Value(Array{})}})};
    for (const Value& params : bad) {
        INFO(canonical(params));
        CHECK(errorCode(f.call(c, "engine.select_device", params)) == "invalid_params");
    }
    CHECK(port.selected.empty());
}

TEST_CASE("the port's not_found and device_open_failed are engine.select_device's codes",
          "[protocol][transport][devices]") {
    for (const std::string& code : {std::string("not_found"), std::string("device_open_failed")}) {
        INFO(code);
        FakePort port;
        port.refusal = code;
        Fixture f(withPort(port));
        const ConnectionId c = f.authed();
        const Value refused = f.call(c, "engine.select_device", Value(Object{{"id", Value("nope")}}));
        CHECK(errorCode(refused) == code);
        CHECK(at(at(refused, "error"), "message").asString() == "the port refused");
    }
}

TEST_CASE("without a port engine.devices and engine.select_device are not_supported",
          "[protocol][transport][devices]") {
    Fixture f;
    const ConnectionId c = f.authed();
    CHECK(errorCode(f.call(c, "engine.devices")) == "not_supported");
    CHECK(errorCode(f.call(c, "engine.select_device", Value(Object{{"id", Value("fake")}}))) == "not_supported");
}

TEST_CASE("engine.capabilities lists engine.devices and engine.select_device", "[protocol][transport][devices]") {
    Fixture f;
    const Value capabilities = f.ok(f.authed(), "engine.capabilities");
    const auto& methods = at(capabilities, "methods").asArray();
    for (const char* name : {"engine.devices", "engine.select_device"}) {
        INFO(name);
        CHECK(std::any_of(methods.begin(), methods.end(), [&](const Value& m) { return m.asString() == name; }));
    }
}

TEST_CASE("device methods: a duplicate requestId is cached and a stale expectedRevision runs nothing",
          "[protocol][transport][devices]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();

    const std::string request = f.request("req_select", "engine.select_device", Value(Object{{"id", Value("fake")}}));
    f.transport.deliver(c, request);
    f.server.pump();
    f.transport.deliver(c, request);
    f.server.pump();
    CHECK(port.selected.size() == 1);
    const auto sent = f.transport.sent(c);
    REQUIRE(sent.size() >= 2);
    CHECK(sent[sent.size() - 1] == sent[sent.size() - 2]);

    int id = 0;
    for (const auto& [method, params] : std::vector<std::pair<std::string, Value>>{
             {"engine.devices", Value(Object{})}, {"engine.select_device", Value(Object{{"id", Value("fake")}})}}) {
        INFO(method);
        f.transport.deliver(c, jcs::canonicalize(Value(Object{{"requestId", Value("stale_dev_" + std::to_string(++id))},
                                                              {"sessionId", Value(f.server.sessionId())},
                                                              {"method", Value(method)},
                                                              {"params", params},
                                                              {"expectedRevision", Value("rev_not_the_head")}})));
        f.server.pump();
        const auto after = f.transport.sent(c);
        REQUIRE_FALSE(after.empty());
        CHECK(errorCode(json::parse(after.back())) == "revision_mismatch");
    }
    CHECK(port.selected.size() == 1);
    CHECK(port.deviceListings == 0);
}
