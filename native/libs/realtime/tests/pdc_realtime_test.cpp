// Realtime PDC (architecture spec, "Latency model" and "State migration"): the
// M1 null tests played through the graph driver on the manual device, a
// node's latency changing during playback, and offline/realtime parity.
//
// Test names start with lowercase "pdc" so `ctest -R pdc` selects them.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <vector>

#include "pdc_fixtures.hpp"
#include "siann/engine/offline.hpp"
#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/rt/realtime_thread.hpp"

using namespace siann;
using graph::pdc::Built;
using graph::pdc::NoiseNode;
using realtime::GraphDriver;

namespace {

using Capture = std::vector<std::vector<float>>;  // per output channel

constexpr int kBlock = 64;
constexpr std::int64_t kMaxLatency = 512;
constexpr std::int64_t kChanged = 250;

// A long watchdog, so a debug CI box pausing between pumps cannot trip it.
GraphDriver::Options options(int fadeFrames) {
    GraphDriver::Options o;
    o.fadeFrames = fadeFrames;
    o.ackTimeout = std::chrono::seconds(10);
    return o;
}

host::AudioDeviceConfig config(int frames) {
    host::AudioDeviceConfig c;
    c.sampleRate = 48'000;
    c.bufferFrames = frames;
    c.outputChannels = 2;
    return c;
}

// One device block at a time, polling between blocks as the control thread would.
void pumpBlocks(GraphDriver& driver, host::ManualAudioDevice& device, int blocks, Capture& capture) {
    for (int b = 0; b < blocks; ++b) {
        device.pumpAll(1, capture);
        driver.poll();
    }
}

double maxAbs(const Capture& capture, std::size_t from = 0, std::size_t to = std::numeric_limits<std::size_t>::max()) {
    double peak = 0.0;
    for (const auto& channel : capture) {
        for (std::size_t i = from; i < std::min(to, channel.size()); ++i) {
            peak = std::max(peak, static_cast<double>(std::abs(channel[i])));
        }
    }
    return peak;
}

// A topology, built with the changing node at a given latency.
struct Topology {
    std::int64_t original = 0;                   // the changing node's latency at first
    std::function<Built(std::int64_t)> build;    // the changing node's latency -> recipe
    std::int64_t compensationAfter = 0;          // on Built::compensated once it is kChanged
    double tolerance = 0.0;                      // 0: an exact null
};

Topology direct() {
    return {100, [](std::int64_t l) -> Built { return graph::pdc::buildDirect(l, kMaxLatency); }, kChanged, 0.0};
}
// The aux insert changes; the main path is compensated up to it.
Topology send() {
    return {256, [](std::int64_t l) -> Built { return graph::pdc::buildSend(64, l, kMaxLatency); }, kChanged - 64,
            0.0};
}
// c changes; the dry feed into bus2 is compensated for a + c.
Topology nested() {
    return {33, [](std::int64_t l) -> Built { return graph::pdc::buildNested(10, l, 7, kMaxLatency); }, 10 + kChanged,
            1e-6};
}
Topology sidechain() {
    return {300, [](std::int64_t l) -> Built { return graph::pdc::buildSidechain(l, kMaxLatency); }, kChanged, 0.0};
}

void checkNullThroughDriver(const Topology& topology) {
    GraphDriver driver(options(kBlock));
    host::ManualAudioDevice device;
    driver.publish(graph::pdc::compile(topology.build(topology.original), kBlock));
    driver.play();
    driver.start(device, config(kBlock));
    const auto before = rt::allocationViolations();
    Capture out;
    pumpBlocks(driver, device, 80, out);
    CHECK(rt::allocationViolations() == before);
    driver.stop();

    CHECK(driver.playhead() == 80 * kBlock);  // it really played
    REQUIRE(out.size() == 2);
    REQUIRE(out[0].size() == static_cast<std::size_t>(80 * kBlock));
    CHECK(maxAbs(out) <= topology.tolerance);
}

void checkLatencyChange(const Topology& topology) {
    GraphDriver driver(options(kBlock));
    host::ManualAudioDevice device;
    Built first = topology.build(topology.original);
    graph::FakeLatencyNode* node = first.changingNode;  // owned by the live graph from here on
    const graph::NodeId slot = first.changing;
    const graph::pdc::EdgeRef edge = first.compensated;
    const auto firstEpoch = driver.publish(graph::pdc::compile(std::move(first), kBlock));
    driver.play();
    driver.start(device, config(kBlock));
    const auto before = rt::allocationViolations();

    Capture out;
    pumpBlocks(driver, device, 20, out);
    CHECK(maxAbs(out) <= topology.tolerance);
    CHECK(driver.latencyRecompiles() == 0);
    CHECK_FALSE(driver.lastLatencyChange().has_value());

    // The node reports a new latency while playing. Nobody but the driver's
    // own poll() reacts: the engine recompiles and publishes by itself.
    const std::size_t changedAt = out[0].size();
    REQUIRE(node->requestLatency(kChanged));
    pumpBlocks(driver, device, 1, out);
    CHECK(driver.latencyRecompiles() == 1);
    REQUIRE(driver.lastLatencyChange().has_value());
    CHECK(driver.lastLatencyChange()->epoch == firstEpoch);
    CHECK(driver.lastLatencyChange()->slot == slot);
    CHECK(driver.lastLatencyChange()->latency == kChanged);
    CHECK(driver.transitionInFlight());  // the recompile is already on its way

    for (int guard = 0; guard < 50 && (driver.transitionInFlight() || driver.liveEpoch() == firstEpoch); ++guard) {
        pumpBlocks(driver, device, 1, out);
    }
    REQUIRE(driver.liveEpoch() != firstEpoch);
    REQUIRE_FALSE(driver.transitionInFlight());
    const graph::PreparedGraph* live = driver.liveGraph();
    REQUIRE(live != nullptr);
    // Compensation recomputed: the delay line on the compensated edge was rebuilt.
    CHECK(live->edgeCompensation(edge.from, edge.to, edge.port) == topology.compensationAfter);
    const std::size_t swappedAt = out[0].size();
    pumpBlocks(driver, device, 40, out);
    CHECK(rt::allocationViolations() == before);
    CHECK(driver.latencyRecompiles() == 1);  // the new graph runs at its compiled latency
    CHECK(driver.latencyRecompileFailures() == 0);
    driver.stop();

    // Before the swap the old graph is misaligned, so the change was real ...
    CHECK(maxAbs(out, changedAt, swappedAt) > 0.01);
    // ... and from the swap on (hold and rise included) the null cancels again.
    CHECK(maxAbs(out, swappedAt) <= topology.tolerance);
}

}  // namespace

