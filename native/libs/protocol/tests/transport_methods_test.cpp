// transport.play, transport.stop, transport.locate and engine.status (spec,
// Protocol v0 item 18, m4-engine-device), engine.devices and
// engine.select_device (item 22, m5-engine-sessions-devices),
// transport.set_cycle and transport.set_click with transport.changed (item 26,
// m5-ui-engine-loop-click) through the
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
    TransportState setCycle(bool enabled) override {
        ++calls;
        cycleCalls.push_back(enabled);
        refuseIfAsked();
        cycle = enabled;
        return state();
    }
    TransportState setClick(bool enabled, std::optional<std::int32_t> gainMilliDb) override {
        ++calls;
        clickCalls.emplace_back(enabled, gainMilliDb);
        refuseIfAsked();
        click.enabled = enabled;
        if (gainMilliDb) {
            click.gainMilliDb = *gainMilliDb;
        }
        return state();
    }
    EngineStatus status() const override {
        EngineStatus out = reported;
        out.cycle = cycle;
        out.click = click;
        return out;
    }
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
    bool cycle = false;
    protocol::ClickState click;
    std::vector<bool> cycleCalls;
    std::vector<std::pair<bool, std::optional<std::int32_t>>> clickCalls;
    std::optional<std::string> refusal;
    EngineStatus reported;

