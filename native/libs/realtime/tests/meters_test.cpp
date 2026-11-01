#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/realtime/control_dispatcher.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/rt/realtime_thread.hpp"

using namespace siann;
using graph::MeterNode;
using graph::TrackFaderNode;
using realtime::ControlDispatcher;
using realtime::GraphDriver;
using realtime::MeterSample;

namespace {

constexpr int kBlock = 64;

class ConstantNode final : public graph::Node {
public:
    int outputChannels() const override { return 2; }
    void process(const graph::ProcessContext& context, std::span<const graph::AudioBufferView>,
                 const graph::AudioBufferView& output) noexcept override {
        for (int c = 0; c < 2; ++c) {
            for (int i = 0; i < context.frames; ++i) {
                output.channel(c)[i] = 1.0f;
            }
        }
    }
};

// A metered mix: constant 1.0 -> fader(gain) -> track meter -> master bus ->
// master meter (the output). `padding` extra unconnected nodes come first, so
// a recompile moves every slot.
struct MeteredGraph {
    std::unique_ptr<graph::PreparedGraph> graph;
    graph::NodeId fader = 0;
    graph::NodeId trackMeter = 0;
    graph::NodeId masterMeter = 0;

    std::map<std::string, graph::NodeId> slots() const { return {{"track:t1", fader}}; }
    std::map<std::string, graph::NodeId> meterSlots() const {
        return {{"track:t1", trackMeter}, {"master", masterMeter}};
    }
};

MeteredGraph meteredGraph(std::int32_t gainMilliDb, int padding = 0) {
    graph::GraphBuilder b;
    for (int i = 0; i < padding; ++i) {
        b.add(std::make_unique<graph::BusNode>(2), "padding");
    }
    MeteredGraph g;
    const auto source = b.add(std::make_unique<ConstantNode>(), "source");
    g.fader = b.add(std::make_unique<TrackFaderNode>(2, gainMilliDb, 0, false), "fader");
    g.trackMeter = b.add(std::make_unique<MeterNode>(2), "track.meter");
    const auto master = b.add(std::make_unique<graph::BusNode>(2), "master");
    g.masterMeter = b.add(std::make_unique<MeterNode>(2), "master.meter");
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

// The fade is one block long, so block 0 is the fade-in and block 1 is at
// full level.
struct Rig {
    GraphDriver driver{GraphDriver::Options{kBlock, std::chrono::milliseconds(500)}};
    ControlDispatcher dispatcher{driver};
    host::ManualAudioDevice device;
    std::uint64_t first = 0;
    std::int64_t blocks = 0;

    explicit Rig(std::int32_t gainMilliDb = -6'000) {
        MeteredGraph g = meteredGraph(gainMilliDb);
        const auto slots = g.slots();
        const auto meterSlots = g.meterSlots();
        first = driver.publish(std::move(g.graph));
        dispatcher.graphPublished(first, slots, meterSlots);
        driver.play();
        driver.start(device, config());
    }
    std::vector<float> pump(int count) {
        std::vector<float> out;
        device.pump(count, &out);
        blocks += count;
        driver.poll();
        return out;
    }
    ~Rig() { driver.stop(); }
};

bool near(float a, float b, float tolerance = 1e-6f) {
    return std::abs(a - b) < tolerance;
}

}  // namespace

TEST_CASE("Meter samples reach the dispatcher with the playhead", "[meters]") {
    Rig rig;
    const float gain = graph::gainFromMilliDb(-6'000);
    CHECK_FALSE(rig.dispatcher.meter("track:t1").has_value());
    CHECK(rig.dispatcher.meterPlayhead() == -1);

    rig.pump(3);
    rig.dispatcher.tick();

    const auto track = rig.dispatcher.meter("track:t1");
    const auto master = rig.dispatcher.meter("master");
    REQUIRE(track.has_value());
    REQUIRE(master.has_value());
    for (const auto* sample : {&*track, &*master}) {
        CHECK(sample->epoch == rig.first);
        CHECK(sample->blockStart == 2 * kBlock);
        CHECK(sample->frames == kBlock);
        REQUIRE(sample->reading.channels == 2);
        for (std::size_t c = 0; c < 2; ++c) {
            CHECK(sample->reading.peak[c] == gain);
            CHECK(near(sample->reading.rms[c], gain));
        }
    }
    CHECK(rig.dispatcher.meterPlayhead() == 2 * kBlock);
    CHECK_FALSE(rig.dispatcher.meter("unknown").has_value());
    CHECK_FALSE(rig.dispatcher.meter("track:t2").has_value());
}

TEST_CASE("Samples from an older epoch are ignored after a recompile", "[meters]") {
    Rig rig(-6'000);
    rig.pump(2);
    rig.dispatcher.tick();
    REQUIRE(rig.dispatcher.meter("master").has_value());

    // The recompile is at unity and every slot moves by three.
    MeteredGraph g = meteredGraph(0, 3);
    const auto slots = g.slots();
    const auto meterSlots = g.meterSlots();
    const auto second = rig.driver.publish(std::move(g.graph));
    rig.dispatcher.graphPublished(second, slots, meterSlots);
    CHECK_FALSE(rig.dispatcher.meter("master").has_value());  // the old readings are gone

    // This block ducks the old graph out: its samples carry the old epoch.
    rig.pump(1);
    rig.dispatcher.tick();
    CHECK_FALSE(rig.dispatcher.meter("track:t1").has_value());
    CHECK_FALSE(rig.dispatcher.meter("master").has_value());
    CHECK(rig.dispatcher.meterPlayhead() == kBlock);  // stale samples do not move it

    // From the swap on, the new graph meters at unity.
    rig.pump(2);
    rig.dispatcher.tick();
    const auto track = rig.dispatcher.meter("track:t1");
    const auto master = rig.dispatcher.meter("master");
    REQUIRE(track.has_value());
    REQUIRE(master.has_value());
    CHECK(track->epoch == second);
    CHECK(master->epoch == second);
    CHECK(track->slot == meterSlots.at("track:t1"));
    CHECK(master->reading.peak[0] == 1.0f);
    CHECK(master->blockStart == 4 * kBlock);
    CHECK(rig.dispatcher.meterPlayhead() == 4 * kBlock);
}

TEST_CASE("A full meter queue drops samples and never blocks", "[meters]") {
    Rig rig;
    const float gain = graph::gainFromMilliDb(-6'000);
    const std::size_t capacity = rig.driver.meterCapacity();
    REQUIRE(capacity >= 2);
    constexpr std::size_t kMetered = 2;
    const auto fitting = static_cast<int>(capacity / kMetered);
    const int total = fitting + 10;

    // Nobody drains the queue. pump() is synchronous: a block that waited for
    // queue space would hang here.
    const auto out = rig.pump(total);
    REQUIRE(out.size() == static_cast<std::size_t>(total) * kBlock);
    CHECK(out.back() == gain);
    CHECK(rig.driver.meterDrops() == 10 * kMetered);
    CHECK(rig.driver.meterBacklog() == capacity);

    rig.dispatcher.tick();
    CHECK(rig.driver.meterBacklog() == 0);
    const auto master = rig.dispatcher.meter("master");
    REQUIRE(master.has_value());
    CHECK(master->blockStart == static_cast<std::int64_t>(fitting - 1) * kBlock);  // the newest that fit
    CHECK(rig.dispatcher.meterPlayhead() == static_cast<std::int64_t>(fitting - 1) * kBlock);

    // The ring recovers: the next block arrives again.
    rig.pump(1);
    rig.dispatcher.tick();
    CHECK(rig.dispatcher.meter("master")->blockStart == static_cast<std::int64_t>(total) * kBlock);
    CHECK(rig.dispatcher.meter("track:t1")->blockStart == static_cast<std::int64_t>(total) * kBlock);
    CHECK(rig.driver.meterDrops() == 10 * kMetered);
}

TEST_CASE("No audio-thread allocations while metering", "[meters]") {
    Rig rig;
    rig.pump(2);  // past the fade-in
    const auto before = rt::allocationViolations();
    for (int i = 0; i < 200; ++i) {
        rig.pump(1);
        rig.dispatcher.tick();  // meters flowing
    }
    CHECK(rt::allocationViolations() == before);
    REQUIRE(rig.dispatcher.meter("master").has_value());

    rig.pump(static_cast<int>(rig.driver.meterCapacity() / 2) + 200);  // and with the queue full
    CHECK(rig.driver.meterDrops() > 0);
    CHECK(rt::allocationViolations() == before);
}