TEST_CASE("pdc realtime: direct null through the graph driver", "[pdc][realtime]") {
    checkNullThroughDriver(direct());
}

TEST_CASE("pdc realtime: send null through the graph driver", "[pdc][realtime]") {
    checkNullThroughDriver(send());
}

TEST_CASE("pdc realtime: nested null through the graph driver", "[pdc][realtime]") {
    checkNullThroughDriver(nested());
}

TEST_CASE("pdc realtime: sidechain null through the graph driver", "[pdc][realtime]") {
    checkNullThroughDriver(sidechain());
}

TEST_CASE("pdc realtime: offline and realtime renders of the same graph are identical", "[pdc][realtime][parity]") {
    constexpr int kMaxBlock = 128;
    constexpr int kFade = 64;
    constexpr std::int64_t kFrames = 4'096;
    int bufferFrames = kMaxBlock;
    SECTION("device blocks equal the graph block size") {
        bufferFrames = kMaxBlock;
    }
    SECTION("device blocks are processed in chunks of the graph block size") {
        bufferFrames = 2 * kMaxBlock;
    }
    // The send is not inverted, so the mix is not a null.
    const auto recipe = [] { return graph::pdc::buildSend(64, 256, 0, 1.0f); };

    auto offlineGraph = graph::pdc::compile(recipe(), kMaxBlock);
    const media::AudioBuffer offline = engine::renderGraph(*offlineGraph, 0, kFrames);
    REQUIRE(offline.info.channels == 2);
    REQUIRE(offline.info.frames == kFrames);

    auto realtimeGraph = graph::pdc::compile(recipe(), kMaxBlock);
    const std::int64_t latency = realtimeGraph->totalLatency();
    REQUIRE(latency == 256);
    GraphDriver driver(options(kFade));
    host::ManualAudioDevice device;
    driver.publish(std::move(realtimeGraph));
    driver.play();
    driver.start(device, config(bufferFrames));
    Capture out;
    pumpBlocks(driver, device, static_cast<int>((kFrames + latency) / bufferFrames) + 1, out);
    driver.stop();
    REQUIRE(out[0].size() >= static_cast<std::size_t>(kFrames + latency));

    // The realtime output trails the timeline by the graph latency; the
    // offline render is already shifted. After the driver's fade-in the gain
    // is exactly 1, so the samples must be identical.
    std::size_t compared = 0;
    std::size_t mismatches = 0;
    double peak = 0.0;
    for (std::int64_t j = 0; j < kFrames; ++j) {
        if (j + latency < kFade) {
            continue;
        }
        for (int c = 0; c < 2; ++c) {
            const float expected = offline.samples[static_cast<std::size_t>(j * 2 + c)];
            const float actual = out[static_cast<std::size_t>(c)][static_cast<std::size_t>(j + latency)];
            peak = std::max(peak, static_cast<double>(std::abs(expected)));
            ++compared;
            if (actual != expected) {
                ++mismatches;
            }
        }
    }
    CHECK(compared == static_cast<std::size_t>(kFrames * 2));
    CHECK(mismatches == 0);
    CHECK(peak > 0.5);  // a real signal, not two silent renders
}