private:
    TransportState state() const { return TransportState{playing, position, cycle, click}; }
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
        CHECK(keysOf(status) == std::set<std::string>{"device", "playing", "cycle", "click", "recording", "armed", "xruns",
                                                      "maxCallbackMicros", "unmeasuredCallbacks", "underruns",
                                                      "srcUnderruns"});
        const Value& device = at(status, "device");
        CHECK(keysOf(device) == std::set<std::string>{"id", "sampleRate", "bufferFrames", "inputLatencyFrames", "input",
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
        CHECK(keysOf(device) == std::set<std::string>{"id", "type", "name", "isDefault", "current", "inputChannels",
                                                      "outputChannels"});
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
          std::set<std::string>{"id", "sampleRate", "bufferFrames", "inputLatencyFrames", "outputLatencyFrames", "input"});
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

// ---- m5-ui-engine-loop-click (Protocol v0 item 26) -------------------------

namespace {

Value enabled(bool on) {
    return Value(Object{{"enabled", Value(on)}});
}

Value clickParams(bool on, double gain) {
    return Value(Object{{"enabled", Value(on)}, {"gainMilliDb", Value(gain)}});
}

std::vector<Value> transportEvents(const Harness& f, ConnectionId connection) {
    std::vector<Value> out;
    for (Value& event : f.events(connection)) {
        if (at(event, "type").asString() == "transport.changed") {
            out.push_back(std::move(event));
        }
    }
    return out;
}

void checkTransportResult(const Value& result, bool cycle, bool clickOn, double gain) {
    CHECK(keysOf(result) == std::set<std::string>{"playing", "position", "cycle", "click", "recording", "armed"});
    CHECK(at(result, "cycle").asBool() == cycle);
    CHECK(keysOf(at(result, "click")) == std::set<std::string>{"enabled", "gainMilliDb"});
    CHECK(at(at(result, "click"), "enabled").asBool() == clickOn);
    CHECK(at(at(result, "click"), "gainMilliDb").asNumber() == gain);
}

}  // namespace

TEST_CASE("transport.set_cycle and transport.set_click reach the port and return the transport state",
          "[protocol][transport][cycle][click]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();

    const Value cycled = f.ok(c, "transport.set_cycle", enabled(true));
    checkTransportResult(cycled, true, false, -12'000);
    CHECK(at(cycled, "position").asString() == "1024");
    CHECK(port.cycleCalls == std::vector<bool>{true});

    const Value clicked = f.ok(c, "transport.set_click", clickParams(true, -6'000));
    checkTransportResult(clicked, true, true, -6'000);
    // gainMilliDb omitted keeps the gain: the port gets nothing for it.
    const Value off = f.ok(c, "transport.set_click", enabled(false));
    checkTransportResult(off, true, false, -6'000);
    REQUIRE(port.clickCalls.size() == 2);
    CHECK(port.clickCalls[0] == std::pair<bool, std::optional<std::int32_t>>{true, -6'000});
    CHECK(port.clickCalls[1] == std::pair<bool, std::optional<std::int32_t>>{false, std::nullopt});
    // The range ends are accepted.
    checkTransportResult(f.ok(c, "transport.set_click", clickParams(true, -60'000)), true, true, -60'000);
    checkTransportResult(f.ok(c, "transport.set_click", clickParams(true, 0)), true, true, 0);

    // play, stop and locate carry the same fields.
    checkTransportResult(f.ok(c, "transport.play"), true, true, 0);
    checkTransportResult(f.ok(c, "transport.locate", frames("0")), true, true, 0);
    checkTransportResult(f.ok(c, "transport.stop"), true, true, 0);

    const Value status = f.ok(c, "engine.status");
    CHECK(at(status, "cycle").asBool());
    CHECK(at(at(status, "click"), "enabled").asBool());
    CHECK(at(at(status, "click"), "gainMilliDb").asNumber() == 0);
}

TEST_CASE("transport.changed goes to every subscribed connection on a real change only",
          "[protocol][transport][cycle][click]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed(true);
    const ConnectionId watcher = f.authed(true);

    f.ok(c, "transport.set_cycle", enabled(true));
    auto events = transportEvents(f, watcher);
    REQUIRE(events.size() == 1);
    CHECK(at(events[0], "cycle").asBool());
    CHECK_FALSE(at(at(events[0], "click"), "enabled").asBool());
    CHECK(at(at(events[0], "click"), "gainMilliDb").asNumber() == -12'000);
    CHECK(transportEvents(f, c).size() == 1);  // whoever asked

    f.ok(c, "transport.set_cycle", enabled(true));  // the same value
    CHECK(transportEvents(f, watcher).size() == 1);

    f.ok(c, "transport.set_click", enabled(true));
    events = transportEvents(f, watcher);
    REQUIRE(events.size() == 2);
    CHECK(at(at(events[1], "click"), "enabled").asBool());

    f.ok(c, "transport.set_click", clickParams(true, -12'000));  // the same again
    CHECK(transportEvents(f, watcher).size() == 2);
    f.ok(c, "transport.set_click", clickParams(true, -3'000));  // the gain alone
    events = transportEvents(f, watcher);
    REQUIRE(events.size() == 3);
    CHECK(at(at(events[2], "click"), "gainMilliDb").asNumber() == -3'000);

    f.ok(c, "transport.play");  // play changes neither flag
    f.ok(c, "transport.set_cycle", enabled(false));
    events = transportEvents(f, watcher);
    REQUIRE(events.size() == 4);
    CHECK_FALSE(at(events[3], "cycle").asBool());
    // No revision: no session.changed with them.
    for (const Value& event : f.events(watcher)) {
        CHECK(at(event, "type").asString() != "session.changed");
    }
}

TEST_CASE("cycle and click create no revision", "[protocol][transport][cycle][click]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    const std::string head = f.head().envelope.id;
    const std::size_t revisions = f.session.history().revisions().size();
    f.ok(c, "transport.set_cycle", enabled(true));
    f.ok(c, "transport.set_click", clickParams(true, -1'000));
    f.ok(c, "transport.set_cycle", enabled(false));
    f.ok(c, "transport.set_click", enabled(false));
    CHECK(f.head().envelope.id == head);
    CHECK(f.session.history().revisions().size() == revisions);
    CHECK(at(f.ok(c, "session.inspect"), "revision").asString() == head);
}

TEST_CASE("transport.set_cycle and set_click refuse bad params before the port", "[protocol][transport][cycle][click]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    const std::vector<Value> badCycle = {Value(Object{}), Value(Object{{"enabled", Value(1)}}),
                                         Value(Object{{"enabled", Value("true")}}),
                                         Value(Object{{"enabled", Value(nullptr)}})};
    for (const Value& params : badCycle) {
        INFO(canonical(params));
        CHECK(errorCode(f.call(c, "transport.set_cycle", params)) == "invalid_params");
        CHECK(errorCode(f.call(c, "transport.set_click", params)) == "invalid_params");
    }
    const std::vector<Value> badGain = {clickParams(true, 1), clickParams(true, -60'001), clickParams(true, -0.5),
                                        clickParams(true, 1e12),
                                        Value(Object{{"enabled", Value(true)}, {"gainMilliDb", Value("-6000")}}),
                                        Value(Object{{"enabled", Value(true)}, {"gainMilliDb", Value(nullptr)}})};
    for (const Value& params : badGain) {
        INFO(canonical(params));
        CHECK(errorCode(f.call(c, "transport.set_click", params)) == "invalid_params");
    }
    CHECK(port.calls == 0);
}

TEST_CASE("cycle and click: without a port not_supported, a port's no_device passes through",
          "[protocol][transport][cycle][click]") {
    {
        Fixture f;
        const ConnectionId c = f.authed();
        CHECK(errorCode(f.call(c, "transport.set_cycle", enabled(true))) == "not_supported");
        CHECK(errorCode(f.call(c, "transport.set_click", enabled(true))) == "not_supported");
    }
    FakePort port;
    port.refusal = "no_device";
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    const Value refused = f.call(c, "transport.set_cycle", enabled(true));
    CHECK(errorCode(refused) == "no_device");
    CHECK(at(at(refused, "error"), "message").asString() == "the port refused");
    CHECK(errorCode(f.call(c, "transport.set_click", enabled(true))) == "no_device");
    CHECK(transportEvents(f, watcher).empty());
}

TEST_CASE("cycle and click: a duplicate requestId is cached and a stale expectedRevision runs nothing",
          "[protocol][transport][cycle][click]") {
    FakePort port;
    Fixture f(withPort(port));
    const ConnectionId c = f.authed();

    for (const auto& [method, params] : std::vector<std::pair<std::string, Value>>{
             {"transport.set_cycle", enabled(true)}, {"transport.set_click", clickParams(true, -2'000)}}) {
        INFO(method);
        const int before = port.calls;
        const std::string request = f.request("dup_" + method, method, params);
        f.transport.deliver(c, request);
        f.server.pump();
        f.transport.deliver(c, request);
        f.server.pump();
        CHECK(port.calls == before + 1);
        const auto sent = f.transport.sent(c);
        REQUIRE(sent.size() >= 2);
        CHECK(sent[sent.size() - 1] == sent[sent.size() - 2]);

        f.transport.deliver(c, jcs::canonicalize(Value(Object{{"requestId", Value("stale_" + method)},
                                                              {"sessionId", Value(f.server.sessionId())},
                                                              {"method", Value(method)},
                                                              {"params", params},
                                                              {"expectedRevision", Value("rev_not_the_head")}})));
        f.server.pump();
        CHECK(errorCode(json::parse(f.transport.sent(c).back())) == "revision_mismatch");
        CHECK(port.calls == before + 1);
    }
}

TEST_CASE("engine.capabilities lists set_cycle and set_click with features cycle and click",
          "[protocol][transport][cycle][click]") {
    for (const bool withTransport : {false, true}) {
        INFO("with a port: " << withTransport);
        FakePort port;
        Fixture f(withTransport ? withPort(port) : manualOptions());
        const Value capabilities = f.ok(f.authed(), "engine.capabilities");
        const auto& methods = at(capabilities, "methods").asArray();
        for (const char* name : {"transport.set_cycle", "transport.set_click"}) {
            INFO(name);
            CHECK(std::any_of(methods.begin(), methods.end(), [&](const Value& m) { return m.asString() == name; }));
        }
        const Value& features = at(capabilities, "features");
        CHECK(at(features, "locators").asBool());
        CHECK(at(features, "cycle").asBool() == withTransport);
        CHECK(at(features, "click").asBool() == withTransport);
    }
}
