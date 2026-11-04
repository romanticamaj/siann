// The realtime channel (m3-events-sync): meters and playhead as binary
// latest-wins frames on their own connections, never behind commands. The
// meters come from a real GraphDriver and ControlDispatcher pumped by a
// ManualAudioDevice (as in siann-realtime's meters_test); the binary links the
// realtime allocation guard.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "support/protocol_fixture.hpp"
#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/protocol/realtime_channel.hpp"
#include "siann/realtime/control_dispatcher.hpp"
#include "siann/realtime/graph_driver.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::MeterFrame;
using protocol::MeterPublisher;
using realtime::ControlDispatcher;
using realtime::GraphDriver;

namespace {

constexpr int kBlock = 64;
constexpr std::int64_t kNow = 1'700'000'000'123'456;

class ConstantNode final : public graph::Node {
public:
    int outputChannels() const override { return 2; }
    void process(const graph::ProcessContext& context, std::span<const graph::AudioBufferView>,
                 const graph::AudioBufferView& output) noexcept override {
        for (int c = 0; c < 2; ++c) {
            for (int i = 0; i < context.frames; ++i) {
                output.channel(c)[i] = c == 0 ? 1.0f : 0.5f;
            }
        }
    }
};

// constant source -> fader(gain) -> track meter -> master bus -> master meter.
struct MeteredGraph {
    std::unique_ptr<graph::PreparedGraph> graph;
    graph::NodeId fader = 0;
    graph::NodeId trackMeter = 0;
    graph::NodeId masterMeter = 0;

    std::map<std::string, graph::NodeId> slots() const { return {{"track:trk_1", fader}}; }
    std::map<std::string, graph::NodeId> meterSlots() const {
        return {{"track:trk_1", trackMeter}, {"master", masterMeter}};
    }
};

MeteredGraph meteredGraph(std::int32_t gainMilliDb) {
    graph::GraphBuilder b;
    MeteredGraph g;
    const auto source = b.add(std::make_unique<ConstantNode>(), "source");
    g.fader = b.add(std::make_unique<graph::TrackFaderNode>(2, gainMilliDb, 0, false), "fader");
    g.trackMeter = b.add(std::make_unique<graph::MeterNode>(2), "track.meter");
    const auto master = b.add(std::make_unique<graph::BusNode>(2), "master");
    g.masterMeter = b.add(std::make_unique<graph::MeterNode>(2), "master.meter");
    b.connect(source, g.fader);
    b.connect(g.fader, g.trackMeter);
    b.connect(g.trackMeter, master);
    b.connect(master, g.masterMeter);
    b.setOutput(g.masterMeter);
    g.graph = std::move(b).compile(kBlock);
    return g;
}

host::AudioDeviceConfig config() {
    host::AudioDeviceConfig c;
    c.sampleRate = 48'000;
    c.bufferFrames = kBlock;
    c.outputChannels = 2;
    return c;
}

struct Rig {
    GraphDriver driver;
    ControlDispatcher dispatcher{driver};
    host::ManualAudioDevice device;
    std::uint64_t epoch = 0;
    std::map<std::string, graph::NodeId> meterSlots;

    Rig() : driver(GraphDriver::Options{kBlock, std::chrono::milliseconds(500), GraphDriver::kDefaultMeterCapacity, {}}) {
        MeteredGraph g = meteredGraph(-6'000);
        const auto slots = g.slots();
        meterSlots = g.meterSlots();
        epoch = driver.publish(std::move(g.graph));
        dispatcher.graphPublished(epoch, slots, meterSlots);
        driver.play();
        driver.start(device, config());
    }
    void pump(int count) {
        std::vector<float> out;
        device.pump(count, &out);
        driver.poll();
        dispatcher.tick();
    }
    ~Rig() { driver.stop(); }
};

// Reads the documented little-endian layout byte by byte, independently of
// protocol::decodeMeterFrame.
struct Reader {
    const std::string& bytes;
    std::size_t offset = 0;