TEST_CASE("pdc realtime: a latency change during playback is recompiled and nulls again (direct)",
          "[pdc][realtime][latency]") {
    checkLatencyChange(direct());
}

TEST_CASE("pdc realtime: a latency change during playback is recompiled and nulls again (send)",
          "[pdc][realtime][latency]") {
    checkLatencyChange(send());
}

TEST_CASE("pdc realtime: a latency change during playback is recompiled and nulls again (nested)",
          "[pdc][realtime][latency]") {
    checkLatencyChange(nested());
}

TEST_CASE("pdc realtime: a latency change during playback is recompiled and nulls again (sidechain)",
          "[pdc][realtime][latency]") {
    checkLatencyChange(sidechain());
}

namespace {

// Renders a graph block by block without a driver: what the graph plays when
// nothing ducks and nothing is swapped.
struct DirectRender {
    std::unique_ptr<graph::PreparedGraph> graph;
    std::vector<float> out;  // channel 0
    std::int64_t position = 0;

    void pump(int blocks) {
        for (int b = 0; b < blocks; ++b) {
            graph->process(graph::ProcessContext{position, kBlock});
            const auto& view = graph->output();
            for (int i = 0; i < kBlock; ++i) {
                out.push_back(view.channel(0)[i]);
            }
            position += kBlock;
        }
    }
};

// Pumps until a graph other than `epoch` is live and no transition is in flight.
void pumpUntilSwapped(GraphDriver& driver, host::ManualAudioDevice& device, std::uint64_t epoch, Capture& out) {
    for (int guard = 0; guard < 50 && (driver.transitionInFlight() || driver.liveEpoch() == epoch); ++guard) {
        pumpBlocks(driver, device, 1, out);
    }
    REQUIRE(driver.liveEpoch() != epoch);
    REQUIRE_FALSE(driver.transitionInFlight());
}

// Direct topology with the dry path added instead of inverted: the output is
// twice the source delayed by the latency, so a duck is visible.
struct DoublingRig {
    static constexpr int kFade = 100;
    GraphDriver driver{options(kFade)};
    host::ManualAudioDevice device;
    graph::FakeLatencyNode* node = nullptr;
    std::uint64_t epoch = 0;
    Capture out;

    DoublingRig() {
        auto built = graph::pdc::buildDirect(100, kMaxLatency, 1.0f);
        node = built.changingNode;
        epoch = driver.publish(graph::pdc::compile(std::move(built), kBlock));
        driver.play();
        driver.start(device, config(kBlock));
    }
    ~DoublingRig() { driver.stop(); }
    DoublingRig(const DoublingRig&) = delete;
    DoublingRig& operator=(const DoublingRig&) = delete;

    void pump(int blocks) { pumpBlocks(driver, device, blocks, out); }
};

// Two paths into one master: source -> a (latency 100, changing, times
// aGain) -> master and source -> b (latency 400) -> master. Raising a to 250
// keeps the master's arrival at 400, so only a's compensation edge changes:
// path b is unaffected and must be untouched by the transition.
struct TwoPath {
    std::unique_ptr<graph::PreparedGraph> graph;
    graph::FakeLatencyNode* a = nullptr;
    graph::NodeId source = 0;
    graph::NodeId aNode = 0;
    graph::NodeId bNode = 0;
    graph::NodeId master = 0;
};

TwoPath buildTwoPath(std::int64_t aLatency, float aGain) {
    TwoPath t;
    graph::GraphBuilder b;
    t.source = b.add(std::make_unique<NoiseNode>(1), "source");
    auto a = std::make_unique<graph::FakeLatencyNode>(1, aLatency, kMaxLatency);
    t.a = a.get();
    t.aNode = b.add(std::move(a), "a");
    t.bNode = b.add(std::make_unique<graph::FakeLatencyNode>(1, 400, kMaxLatency), "b");
    t.master = b.add(std::make_unique<graph::BusNode>(1), "master");
    b.connect(t.source, t.aNode);
    b.connect(t.source, t.bNode);
    b.connect(t.aNode, t.master, 0, aGain);
    b.connect(t.bNode, t.master);
    b.setOutput(t.master);
    t.graph = std::move(b).compile(kBlock);
    return t;
}

}  // namespace