    std::uint64_t unsignedValue(int size) {
        REQUIRE(offset + static_cast<std::size_t>(size) <= bytes.size());
        std::uint64_t value = 0;
        for (int i = 0; i < size; ++i) {
            value |= static_cast<std::uint64_t>(static_cast<unsigned char>(bytes[offset + static_cast<std::size_t>(i)]))
                     << (8 * i);
        }
        offset += static_cast<std::size_t>(size);
        return value;
    }
    std::int64_t signed64() { return static_cast<std::int64_t>(unsignedValue(8)); }
    float f32() {
        const auto bits = static_cast<std::uint32_t>(unsignedValue(4));
        float value = 0;
        std::memcpy(&value, &bits, sizeof value);
        return value;
    }
};

struct Decoded {
    std::string magic;
    unsigned version = 0;
    std::uint64_t epoch = 0;
    std::int64_t timestamp = 0;
    std::int64_t playhead = 0;
    unsigned playing = 0;
    struct Entry {
        unsigned index = 0;
        unsigned channels = 0;
        std::vector<float> peak;
        std::vector<float> rms;
    };
    std::vector<Entry> entries;
};

Decoded decodeByLayout(const std::string& bytes) {
    REQUIRE(bytes.size() >= 32);
    Decoded d;
    d.magic = bytes.substr(0, 4);
    Reader r{bytes, 4};
    d.version = static_cast<unsigned>(r.unsignedValue(1));
    d.epoch = r.unsignedValue(8);
    d.timestamp = r.signed64();
    d.playhead = r.signed64();
    d.playing = static_cast<unsigned>(r.unsignedValue(1));
    const auto count = r.unsignedValue(2);
    CHECK(r.offset == 32);
    for (std::uint64_t i = 0; i < count; ++i) {
        Decoded::Entry e;
        e.index = static_cast<unsigned>(r.unsignedValue(2));
        e.channels = static_cast<unsigned>(r.unsignedValue(1));
        for (unsigned c = 0; c < e.channels; ++c) {
            e.peak.push_back(r.f32());
        }
        for (unsigned c = 0; c < e.channels; ++c) {
            e.rms.push_back(r.f32());
        }
        d.entries.push_back(std::move(e));
    }
    CHECK(r.offset == bytes.size());
    return d;
}

bool within(float a, float b) {
    return std::abs(a - b) < 1e-6f;
}

MeterPublisher::Options publisherOptions(const Rig& rig) {
    MeterPublisher::Options options;
    options.playing = [&rig] { return rig.driver.playing(); };
    options.clockMicros = [] { return kNow; };
    return options;
}

std::string fromHex(const std::string& hex) {
    std::string out;
    for (std::size_t i = 0; i + 1 < hex.size(); i += 2) {
        out.push_back(static_cast<char>(std::stoi(hex.substr(i, 2), nullptr, 16)));
    }
    return out;
}

}  // namespace

TEST_CASE("meters and playhead are one binary frame on the realtime channel", "[protocol][realtime]") {
    Rig rig;
    Fixture f;
    const ConnectionId listener = f.authed(true);
    const ConnectionId rt = f.realtimeAuthed();
    REQUIRE(f.server.realtime().connections() == 1);
    MeterPublisher publisher(rig.dispatcher, f.server.realtime(), f.server.events(), publisherOptions(rig));

    // The legend goes on the event channel after the graph publication.
    publisher.graphPublished(rig.epoch, rig.meterSlots);
    f.server.pump();
    const auto events = f.events(listener);
    REQUIRE(events.size() == 1);
    CHECK(at(events[0], "type").asString() == "meters.legend");
    CHECK(at(events[0], "epoch").asString() == std::to_string(rig.epoch));
    std::vector<std::string> legend;
    for (const auto& entity : at(events[0], "entities").asArray()) {
        legend.push_back(entity.asString());
    }
    CHECK(legend == publisher.legend());
    CHECK(legend == std::vector<std::string>{"master", "track:trk_1"});

    CHECK_FALSE(publisher.tick());  // no meter sample yet
    CHECK(f.transport.binary(rt).empty());

    rig.pump(2);
    REQUIRE(publisher.tick());
    const auto frames = f.transport.binary(rt);
    REQUIRE(frames.size() == 1);
    CHECK(f.transport.sent(rt).empty());  // never a text frame on the realtime channel

    const Decoded d = decodeByLayout(frames[0]);
    CHECK(d.magic == "SMTR");
    CHECK(d.version == 1);
    CHECK(d.epoch == rig.epoch);
    CHECK(d.timestamp == kNow);
    CHECK(d.playhead == rig.dispatcher.meterPlayhead());
    CHECK(d.playhead == kBlock);
    CHECK(d.playing == 1);
    REQUIRE(d.entries.size() == 2);
    for (const auto& entry : d.entries) {
        REQUIRE(entry.index < legend.size());
        const auto sample = rig.dispatcher.meter(legend[entry.index]);
        REQUIRE(sample.has_value());
        REQUIRE(entry.channels == static_cast<unsigned>(sample->reading.channels));
        for (std::size_t c = 0; c < entry.channels; ++c) {
            CHECK(within(entry.peak[c], sample->reading.peak[c]));
            CHECK(within(entry.rms[c], sample->reading.rms[c]));
        }
    }
    CHECK(d.entries[0].peak[0] > d.entries[0].peak[1]);  // left 1.0, right 0.5 before the fader

    // The decoder agrees with the layout.
    const auto decoded = protocol::decodeMeterFrame(frames[0]);
    REQUIRE(decoded.has_value());
    CHECK(decoded->epoch == rig.epoch);
    CHECK(decoded->playheadSamples == d.playhead);
    CHECK(decoded->entries.size() == 2);

    // No binary frame on the event channel.
    CHECK(f.transport.binary(listener).empty());
}

TEST_CASE("meter frames match the shared fixture byte for byte", "[protocol][realtime]") {
    std::ifstream in(std::string(SIANN_FIXTURES_DIR) + "/protocol/meter-frames.json", std::ios::binary);
    REQUIRE(in.good());
    std::stringstream text;
    text << in.rdbuf();
    const Value fixture = json::parse(text.str());
    const auto& frames = at(fixture, "meterFrames").asArray();
    REQUIRE(frames.size() >= 3);
    for (const auto& item : frames) {
        INFO(at(item, "name").asString());
        const Value& spec = at(item, "frame");
        MeterFrame frame;
        frame.epoch = std::stoull(at(spec, "epoch").asString());
        frame.engineTimestampMicros = std::stoll(at(spec, "engineTimestampMicros").asString());
        frame.playheadSamples = std::stoll(at(spec, "playheadSamples").asString());
        frame.playing = at(spec, "playing").asBool();
        for (const auto& e : at(spec, "entries").asArray()) {
            protocol::MeterFrameEntry entry;
            entry.entityIndex = static_cast<std::uint16_t>(at(e, "entityIndex").asNumber());
            entry.channels = static_cast<std::uint8_t>(at(e, "channels").asNumber());
            for (const auto& v : at(e, "peak").asArray()) {
                entry.peak.push_back(static_cast<float>(v.asNumber()));
            }
            for (const auto& v : at(e, "rms").asArray()) {
                entry.rms.push_back(static_cast<float>(v.asNumber()));
            }
            frame.entries.push_back(std::move(entry));
        }
        const std::string bytes = fromHex(at(item, "hex").asString());
        CHECK(protocol::encodeMeterFrame(frame) == bytes);
        const auto decoded = protocol::decodeMeterFrame(bytes);
        REQUIRE(decoded.has_value());
        CHECK(protocol::encodeMeterFrame(*decoded) == bytes);
        // Truncated or extended frames are malformed.
        CHECK_FALSE(protocol::decodeMeterFrame(bytes.substr(0, bytes.size() - 1)).has_value());
        CHECK_FALSE(protocol::decodeMeterFrame(bytes + std::string(1, '\0')).has_value());
        std::string badMagic = bytes;
        badMagic[0] = 'X';
        CHECK_FALSE(protocol::decodeMeterFrame(badMagic).has_value());
    }
}

TEST_CASE("meter frames are latest wins and dropped while the socket is congested", "[protocol][realtime]") {
    Rig rig;
    Fixture f;
    const ConnectionId rt = f.realtimeAuthed();
    MeterPublisher publisher(rig.dispatcher, f.server.realtime(), f.server.events(), publisherOptions(rig));
    publisher.graphPublished(rig.epoch, rig.meterSlots);

    // Ten blocks between two publisher ticks: one frame with the newest block.
    rig.pump(10);
    REQUIRE(publisher.tick());
    auto frames = f.transport.binary(rt);
    REQUIRE(frames.size() == 1);
    CHECK(decodeByLayout(frames[0]).playhead == 9 * kBlock);

    // Congested: the frame is dropped and counted, never queued.
    f.transport.setBufferedAmount(rt, std::size_t{1} << 20);
    rig.pump(2);
    publisher.tick();
    CHECK(f.transport.binary(rt).size() == 1);
    CHECK(f.server.realtime().dropped(rt) == 1);

    // Uncongested again: the next tick sends the newest values, not the dropped ones.
    f.transport.setBufferedAmount(rt, 0);
    rig.pump(3);
    REQUIRE(publisher.tick());
    frames = f.transport.binary(rt);
    REQUIRE(frames.size() == 2);
    CHECK(decodeByLayout(frames[1]).playhead == 14 * kBlock);
    CHECK(decodeByLayout(frames[1]).playhead == rig.dispatcher.meterPlayhead());
    CHECK(f.server.realtime().sent(rt) == 2);
    CHECK(f.server.realtime().dropped(rt) == 1);
}

TEST_CASE("meters never queue behind commands", "[protocol][realtime]") {
    Rig rig;
    Fixture f;
    const ConnectionId listener = f.authed(true);
    const ConnectionId operatorConnection = f.authed(false);
    const ConnectionId rt = f.realtimeAuthed();
    MeterPublisher publisher(rig.dispatcher, f.server.realtime(), f.server.events(), publisherOptions(rig));
    publisher.graphPublished(rig.epoch, rig.meterSlots);
    f.server.pump();
    REQUIRE(f.events(listener).size() == 1);

    // The event socket holds its writes; a backlog of commits builds up.
    f.transport.setBufferedAmount(listener, std::size_t{1} << 30);
    for (int i = 0; i < 100; ++i) {
        f.commit(operatorConnection, Array{trackAdd("trk_" + std::to_string(i))});
    }
    REQUIRE(f.server.events().queued(listener) == 100);

    rig.pump(2);
    REQUIRE(publisher.tick());
    CHECK(f.transport.binary(rt).size() == 1);
    CHECK(f.server.events().queued(listener) == 100);
    CHECK(f.events(listener).size() == 1);

    // Each kind stays on its own channel.
    CHECK(f.transport.sent(rt).empty());
    CHECK(f.transport.binary(listener).empty());
    CHECK(f.transport.binary(operatorConnection).empty());
}

TEST_CASE("realtime connections need the token and get only binary frames", "[protocol][realtime]") {
    Rig rig;
    Fixture f;
    MeterPublisher publisher(rig.dispatcher, f.server.realtime(), f.server.events(), publisherOptions(rig));
    publisher.graphPublished(rig.epoch, rig.meterSlots);

    const ConnectionId silent = *f.transport.connectRealtime().connection;  // never authenticates
    const ConnectionId wrong = *f.transport.connectRealtime().connection;
    f.transport.deliver(wrong, canonical(Value(Object{{"type", Value("auth")}, {"token", Value("nope")}})));
    CHECK(f.transport.closed(wrong));
    CHECK(f.transport.closeCode(wrong) == 1008);
    CHECK(f.transport.sent(wrong).empty());

    const ConnectionId chatty = f.realtimeAuthed();
    f.transport.deliver(chatty, f.request("q1", "session.inspect", Value(Object{})));
    CHECK(f.transport.closed(chatty));
    CHECK(f.transport.sent(chatty).empty());

    const ConnectionId good = f.realtimeAuthed();
    CHECK(f.server.realtime().connections() == 1);
    rig.pump(2);
    REQUIRE(publisher.tick());
    CHECK(f.transport.binary(good).size() == 1);
    CHECK(f.transport.binary(silent).empty());
    CHECK(f.transport.sent(silent).empty());
    CHECK(f.transport.sent(good).empty());
}