TEST_CASE("pdc realtime: the affected path is ducked and restored around a latency change",
          "[pdc][realtime][latency]") {
    constexpr int kFade = DoublingRig::kFade;
    DoublingRig ducked;  // the driver answers the latency change with a recompile
    // The same graph and the same change, rendered without a driver: never
    // ducked, never swapped.
    auto refBuilt = graph::pdc::buildDirect(100, kMaxLatency, 1.0f);
    graph::FakeLatencyNode* refNode = refBuilt.changingNode;
    DirectRender reference{graph::pdc::compile(std::move(refBuilt), kBlock), {}, 0};
    const auto before = rt::allocationViolations();
    ducked.pump(20);
    reference.pump(20);
    for (std::size_t i = kFade; i < ducked.out[0].size(); ++i) {
        REQUIRE(ducked.out[0][i] == 2.0f * NoiseNode::sample(0, static_cast<std::int64_t>(i) - 100));
    }
    REQUIRE(ducked.node->requestLatency(kChanged));
    REQUIRE(refNode->requestLatency(kChanged));
    ducked.pump(1);  // the node reports; poll() recompiles and publishes
    reference.pump(1);
    REQUIRE(ducked.driver.latencyRecompiles() == 1);
    REQUIRE(ducked.driver.transitionInFlight());

    // The block that pops the new graph starts the duck; the duck spans
    // kFade frames, the swap happens at the end of the block it finishes in.
    const std::size_t popAt = ducked.out[0].size();
    ducked.pump(2);
    reference.pump(2);
    REQUIRE(ducked.driver.liveEpoch() != ducked.epoch);
    REQUIRE_FALSE(ducked.driver.transitionInFlight());
    const auto& out = ducked.out[0];
    const auto& ref = reference.out;
    std::size_t mismatches = 0;
    for (int k = 0; k < 2 * kBlock; ++k) {
        const std::size_t i = popAt + static_cast<std::size_t>(k);
        const float gain = k < kFade ? static_cast<float>(kFade - k) / static_cast<float>(kFade) : 0.0f;
        // Both master inputs are ramped (the gain applies per edge, so the sum
        // is not bit-identical to ref * gain).
        if (std::abs(out[i] - ref[i] * gain) > 1e-6f) {
            ++mismatches;
        }
        if (k >= kFade && out[i] != 0.0f) {
            ++mismatches;
        }
    }
    CHECK(mismatches == 0);
    // Exact zeros from kFade frames into the popping block to the swap, where
    // the unswapped graph is still loud: the zeros are the duck.
    CHECK(maxAbs(Capture{std::vector<float>(ref.begin() + static_cast<std::ptrdiff_t>(popAt + kFade),
                                            ref.begin() + static_cast<std::ptrdiff_t>(popAt + 2 * kBlock))}) > 0.1);

    // Restored: the rebuilt dry delay line (250 frames) fills while the
    // affected paths are held at zero, then they rise and the output is the
    // doubled source again, now delayed by the new latency.
    const graph::PreparedGraph* live = ducked.driver.liveGraph();
    REQUIRE(live != nullptr);
    CHECK(live->settleFrames() == kChanged);
    const std::size_t swappedAt = ducked.out[0].size();
    ducked.pump(12);
    CHECK(rt::allocationViolations() == before);
    const auto& restored = ducked.out[0];
    const std::size_t riseAt = swappedAt + static_cast<std::size_t>(kChanged);
    for (std::size_t i = swappedAt; i < restored.size(); ++i) {
        const auto t = static_cast<std::int64_t>(i);
        if (i < riseAt) {
            REQUIRE(restored[i] == 0.0f);  // held until the rebuilt delay line is full
        } else if (i < riseAt + kFade) {
            const float rise = static_cast<float>(i - riseAt) / static_cast<float>(kFade);
            REQUIRE(std::abs(restored[i] - 2.0f * NoiseNode::sample(0, t - kChanged) * rise) <= 1e-6f);
        } else {
            REQUIRE(restored[i] == 2.0f * NoiseNode::sample(0, t - kChanged));
        }
    }
    CHECK(maxAbs(ducked.out, riseAt + kFade) > 0.5);
}

TEST_CASE("pdc realtime: an unaffected path is untouched by a latency change on another path",
          "[pdc][realtime][latency]") {
    constexpr int kFade = 100;
    GraphDriver driver(options(kFade));
    host::ManualAudioDevice device;
    TwoPath rig = buildTwoPath(100, 1.0f);
    graph::FakeLatencyNode* a = rig.a;
    const auto firstEpoch = driver.publish(std::move(rig.graph));
    driver.play();
    driver.start(device, config(kBlock));
    // Path b alone (a's edge at gain 0), and both paths with a at 250 from the
    // start; neither is ever ducked or swapped.
    DirectRender onlyB{buildTwoPath(100, 0.0f).graph, {}, 0};
    DirectRender settled{buildTwoPath(kChanged, 1.0f).graph, {}, 0};
    const auto before = rt::allocationViolations();

    Capture out;
    pumpBlocks(driver, device, 20, out);
    REQUIRE(a->requestLatency(kChanged));
    pumpBlocks(driver, device, 1, out);
    REQUIRE(driver.latencyRecompiles() == 1);
    const std::size_t popAt = out[0].size();
    pumpUntilSwapped(driver, device, firstEpoch, out);
    const std::size_t swappedAt = out[0].size();
    pumpBlocks(driver, device, 20, out);
    CHECK(rt::allocationViolations() == before);
    const int blocks = static_cast<int>(out[0].size()) / kBlock;
    onlyB.pump(blocks);
    settled.pump(blocks);

    // Only a's compensation edge was rebuilt and only a's path is ramped.
    const graph::PreparedGraph* live = driver.liveGraph();
    REQUIRE(live != nullptr);
    CHECK(live->recompiledFrom() != nullptr);
    CHECK(live->edgeCompensation(rig.aNode, rig.master) == 400 - kChanged);
    CHECK(live->edgeCompensation(rig.bNode, rig.master) == 0);
    CHECK(live->edgeRamped(rig.aNode, rig.master));
    CHECK_FALSE(live->edgeRamped(rig.bNode, rig.master));
    CHECK_FALSE(live->edgeRamped(rig.source, rig.aNode));
    CHECK_FALSE(live->edgeRamped(rig.source, rig.bNode));
    CHECK(live->settleFrames() == 400 - kChanged);
    driver.stop();

    // While path a is at zero (end of the duck, through the swap, until a's
    // rebuilt delay line is full) the output is path b alone, sample for
    // sample: b was neither ducked nor restarted (its latency node kept its
    // 400 frames of history across the swap).
    const std::size_t holdEnd = swappedAt + static_cast<std::size_t>(400 - kChanged);
    std::size_t mismatches = 0;
    for (std::size_t i = popAt + kFade; i < holdEnd; ++i) {
        if (out[0][i] != onlyB.out[i]) {
            ++mismatches;
        }
    }
    CHECK(mismatches == 0);
    CHECK(maxAbs(Capture{std::vector<float>(onlyB.out.begin() + static_cast<std::ptrdiff_t>(popAt + kFade),
                                            onlyB.out.begin() + static_cast<std::ptrdiff_t>(holdEnd))}) > 0.5);
    // After a's rise both paths play as if a had been at 250 all along.
    mismatches = 0;
    for (std::size_t i = holdEnd + kFade; i < out[0].size(); ++i) {
        if (out[0][i] != settled.out[i]) {
            ++mismatches;
        }
    }
    CHECK(mismatches == 0);
}

TEST_CASE("pdc realtime: parameter changes for the original epoch apply after a latency recompile",
          "[pdc][realtime][latency]") {
    GraphDriver driver(options(kBlock));
    host::ManualAudioDevice device;
    graph::GraphBuilder b;
    const graph::NodeId source = b.add(std::make_unique<NoiseNode>(1), "source");
    auto latency = std::make_unique<graph::FakeLatencyNode>(1, 100, kMaxLatency);
    graph::FakeLatencyNode* node = latency.get();
    const graph::NodeId delayed = b.add(std::move(latency), "latency");
    const graph::NodeId fader = b.add(std::make_unique<graph::TrackFaderNode>(1, 0, 0, false), "fader");
    b.connect(source, delayed);
    b.connect(delayed, fader);
    b.setOutput(fader);
    const auto epoch = driver.publish(std::move(b).compile(kBlock));
    driver.play();
    driver.start(device, config(kBlock));

    Capture out;
    pumpBlocks(driver, device, 10, out);
    REQUIRE(node->requestLatency(kChanged));
    pumpBlocks(driver, device, 1, out);
    REQUIRE(driver.latencyRecompiles() == 1);
    pumpUntilSwapped(driver, device, epoch, out);
    pumpBlocks(driver, device, 10, out);
    CHECK(maxAbs(out, out[0].size() - kBlock) > 0.1);

    // The control dispatcher still addresses the graph it was told about: a
    // latency recompile keeps every slot, so a change for that epoch applies.
    REQUIRE(driver.pushParam(realtime::ParamChange{epoch, fader, graph::TrackFaderNode::kMute, 1.0, 0}));
    pumpBlocks(driver, device, 2, out);
    driver.stop();
    CHECK(maxAbs(out, out[0].size() - kBlock) == 0.0);
}
