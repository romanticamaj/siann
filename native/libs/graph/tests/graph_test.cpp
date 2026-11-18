#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <climits>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <stdexcept>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "pdc_fixtures.hpp"

using namespace siann::graph;
using pdc::NoiseNode;

namespace {

// Renders the graph block by block from `from` and returns channel 0.
std::vector<float> run(PreparedGraph& graph, std::int64_t frames, int block, std::int64_t from = 0) {
    std::vector<float> out;
    for (std::int64_t start = from; start < from + frames; start += block) {
        const int n = static_cast<int>(std::min<std::int64_t>(block, from + frames - start));
        graph.process(ProcessContext{start, n});
        for (int i = 0; i < n; ++i) {
            out.push_back(graph.output().channel(0)[i]);
        }
    }
    return out;
}

bool allZero(const std::vector<float>& samples) {
    for (const float s : samples) {
        if (s != 0.0f) {
            return false;
        }
    }
    return true;
}

std::string errorCode(GraphBuilder&& builder) {
    try {
        (void)std::move(builder).compile(64);
    } catch (const GraphError& error) {
        return error.code();
    }
    return "no error";
}

}  // namespace

TEST_CASE("PDC null test: direct path against a delayed path", "[graph][pdc]") {
    auto d = pdc::buildDirect(100);
    const NodeId source = d.source;
    const NodeId delayed = d.delayed;
    const NodeId master = d.master;
    auto graph = pdc::compile(std::move(d), 64);

    CHECK(graph->edgeCompensation(source, master) == 100);
    CHECK(graph->edgeCompensation(delayed, master) == 0);
    CHECK(graph->totalLatency() == 100);
    CHECK(allZero(run(*graph, 5'000, 64)));
}

TEST_CASE("PDC null test: a send to an aux bus with its own latency", "[graph][pdc]") {
    auto s = pdc::buildSend(64, 256);
    const NodeId insert = s.insert;
    const NodeId auxInsert = s.auxInsert;
    const NodeId master = s.master;
    auto graph = pdc::compile(std::move(s), 128);

    CHECK(graph->edgeCompensation(insert, master) == 192);
    CHECK(graph->edgeCompensation(auxInsert, master) == 0);
    CHECK(graph->totalLatency() == 256);
    CHECK(allZero(run(*graph, 4'096, 128)));
}

TEST_CASE("PDC null test: nested aux buses at different depths", "[graph][pdc]") {
    auto n = pdc::buildNested(10, 33, 7);
    const NodeId source = n.source;
    const NodeId bus2 = n.bus2;
    const NodeId d = n.d;
    const NodeId master = n.master;
    auto graph = pdc::compile(std::move(n), 32);

    CHECK(graph->outputLatency(bus2) == 43);
    CHECK(graph->edgeCompensation(source, bus2) == 43);
    CHECK(graph->edgeCompensation(d, master) == 36);
    // 1.0 * x + 0.5 * x - 1.5 * x is exactly zero for these sample values only if
    // every copy of x lines up.
    const auto out = run(*graph, 2'000, 32);
    double maxAbs = 0.0;
    for (const float s : out) {
        maxAbs = std::max(maxAbs, static_cast<double>(std::abs(s)));
    }
    CHECK(maxAbs < 1e-6);
}

TEST_CASE("PDC null test: a sidechain input lines up with the main input", "[graph][pdc]") {
    auto s = pdc::buildSidechain(300);
    const NodeId source = s.source;
    const NodeId comp = s.comp;
    auto graph = pdc::compile(std::move(s), 100);

    CHECK(graph->edgeCompensation(source, comp, 1) == 300);
    CHECK(allZero(run(*graph, 3'000, 100)));
}

TEST_CASE("pdc: a requested latency takes effect at the start of the next block", "[graph][pdc][latency]") {
    GraphBuilder b;
    const NodeId source = b.add(std::make_unique<NoiseNode>(1), "source");
    auto owned = std::make_unique<FakeLatencyNode>(1, 4, 16);
    FakeLatencyNode* node = owned.get();
    const NodeId delayed = b.add(std::move(owned), "latency");
    b.connect(source, delayed);
    b.setOutput(delayed);
    auto graph = std::move(b).compile(8);

    const auto before = run(*graph, 8, 8);
    for (std::int64_t t = 4; t < 8; ++t) {
        CHECK(before[static_cast<std::size_t>(t)] == NoiseNode::sample(0, t - 4));
    }
    REQUIRE(node->requestLatency(10));
    CHECK(node->latency() == 4);  // nothing changes between blocks
    const auto after = run(*graph, 32, 8, 8);
    CHECK(node->latency() == 10);
    // The switch restarts the delay line: silence for the new latency, then the
    // input delayed by 10 samples.
    for (std::int64_t t = 8; t < 40; ++t) {
        INFO("t = " << t);
        const float expected = t < 18 ? 0.0f : NoiseNode::sample(0, t - 10);
        CHECK(after[static_cast<std::size_t>(t - 8)] == expected);
    }
}

TEST_CASE("pdc: the graph reports one coalesced latency change per node", "[graph][pdc][latency]") {
    auto d = pdc::buildDirect(100, 512);
    FakeLatencyNode* node = d.changingNode;
    const NodeId slot = d.changing;
    auto graph = pdc::compile(std::move(d), 64);
    LatencyChange change;

    run(*graph, 640, 64);
    CHECK_FALSE(graph->popLatencyChange(change));  // nothing changed

    REQUIRE(node->requestLatency(100));  // the latency it already has
    run(*graph, 64, 64, 640);
    CHECK_FALSE(graph->popLatencyChange(change));

    REQUIRE(node->requestLatency(200));  // superseded before the next block
    REQUIRE(node->requestLatency(250));
    run(*graph, 192, 64, 704);
    REQUIRE(graph->popLatencyChange(change));
    CHECK(change.slot == slot);
    CHECK(change.latency == 250);
    CHECK_FALSE(graph->popLatencyChange(change));  // one event, not one per block
    CHECK(graph->totalLatency() == 100);            // compensation changes only on a recompile

    REQUIRE(node->requestLatency(300));
    run(*graph, 64, 64, 896);
    REQUIRE(graph->popLatencyChange(change));
    CHECK(change.latency == 300);
    CHECK_FALSE(graph->popLatencyChange(change));
}

TEST_CASE("pdc: a recompile after a latency change migrates nodes and unchanged delay lines", "[graph][pdc][latency]") {
    // source -> a (100, changing; at gain 0) -> master, source -> b (400) ->
    // master, source -> c (10) -> master. a rising to 250 rebuilds only a's
    // compensation edge; c's 390-frame delay line and every node carry over.
    auto build = [](FakeLatencyNode** changing, NodeId* ids) {
        GraphBuilder b;
        ids[0] = b.add(std::make_unique<NoiseNode>(1), "source");
        auto a = std::make_unique<FakeLatencyNode>(1, 100, 512);
        *changing = a.get();
        ids[1] = b.add(std::move(a), "a");
        ids[2] = b.add(std::make_unique<FakeLatencyNode>(1, 400), "b");
        ids[3] = b.add(std::make_unique<FakeLatencyNode>(1, 10), "c");
        ids[4] = b.add(std::make_unique<BusNode>(1), "master");
        b.connect(ids[0], ids[1]);
        b.connect(ids[0], ids[2]);
        b.connect(ids[0], ids[3]);
        b.connect(ids[1], ids[4], 0, 0.0f);
        b.connect(ids[2], ids[4]);
        b.connect(ids[3], ids[4]);
        b.setOutput(ids[4]);
        return std::move(b).compile(64);
    };
    FakeLatencyNode* node = nullptr;
    NodeId id[5]{};
    auto first = build(&node, id);
    FakeLatencyNode* refNode = nullptr;
    NodeId refId[5]{};
    auto reference = build(&refNode, refId);  // never recompiled
    CHECK(first->recompiledFrom() == nullptr);
    CHECK(first->settleFrames() == 0);

    const auto a1 = run(*first, 640, 64);
    const auto r1 = run(*reference, 640, 64);
    CHECK(a1 == r1);
    REQUIRE(node->requestLatency(250));
    REQUIRE(refNode->requestLatency(250));
    run(*first, 64, 64, 640);
    run(*reference, 64, 64, 640);
    LatencyChange change;
    REQUIRE(first->popLatencyChange(change));

    const auto second = first->recompile();
    REQUIRE(second != nullptr);
    CHECK(second->recompiledFrom() == first.get());
    CHECK(second->nodeCount() == first->nodeCount());
    for (NodeId n = 0; n < 5; ++n) {
        CHECK(second->nodeAt(n) == first->nodeAt(n));  // the same instances
    }
    CHECK(first->edgeCompensation(id[1], id[4]) == 300);
    CHECK(second->edgeCompensation(id[1], id[4]) == 150);
    CHECK(second->edgeCompensation(id[3], id[4]) == 390);
    CHECK(second->totalLatency() == 400);
    CHECK(second->edgeRamped(id[1], id[4]));
    CHECK_FALSE(second->edgeRamped(id[2], id[4]));
    CHECK_FALSE(second->edgeRamped(id[3], id[4]));
    CHECK_FALSE(second->edgeRamped(id[0], id[1]));
    CHECK(second->settleFrames() == 150);
    CHECK_FALSE(second->popLatencyChange(change));  // compiled at the new latency

    // The edges the driver holds after the swap: rampedEdges() plus the edges
    // a previous recompile's hold still covers (edges in insertion order:
    // source->a, source->b, source->c, a->master, b->master, c->master).
    const std::vector<std::uint8_t> carried{0, 0, 0, 0, 1, 0};
    const auto held = second->holdEdges(carried);
    CHECK(std::vector<std::uint8_t>(held.begin(), held.end()) == std::vector<std::uint8_t>{0, 0, 0, 1, 1, 0});
    const auto own = second->holdEdges({});
    CHECK(std::vector<std::uint8_t>(own.begin(), own.end()) == std::vector<std::uint8_t>{0, 0, 0, 1, 0, 0});
    const std::vector<std::uint8_t> mismatched{1, 1};
    const auto ignored = second->holdEdges(mismatched);
    CHECK(std::vector<std::uint8_t>(ignored.begin(), ignored.end()) == std::vector<std::uint8_t>{0, 0, 0, 1, 0, 0});
    CHECK(first->holdEdges(carried).empty());  // compiled, not recompiled: nothing to hold

    // The recompiled graph continues where the first stopped: b's and c's
    // history (in b's node and c's compensation delay line) survives, so the
    // output matches the graph that was never recompiled.
    const auto a2 = run(*second, 1'024, 64, 704);
    const auto r2 = run(*reference, 1'024, 64, 704);
    CHECK(a2 == r2);
    CHECK_FALSE(allZero(a2));
}

TEST_CASE("pdc: a latency outside zero to maxLatency is rejected", "[graph][pdc][latency]") {
    CHECK_THROWS_AS(FakeLatencyNode(1, 20, 16), std::invalid_argument);
    CHECK_THROWS_AS(FakeLatencyNode(1, -1), std::invalid_argument);

    auto d = pdc::buildDirect(100, 128);
    FakeLatencyNode* node = d.changingNode;
    auto graph = pdc::compile(std::move(d), 64);
    CHECK_FALSE(node->requestLatency(129));
    CHECK_FALSE(node->requestLatency(-1));
    run(*graph, 128, 64);
    CHECK(node->latency() == 100);
    LatencyChange change;
    CHECK_FALSE(graph->popLatencyChange(change));
    CHECK(allZero(run(*graph, 1'024, 64, 128)));  // still nulls
    CHECK(node->requestLatency(128));             // the maximum itself is allowed
}

TEST_CASE("Block size does not change the result", "[graph]") {
    auto build = [] {
        GraphBuilder b;
        const NodeId source = b.add(std::make_unique<NoiseNode>(1), "source");
        const NodeId delayed = b.add(std::make_unique<FakeLatencyNode>(1, 37), "latency");
        const NodeId master = b.add(std::make_unique<BusNode>(1, 0.5f), "master");
        b.connect(source, delayed);
        b.connect(delayed, master);
        b.connect(source, master, 0, 0.25f);
        b.setOutput(master);
        return b;
    };
    auto g1 = build().compile(512);
    auto g2 = build().compile(512);
    const auto a = run(*g1, 3'000, 512);
    const auto c = run(*g2, 3'000, 17);
    CHECK(a == c);
}

TEST_CASE("Compile errors have stable codes", "[graph]") {
    {
        GraphBuilder b;
        const NodeId x = b.add(std::make_unique<BusNode>(1), "x");
        const NodeId y = b.add(std::make_unique<BusNode>(1), "y");
        b.connect(x, y);
        b.connect(y, x);
        b.setOutput(y);
        CHECK(errorCode(std::move(b)) == "cycle");
    }
    {
        GraphBuilder b;
        const NodeId x = b.add(std::make_unique<NoiseNode>(2), "x");
        const NodeId y = b.add(std::make_unique<BusNode>(1), "y");
        b.connect(x, y);
        b.setOutput(y);
        CHECK(errorCode(std::move(b)) == "channel_mismatch");
    }
    {
        GraphBuilder b;
        const NodeId x = b.add(std::make_unique<NoiseNode>(1), "x");
        const NodeId y = b.add(std::make_unique<BusNode>(1), "y");
        b.connect(x, y, 1);
        b.setOutput(y);
        CHECK(errorCode(std::move(b)) == "invalid_port");
    }
    {
        GraphBuilder b;
        b.add(std::make_unique<NoiseNode>(1), "x");
        CHECK(errorCode(std::move(b)) == "no_output");
    }
    {
        GraphBuilder b;
        const NodeId x = b.add(std::make_unique<NoiseNode>(1), "x");
        CHECK_THROWS_AS(b.connect(x, 7), GraphError);
    }
    {
        GraphBuilder b;
        const NodeId source = b.add(std::make_unique<NoiseNode>(1), "source");
        const NodeId delayed = b.add(std::make_unique<FakeLatencyNode>(1, 5'000), "latency");
        const NodeId master = b.add(std::make_unique<BusNode>(1), "master");
        b.connect(source, delayed);
        b.connect(delayed, master);
        b.connect(source, master);
        b.setOutput(master);
        try {
            (void)std::move(b).compile(64, 4'096);
            FAIL("expected compensation_limit");
        } catch (const GraphError& error) {
            CHECK(error.code() == "compensation_limit");
        }
    }
}

TEST_CASE("Gain conversion from milli-dB", "[nodes]") {
    CHECK(gainFromMilliDb(0) == 1.0f);
    CHECK(gainFromMilliDb(INT32_MIN) == 0.0f);
    CHECK(std::abs(gainFromMilliDb(-6'000) - 0.501187f) < 1e-5f);
    CHECK(std::abs(gainFromMilliDb(6'000) - 1.995262f) < 1e-5f);
}

TEST_CASE("Track fader pan laws", "[nodes]") {
    const TrackFaderNode monoCenter(1, 0, 0, false);
    CHECK(std::abs(monoCenter.leftGain() - 0.7071068f) < 1e-6f);
    CHECK(std::abs(monoCenter.rightGain() - 0.7071068f) < 1e-6f);
    const TrackFaderNode monoLeft(1, 0, -10'000, false);
    CHECK(std::abs(monoLeft.leftGain() - 1.0f) < 1e-6f);
    CHECK(std::abs(monoLeft.rightGain()) < 1e-6f);
    const TrackFaderNode stereoCenter(2, 0, 0, false);
    CHECK(stereoCenter.leftGain() == 1.0f);
    CHECK(stereoCenter.rightGain() == 1.0f);
    const TrackFaderNode stereoHalfRight(2, 0, 5'000, false);
    CHECK(stereoHalfRight.leftGain() == 0.5f);
    CHECK(stereoHalfRight.rightGain() == 1.0f);
    const TrackFaderNode muted(2, 0, 0, true);
    CHECK(muted.leftGain() == 0.0f);
    CHECK(muted.rightGain() == 0.0f);
}

TEST_CASE("Track fader gain is clamped to the model's range, minus infinity kept", "[nodes]") {
    const float top = gainFromMilliDb(24'000);
    const float bottom = gainFromMilliDb(-144'000);
    TrackFaderNode fader(2, 0, 0, false);
    for (const double value : {24'001.0, 1e6, 3e9, 1e300, std::numeric_limits<double>::infinity()}) {
        INFO(value);
        fader.setParameter(TrackFaderNode::kGainMilliDb, value, 0);
        CHECK(std::isfinite(fader.leftGain()));
        CHECK(fader.leftGain() == top);
        CHECK(fader.rightGain() == top);
    }
    for (const double value : {-144'001.0, -1e6, static_cast<double>(INT32_MIN) + 1.0}) {
        INFO(value);
        fader.setParameter(TrackFaderNode::kGainMilliDb, value, 0);
        CHECK(fader.leftGain() == bottom);
    }
    for (const double value : {static_cast<double>(INT32_MIN), -3e9, -std::numeric_limits<double>::infinity()}) {
        INFO(value);
        fader.setParameter(TrackFaderNode::kGainMilliDb, -6'000, 0);
        fader.setParameter(TrackFaderNode::kGainMilliDb, value, 0);
        CHECK(fader.leftGain() == 0.0f);
    }
    fader.setParameter(TrackFaderNode::kGainMilliDb, -6'000, 0);
    const float before = fader.leftGain();
    fader.setParameter(TrackFaderNode::kGainMilliDb, std::numeric_limits<double>::quiet_NaN(), 0);
    fader.setParameter(TrackFaderNode::kPan, std::numeric_limits<double>::quiet_NaN(), 0);
    CHECK(fader.leftGain() == before);
    CHECK(fader.rightGain() == before);
}

TEST_CASE("Track fader solo silence is not the mute parameter", "[nodes]") {
    TrackFaderNode soloSilenced(2, 0, 0, false, true);
    CHECK(soloSilenced.leftGain() == 0.0f);
    soloSilenced.setParameter(TrackFaderNode::kMute, 0.0, 0);
    CHECK(soloSilenced.leftGain() == 0.0f);
    CHECK(soloSilenced.rightGain() == 0.0f);
    soloSilenced.setParameter(TrackFaderNode::kMute, 1.0, 0);
    soloSilenced.setParameter(TrackFaderNode::kMute, 0.0, 0);
    CHECK(soloSilenced.leftGain() == 0.0f);
    TrackFaderNode audible(2, 0, 0, true, false);
    audible.setParameter(TrackFaderNode::kMute, 0.0, 0);
    CHECK(audible.leftGain() == 1.0f);
}

TEST_CASE("Clip player places media on the timeline", "[nodes]") {
    auto media = std::make_shared<PlanarAudio>();
    media->channels = 1;
    media->frames = 10;
    media->data = {{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}};

    GraphBuilder b;
    const NodeId player = b.add(
        std::make_unique<ClipPlayerNode>(2, std::vector<ClipPlayerNode::Clip>{
                                                {5, 2, 4, 0.5f, media},   // media[2..5] at 5..8
                                                {7, 0, 2, 1.0f, media},   // media[0..1] at 7..8, overlaps
                                            }),
        "player");
    b.setOutput(player);
    auto graph = std::move(b).compile(4);
    const auto out = run(*graph, 12, 4);
    const std::vector<float> expected = {0, 0, 0, 0, 0, 1.5f, 2.0f, 3.5f, 5.0f, 0, 0, 0};
    CHECK(out == expected);
}

namespace {

// Block 0: a 0.5-amplitude sine with whole periods on L and a full-scale
// square on R. Every later block is silence.
class TestSignalNode final : public Node {
public:
    int outputChannels() const override { return 2; }
    void process(const ProcessContext& context, std::span<const AudioBufferView>,
                 const AudioBufferView& output) noexcept override {
        for (int i = 0; i < context.frames; ++i) {
            if (context.blockStart == 0) {
                output.channel(0)[i] = sineAt(i);
                output.channel(1)[i] = (i / 8) % 2 == 0 ? 1.0f : -1.0f;
            } else {
                output.channel(0)[i] = 0.0f;
                output.channel(1)[i] = 0.0f;
            }
        }
    }

    // Period 16, so a 64-frame block holds four whole periods.
    static float sineAt(int frame) noexcept {
        const double phase = 2.0 * 3.14159265358979323846 * static_cast<double>(frame % 16) / 16.0;
        return static_cast<float>(0.5 * std::sin(phase));
    }
};

}  // namespace

TEST_CASE("MeterNode passes its input through and reports per-channel peak and RMS per block", "[nodes][meter]") {
    GraphBuilder b;
    const NodeId source = b.add(std::make_unique<TestSignalNode>(), "source");
    auto meterNode = std::make_unique<MeterNode>(2);
    const MeterNode* meter = meterNode.get();
    const NodeId m = b.add(std::move(meterNode), "meter");
    b.connect(source, m);
    b.setOutput(m);
    auto graph = std::move(b).compile(64);

    graph->process(ProcessContext{0, 64});
    for (int i = 0; i < 64; ++i) {
        CHECK(graph->output().channel(0)[i] == TestSignalNode::sineAt(i));
        CHECK(graph->output().channel(1)[i] == ((i / 8) % 2 == 0 ? 1.0f : -1.0f));
    }
    const MeterReading first = meter->reading();
    CHECK(first.channels == 2);
    CHECK(first.peak[0] == 0.5f);
    CHECK(first.peak[1] == 1.0f);
    CHECK(std::abs(first.rms[0] - 0.5f / std::sqrt(2.0f)) < 1e-5f);
    CHECK(std::abs(first.rms[1] - 1.0f) < 1e-6f);

    // Per block, not held.
    graph->process(ProcessContext{64, 64});
    const MeterReading second = meter->reading();
    CHECK(second.peak[0] == 0.0f);
    CHECK(second.peak[1] == 0.0f);
    CHECK(second.rms[0] == 0.0f);
    CHECK(second.rms[1] == 0.0f);
}

TEST_CASE("compile() lists metered nodes with their NodeIds in schedule order", "[graph][meter]") {
    GraphBuilder b;
    // The master meter is added before the track meter but runs after it.
    const NodeId source = b.add(std::make_unique<TestSignalNode>(), "source");
    const NodeId masterMeter = b.add(std::make_unique<MeterNode>(2), "master.meter");
    const NodeId fader = b.add(std::make_unique<TrackFaderNode>(2, -6'000, 0, false), "fader");
    const NodeId trackMeter = b.add(std::make_unique<MeterNode>(2), "track.meter");
    const NodeId master = b.add(std::make_unique<BusNode>(2), "master");
    b.connect(source, fader);
    b.connect(fader, trackMeter);
    b.connect(trackMeter, master);
    b.connect(master, masterMeter);
    b.setOutput(masterMeter);
    auto graph = std::move(b).compile(64);

    const auto metered = graph->meteredNodes();
    REQUIRE(metered.size() == 2);
    CHECK(metered[0] == trackMeter);
    CHECK(metered[1] == masterMeter);

    graph->process(ProcessContext{0, 64});
    const MeterReading track = graph->meterReading(trackMeter);
    const MeterReading mix = graph->meterReading(masterMeter);
    CHECK(track.channels == 2);
    CHECK(track.peak[1] == gainFromMilliDb(-6'000));
    CHECK(mix.peak[0] == track.peak[0]);
    CHECK(mix.rms[1] == track.rms[1]);
    // An unmetered or unknown node reads as empty.
    CHECK(graph->meterReading(fader).channels == 0);
    CHECK(graph->meterReading(99).channels == 0);

    GraphBuilder plain;
    const NodeId only = plain.add(std::make_unique<BusNode>(1), "bus");
    plain.setOutput(only);
    CHECK(std::move(plain).compile(64)->meteredNodes().empty());
}

// ---- m5b-engine-monitoring: the monitor input node and the low-latency path ----

namespace {

// A constant on every channel (a track's clips in the monitoring tests).
class ConstantNode final : public Node {
public:
    ConstantNode(int channels, float value) : channels_(channels), value_(value) {}
    int outputChannels() const override { return channels_; }
    void process(const ProcessContext& context, std::span<const AudioBufferView>,
                 const AudioBufferView& output) noexcept override {
        for (int c = 0; c < channels_; ++c) {
            std::fill_n(output.channel(c), context.frames, value_);
        }
    }

private:
    int channels_;
    float value_;
};

// 1.0 at timeline frame `at` on every channel, silence elsewhere: a clip's impulse.
class ImpulseNode final : public Node {
public:
    ImpulseNode(int channels, std::int64_t at) : channels_(channels), at_(at) {}
    int outputChannels() const override { return channels_; }
    void process(const ProcessContext& context, std::span<const AudioBufferView>,
                 const AudioBufferView& output) noexcept override {
        for (int c = 0; c < channels_; ++c) {
            for (int i = 0; i < context.frames; ++i) {
                output.channel(c)[i] = context.blockStart + i == at_ ? 1.0f : 0.0f;
            }
        }
    }

private:
    int channels_;
    std::int64_t at_;
};

// A device input of `channels` channels, `frames` long, from a generator.
struct InputBlock {
    std::vector<std::vector<float>> data;
    std::vector<float*> pointers;

    InputBlock(int channels, std::int64_t frames)
        : data(static_cast<std::size_t>(channels), std::vector<float>(static_cast<std::size_t>(frames), 0.0f)) {
        for (auto& channel : data) {
            pointers.push_back(channel.data());
        }
    }
    // The view of frames [start, start + n).
    AudioBufferView at(std::int64_t start, int n) {
        for (std::size_t c = 0; c < data.size(); ++c) {
            pointers[c] = data[c].data() + start;
        }
        return AudioBufferView{pointers.data(), static_cast<int>(data.size()), n};
    }
};

// Renders like run(), handing each block its slice of `input`; `before` runs
// ahead of every block (the gate flips of a test).
std::vector<float> runWithInput(PreparedGraph& graph, InputBlock& input, std::int64_t frames, int block,
                                bool rolling, const std::function<void(std::int64_t start)>& before = {}) {
    std::vector<float> out;
    for (std::int64_t start = 0; start < frames; start += block) {
        const int n = static_cast<int>(std::min<std::int64_t>(block, frames - start));
        if (before) {
            before(start);
        }
        const AudioBufferView view = input.at(start, n);
        ProcessContext context{start, n};
        context.rolling = rolling;
        context.input = &view;
        graph.process(context);
        for (int i = 0; i < n; ++i) {
            out.push_back(graph.output().channel(0)[i]);
        }
    }
    return out;
}

std::int64_t firstPeak(const std::vector<float>& samples, float threshold = 0.5f) {
    for (std::size_t i = 0; i < samples.size(); ++i) {
        if (std::abs(samples[i]) >= threshold) {
            return static_cast<std::int64_t>(i);
        }
    }
    return -1;
}

float maxStep(const std::vector<float>& samples) {
    float step = 0.0f;
    for (std::size_t i = 1; i < samples.size(); ++i) {
        step = std::max(step, std::abs(samples[i] - samples[i - 1]));
    }
    return step;
}

}  // namespace

TEST_CASE("MonitorInputNode passes the mapped input when open and its port 0 when closed", "[graph][monitor]") {
    InputBlock input(3, 256);
    for (int i = 0; i < 256; ++i) {
        input.data[0][static_cast<std::size_t>(i)] = 0.5f;
        input.data[1][static_cast<std::size_t>(i)] = 0.001f * static_cast<float>(i);
        input.data[2][static_cast<std::size_t>(i)] = -0.002f * static_cast<float>(i);
    }

    SECTION("input mode passes the input sample for sample, rolling or not") {
        for (const bool rolling : {true, false}) {
            GraphBuilder b;
            const NodeId clips = b.add(std::make_unique<ConstantNode>(1, 0.25f), "clips");
            const NodeId monitor = b.add(
                std::make_unique<MonitorInputNode>(1, MonitorInputMode::input, 1, 1, nullptr, 16), "monitor");
            b.connect(clips, monitor);
            b.setOutput(monitor);
            auto graph = std::move(b).compile(64);
            CHECK(graph->monitors());
            const auto out = runWithInput(*graph, input, 256, 64, rolling);
            for (int i = 0; i < 256; ++i) {
                INFO(i);
                CHECK(out[static_cast<std::size_t>(i)] == input.data[1][static_cast<std::size_t>(i)]);
            }
        }
    }

    SECTION("a mono input feeds both channels of a stereo track, a stereo input maps channel for channel") {
        GraphBuilder b;
        const NodeId clips = b.add(std::make_unique<ConstantNode>(2, 0.25f), "clips");
        const NodeId mono = b.add(
            std::make_unique<MonitorInputNode>(2, MonitorInputMode::input, 1, 1, nullptr, 16), "mono");
        const NodeId pair = b.add(
            std::make_unique<MonitorInputNode>(2, MonitorInputMode::input, 1, 2, nullptr, 16), "pair");
        const NodeId sum = b.add(std::make_unique<BusNode>(2), "sum");
        b.connect(clips, mono);
        b.connect(clips, pair);
        b.connect(mono, sum);
        b.connect(pair, sum);
        b.setOutput(sum);
        auto graph = std::move(b).compile(64);
        const AudioBufferView view = input.at(0, 64);
        ProcessContext context{0, 64};
        context.input = &view;
        graph->process(context);
        for (int i = 0; i < 64; ++i) {
            const auto f = static_cast<std::size_t>(i);
            CHECK(graph->output().channel(0)[i] == input.data[1][f] + input.data[1][f]);
            CHECK(graph->output().channel(1)[i] == input.data[1][f] + input.data[2][f]);
        }
    }

    SECTION("auto plays port 0 while rolling unarmed and passes the input while stopped and armed") {
        MonitorGate gate;
        GraphBuilder b;
        const NodeId clips = b.add(std::make_unique<ConstantNode>(1, 0.25f), "clips");
        const NodeId monitor = b.add(
            std::make_unique<MonitorInputNode>(1, MonitorInputMode::automatic, 1, 1, &gate, 16), "monitor");
        b.connect(clips, monitor);
        b.setOutput(monitor);
        auto graph = std::move(b).compile(64);
        // Rolling, unarmed: the clips.
        for (const float v : runWithInput(*graph, input, 64, 64, true)) {
            CHECK(v == 0.25f);
        }
        // Stopped and unarmed: the clips' port, which a stopped player leaves silent.
        // Stopped and armed: the input (after the fade).
        gate.armed.store(true);
        const auto armed = runWithInput(*graph, input, 256, 64, false);
        for (int i = 64; i < 256; ++i) {
            CHECK(armed[static_cast<std::size_t>(i)] == input.data[1][static_cast<std::size_t>(i)]);
        }
        // Rolling, armed but not capturing: the clips again; capturing: the input.
        const auto rollingArmed = runWithInput(*graph, input, 256, 64, true);
        CHECK(rollingArmed.back() == 0.25f);
        gate.capturing.store(true);
        const auto capturing = runWithInput(*graph, input, 256, 64, true);
        CHECK(capturing.back() == input.data[1].back());
    }

    SECTION("without an input in the context, or past its channels, the input is silence") {
        GraphBuilder b;
        const NodeId clips = b.add(std::make_unique<ConstantNode>(1, 0.25f), "clips");
        const NodeId wide = b.add(
            std::make_unique<MonitorInputNode>(1, MonitorInputMode::input, 2, 2, nullptr, 16), "wide");
        b.connect(clips, wide);
        b.setOutput(wide);
        auto graph = std::move(b).compile(64);
        graph->process(ProcessContext{0, 64});
        CHECK(graph->output().channel(0)[10] == 0.0f);
        for (const float v : runWithInput(*graph, input, 64, 64, true)) {
            CHECK(v == 0.0f);  // ports 2 and 3 of a 3-channel input: not covered
        }
    }
}

// The track's channel map comes from the document (Track.input.port is 0 to
// INT32_MAX): the check that the open input covers it must not overflow.
TEST_CASE("MonitorInputNode's coverage check holds at the edge values up to INT32_MAX", "[graph][monitor]") {
    InputBlock input(3, 64);
    for (int i = 0; i < 64; ++i) {
        input.data[0][static_cast<std::size_t>(i)] = 0.125f;
        input.data[1][static_cast<std::size_t>(i)] = 0.25f;
        input.data[2][static_cast<std::size_t>(i)] = 0.5f;
    }
    struct Case {
        int port;
        int channels;
        float expected;  // the mono track's output: the input, or silence
    };
    const std::vector<Case> cases = {
        {2, 1, 0.5f},                    // the last channel: covered
        {1, 2, 0.375f},                  // the last pair, averaged into mono: covered
        {0, 2, 0.1875f},                 // the first pair
        {3, 1, 0.0f},                    // one past the last channel
        {2, 2, 0.0f},                    // a pair that runs one past
        {INT_MAX, 1, 0.0f},              // port + channels would overflow an int
        {INT_MAX, 2, 0.0f},
        {INT_MAX - 1, 2, 0.0f},
        {INT_MAX - 2, 2, 0.0f},
    };
    for (const Case& c : cases) {
        INFO("port " << c.port << " channels " << c.channels);
        GraphBuilder b;
        const NodeId clips = b.add(std::make_unique<ConstantNode>(1, 0.75f), "clips");
        const NodeId monitor = b.add(
            std::make_unique<MonitorInputNode>(1, MonitorInputMode::input, c.port, c.channels, nullptr, 16), "monitor");
        b.connect(clips, monitor);
        b.setOutput(monitor);
        auto graph = std::move(b).compile(64);
        for (const float v : runWithInput(*graph, input, 64, 64, true)) {
            CHECK(v == c.expected);
        }
    }
}

TEST_CASE("Monitored input bypasses compensation; the same track's clips stay aligned", "[graph][monitor][pdc]") {
    // Track A: its clips (or the input) -> its own 30-frame insert -> master over
    // a low-latency edge. Track B: a 100-frame insert -> master.
    auto build = [](MonitorInputMode mode, const MonitorGate* gate, NodeId& monitorEdge, NodeId& master) {
        GraphBuilder b;
        const NodeId clips = b.add(std::make_unique<ImpulseNode>(1, 300), "a.clips");
        const NodeId monitor =
            b.add(std::make_unique<MonitorInputNode>(1, mode, 0, 1, gate, 16), "a.monitor");
        const NodeId insertA = b.add(std::make_unique<FakeLatencyNode>(1, 30), "a.insert");
        const NodeId silent = b.add(std::make_unique<ConstantNode>(1, 0.0f), "b.clips");
        const NodeId insertB = b.add(std::make_unique<FakeLatencyNode>(1, 100), "b.insert");
        master = b.add(std::make_unique<BusNode>(1), "master");
        b.connect(clips, monitor);
        b.connect(monitor, insertA);
        b.connectLowLatency(insertA, master, monitor);
        b.connect(silent, insertB);
        b.connect(insertB, master);
        b.setOutput(master);
        monitorEdge = insertA;
        return std::move(b).compile(64);
    };
    InputBlock input(1, 2'048);
    input.data[0][500] = 1.0f;

    NodeId from = 0;
    NodeId master = 0;
    auto monitored = build(MonitorInputMode::input, nullptr, from, master);
    CHECK(monitored->edgeCompensation(from, master) == 70);
    CHECK(monitored->totalLatency() == 100);
    CHECK(monitored->monitorPathLatency() == 30);  // its own insert, not the compensation
    const auto heard = runWithInput(*monitored, input, 2'048, 64, true);
    CHECK(firstPeak(heard) == 530);

    // Auto, unarmed and rolling: the track's clip at 300 lines up with track B (100).
    MonitorGate gate;
    auto clips = build(MonitorInputMode::automatic, &gate, from, master);
    CHECK(clips->edgeCompensation(from, master) == 70);
    const auto played = runWithInput(*clips, input, 2'048, 64, true);
    CHECK(firstPeak(played) == 400);
}

TEST_CASE("Flipping the monitor gate mid-run crossfades without a step", "[graph][monitor]") {
    constexpr int kFade = 32;
    MonitorGate gate;
    GraphBuilder b;
    const NodeId clips = b.add(std::make_unique<ConstantNode>(1, 0.0f), "a.clips");
    const NodeId monitor =
        b.add(std::make_unique<MonitorInputNode>(1, MonitorInputMode::automatic, 0, 1, &gate, kFade), "a.monitor");
    const NodeId other = b.add(std::make_unique<ConstantNode>(1, 0.0f), "b.clips");
    const NodeId latent = b.add(std::make_unique<FakeLatencyNode>(1, 100), "b.insert");
    const NodeId master = b.add(std::make_unique<BusNode>(1), "master");
    b.connect(clips, monitor);
    b.connectLowLatency(monitor, master, monitor);
    b.connect(other, latent);
    b.connect(latent, master);
    b.setOutput(master);
    auto graph = std::move(b).compile(64);
    REQUIRE(graph->edgeCompensation(monitor, master) == 100);

    InputBlock input(1, 6'400);
    for (std::size_t i = 0; i < input.data[0].size(); ++i) {
        input.data[0][i] = 1.0f;  // DC: any switch without a fade is a full-scale step
    }
    gate.armed.store(true);
    const auto out = runWithInput(*graph, input, 6'400, 64, true, [&](std::int64_t start) {
        if (start == 640) {
            gate.capturing.store(true);  // to the input, mid-run
        } else if (start == 3'200) {
            gate.capturing.store(false);  // and back to the clips
        }
    });
    CHECK(out[600] == 0.0f);
    CHECK(out[3'000] == 1.0f);  // the input, undelayed
    CHECK(out.back() == 0.0f);
    // Each crossfade moves at most 1 / fade per sample on either path.
    CHECK(maxStep(out) <= 2.0f / static_cast<float>(kFade) + 1e-4f);
}

// The compensation delay line of a low-latency edge must not hold the input it
// passed: a switch back to the clips (a punch-out, auto at the end of a capture)
// would otherwise play the last `compensation` frames of the performer's input
// a second time, late.
TEST_CASE("Switching a monitored strip back to its clips plays no input a second time", "[graph][monitor]") {
    constexpr int kFade = 32;
    constexpr std::int64_t kComp = 100;
    MonitorGate gate;
    GraphBuilder b;
    const NodeId clips = b.add(std::make_unique<ConstantNode>(1, 0.25f), "a.clips");
    const NodeId monitor =
        b.add(std::make_unique<MonitorInputNode>(1, MonitorInputMode::automatic, 0, 1, &gate, kFade), "a.monitor");
    const NodeId other = b.add(std::make_unique<ConstantNode>(1, 0.0f), "b.clips");
    const NodeId latent = b.add(std::make_unique<FakeLatencyNode>(1, kComp), "b.insert");
    const NodeId master = b.add(std::make_unique<BusNode>(1), "master");
    b.connect(clips, monitor);
    b.connectLowLatency(monitor, master, monitor);
    b.connect(other, latent);
    b.connect(latent, master);
    b.setOutput(master);
    auto graph = std::move(b).compile(64);
    REQUIRE(graph->edgeCompensation(monitor, master) == kComp);

    InputBlock input(1, 6'400);
    for (std::size_t i = 0; i < input.data[0].size(); ++i) {
        input.data[0][i] = 1.0f;  // DC input, four times the clips' level
    }
    gate.armed.store(true);
    const auto out = runWithInput(*graph, input, 6'400, 64, true, [&](std::int64_t start) {
        if (start == 640) {
            gate.capturing.store(true);
        } else if (start == 3'200) {
            gate.capturing.store(false);
        }
    });
    CHECK(out[600] == 0.25f);   // the clips, compensated
    CHECK(out[3'000] == 1.0f);  // the input, undelayed
    // From the end of the crossfade back, the compensated path carries what it
    // stored while the input passed: silence, never the input again.
    for (std::int64_t i = 3'200 + kFade; i < 3'200 + kComp; ++i) {
        INFO(i);
        CHECK(out[static_cast<std::size_t>(i)] == 0.0f);
    }
    // The clips come back, faded in rather than stepped in (from frame 200: the
    // line starts silent, so the clips first arrive at frame 100 with a step).
    CHECK(out.back() == 0.25f);
    CHECK(maxStep(std::vector<float>(out.begin() + 200, out.end())) <= 2.0f / static_cast<float>(kFade) + 1e-4f);
}

TEST_CASE("A stopped context silences the clip player", "[graph][monitor][nodes]") {
    auto media = std::make_shared<PlanarAudio>();
    media->channels = 1;
    media->frames = 8;
    media->data = {{1, 1, 1, 1, 1, 1, 1, 1}};
    GraphBuilder b;
    const NodeId player = b.add(
        std::make_unique<ClipPlayerNode>(1, std::vector<ClipPlayerNode::Clip>{{0, 0, 8, 1.0f, media}}), "player");
    b.setOutput(player);
    auto graph = std::move(b).compile(8);
    CHECK_FALSE(graph->monitors());
    ProcessContext stopped{0, 8};
    stopped.rolling = false;
    graph->process(stopped);
    for (int i = 0; i < 8; ++i) {
        CHECK(graph->output().channel(0)[i] == 0.0f);
    }
    graph->process(ProcessContext{0, 8});
    CHECK(graph->output().channel(0)[0] == 1.0f);
}

TEST_CASE("startEdges marks the edges leaving a source, in compile and recompile", "[graph][monitor]") {
    GraphBuilder b;
    const NodeId clips = b.add(std::make_unique<ClipPlayerNode>(1, std::vector<ClipPlayerNode::Clip>{}), "clips");
    const NodeId monitor =
        b.add(std::make_unique<MonitorInputNode>(1, MonitorInputMode::input, 0, 1, nullptr, 4), "monitor");
    const NodeId tape = b.add(std::make_unique<ClipPlayerNode>(1, std::vector<ClipPlayerNode::Clip>{}), "tape");
    const NodeId master = b.add(std::make_unique<BusNode>(1), "master");
    b.connect(clips, monitor);   // edge 0: a source
    b.connect(monitor, master);  // edge 1: carries the monitored input
    b.connect(tape, master);     // edge 2: a source
    b.setOutput(master);
    auto graph = std::move(b).compile(8);
    const std::vector<std::uint8_t> expected{1, 0, 1};
    const auto edges = graph->startEdges();
    CHECK(std::vector<std::uint8_t>(edges.begin(), edges.end()) == expected);
    auto again = graph->recompile();
    const auto recompiled = again->startEdges();
    CHECK(std::vector<std::uint8_t>(recompiled.begin(), recompiled.end()) == expected);
}

// ---- m5b-engine-buses-sends: SendNode ----------------------------------------

namespace {

// One block of a SendNode on a constant input; returns {left, right} per frame.
std::vector<std::array<float, 2>> sendBlock(SendNode& node, int inputChannels, int frames, float left, float right) {
    std::vector<std::vector<float>> in(static_cast<std::size_t>(inputChannels), std::vector<float>(static_cast<std::size_t>(frames)));
    for (int i = 0; i < frames; ++i) {
        in[0][static_cast<std::size_t>(i)] = left;
        if (inputChannels > 1) {
            in[1][static_cast<std::size_t>(i)] = right;
        }
    }
    std::vector<float*> inPtrs;
    for (auto& channel : in) {
        inPtrs.push_back(channel.data());
    }
    std::vector<std::vector<float>> out(2, std::vector<float>(static_cast<std::size_t>(frames)));
    std::vector<float*> outPtrs{out[0].data(), out[1].data()};
    const AudioBufferView input{inPtrs.data(), inputChannels, frames};
    const AudioBufferView output{outPtrs.data(), 2, frames};
    node.process(ProcessContext{0, frames}, std::span<const AudioBufferView>(&input, 1), output);
    std::vector<std::array<float, 2>> frames2;
    for (int i = 0; i < frames; ++i) {
        frames2.push_back({out[0][static_cast<std::size_t>(i)], out[1][static_cast<std::size_t>(i)]});
    }
    return frames2;
}

}  // namespace

TEST_CASE("SendNode scales by its level and upmixes a mono source to both channels at unity", "[nodes][send]") {
    SendNode stereo(2, -6000, true, false);
    CHECK(stereo.inputPorts() == std::vector<int>{2});
    CHECK(stereo.outputChannels() == 2);
    CHECK(stereo.gain() == gainFromMilliDb(-6000));
    const auto s = sendBlock(stereo, 2, 4, 1.0f, -0.5f);
    CHECK(s[3][0] == gainFromMilliDb(-6000));
    CHECK(s[3][1] == -0.5f * gainFromMilliDb(-6000));

    SendNode mono(1, 0, true, false);
    CHECK(mono.inputPorts() == std::vector<int>{1});
    const auto m = sendBlock(mono, 1, 4, 0.25f, 0.0f);
    CHECK(m[0][0] == 0.25f);
    CHECK(m[0][1] == 0.25f);
}

TEST_CASE("SendNode is silent while disabled, while its source is muted or solo-silenced", "[nodes][send]") {
    SendNode disabled(2, 0, false, false);
    CHECK(disabled.gain() == 0.0f);
    disabled.setParameter(SendNode::kEnabled, 1.0, 0);
    CHECK(disabled.gain() == 1.0f);
    disabled.setParameter(SendNode::kSourceMute, 1.0, 0);
    CHECK(disabled.gain() == 0.0f);
    disabled.setParameter(SendNode::kSourceMute, 0.0, 0);
    CHECK(disabled.gain() == 1.0f);

    // Solo silence is not a parameter: neither enabling nor unmuting lifts it.
    SendNode soloSilenced(2, 0, true, false, true);
    CHECK(soloSilenced.gain() == 0.0f);
    soloSilenced.setParameter(SendNode::kSourceMute, 0.0, 0);
    soloSilenced.setParameter(SendNode::kEnabled, 1.0, 0);
    CHECK(soloSilenced.gain() == 0.0f);
    CHECK(sendBlock(soloSilenced, 2, 2, 1.0f, 1.0f)[1][0] == 0.0f);
}

TEST_CASE("SendNode ramps a level change and clamps it into the gain range", "[nodes][send]") {
    SendNode node(2, 0, true, false);
    node.setParameter(SendNode::kLevelMilliDb, static_cast<double>(INT32_MIN), 4);
    const auto ramp = sendBlock(node, 2, 4, 1.0f, 1.0f);
    CHECK(ramp[0][0] == 0.75f);
    CHECK(ramp[1][0] == 0.5f);
    CHECK(ramp[3][0] == 0.0f);  // lands exactly on the target
    node.setParameter(SendNode::kLevelMilliDb, 99'000.0, 0);
    CHECK(node.gain() == gainFromMilliDb(SendNode::kMaxLevelMilliDb));
    node.setParameter(SendNode::kLevelMilliDb, -200'000.0, 0);
    CHECK(node.gain() == gainFromMilliDb(SendNode::kMinLevelMilliDb));
    node.setParameter(SendNode::kLevelMilliDb, std::nan(""), 0);
    CHECK(node.gain() == gainFromMilliDb(SendNode::kMinLevelMilliDb));
    node.setParameter(99, 0.0, 0);  // an unknown parameter changes nothing
    CHECK(node.gain() == gainFromMilliDb(SendNode::kMinLevelMilliDb));
}

// ---- m5b-engine-clip-fades: the clip player's fade gain ----------------------

namespace {

constexpr double kHalfPi = 1.57079632679489661923;

// The architecture spec's curve, recomputed here in double ("siann-graph and
// siann-engine", clip fades): g(n) = in(n) * out(n).
double curveRef(FadeCurve curve, double x) {
    return curve == FadeCurve::linear ? x : std::sin(x * kHalfPi);
}

double fadeRef(const ClipFade& fade, std::int64_t n, std::int64_t length) {
    double g = 1.0;
    if (n < fade.inLength) {
        g *= curveRef(fade.inCurve, static_cast<double>(n) / static_cast<double>(fade.inLength));
    }
    const std::int64_t m = length - 1 - n;
    if (m < fade.outLength) {
        g *= curveRef(fade.outCurve, static_cast<double>(m) / static_cast<double>(fade.outLength));
    }
    return g;
}

std::shared_ptr<PlanarAudio> rampMedia(std::int64_t frames) {
    auto media = std::make_shared<PlanarAudio>();
    media->channels = 1;
    media->frames = frames;
    media->data.assign(1, std::vector<float>(static_cast<std::size_t>(frames)));
    for (std::int64_t i = 0; i < frames; ++i) {
        media->data[0][static_cast<std::size_t>(i)] = 0.25f + 0.5f * static_cast<float>(i % 13) / 13.0f;
    }
    return media;
}

// One faded clip of `length` frames at timeline 3 (sourceStart 2), rendered from 0.
std::vector<float> renderFaded(const ClipFade& fade, std::int64_t length, float gain, int block,
                               const std::shared_ptr<PlanarAudio>& media) {
    ClipPlayerNode::Clip clip{3, 2, length, gain, media};
    clip.fade = fade;
    GraphBuilder b;
    const NodeId player = b.add(std::make_unique<ClipPlayerNode>(2, std::vector<ClipPlayerNode::Clip>{clip}), "player");
    b.setOutput(player);
    auto graph = std::move(b).compile(512);
    return run(*graph, length + 10, block);
}

}  // namespace

TEST_CASE("ClipPlayerNode applies the fade formula per sample, both curves, in and out", "[nodes][fades]") {
    struct Case {
        ClipFade fade;
        std::int64_t length;
    };
    const auto L = FadeCurve::linear;
    const auto E = FadeCurve::equal_power;
    const std::vector<Case> cases = {
        {{1, L, 0, L}, 40},   {{0, L, 1, E}, 40},     {{2, E, 2, L}, 40},     {{7, L, 9, E}, 41},
        {{9, E, 0, L}, 40},   {{0, L, 13, L}, 40},    {{20, L, 20, E}, 40},   {{21, E, 20, E}, 41},
        {{41, E, 0, L}, 41},  {{0, L, 41, L}, 41},    {{1, E, 1, E}, 2},
    };
    const auto media = rampMedia(64);
    const float gain = 0.70710677f;
    for (const Case& c : cases) {
        INFO("in " << c.fade.inLength << " out " << c.fade.outLength << " length " << c.length);
        const auto out = renderFaded(c.fade, c.length, gain, 64, media);
        double worst = 0.0;
        for (std::int64_t t = 0; t < static_cast<std::int64_t>(out.size()); ++t) {
            const std::int64_t n = t - 3;
            double expected = 0.0;
            if (n >= 0 && n < c.length) {
                const double m = media->data[0][static_cast<std::size_t>(n + 2)];
                expected = m * static_cast<double>(gain) * fadeRef(c.fade, n, c.length);
            }
            worst = std::max(worst, std::abs(static_cast<double>(out[static_cast<std::size_t>(t)]) - expected));
        }
        CHECK(worst <= 1.0 / 16'777'216.0);  // 2^-24: one float rounding of a value below 1
        // The first frame of a fade in and the last of a fade out are silent.
        if (c.fade.inLength > 0) {
            CHECK(out[3] == 0.0f);
        }
        if (c.fade.outLength > 0) {
            CHECK(out[static_cast<std::size_t>(3 + c.length - 1)] == 0.0f);
        }
    }
}

TEST_CASE("fadeGain is exactly 1 outside the fades, so those samples are the unfaded ones", "[nodes][fades]") {
    const ClipFade fade{100, FadeCurve::equal_power, 50, FadeCurve::linear};
    CHECK(fadeGain(fade, 100, 1'000) == 1.0f);
    CHECK(fadeGain(fade, 949, 1'000) == 1.0f);
    CHECK(fadeGain(fade, 99, 1'000) < 1.0f);
    CHECK(fadeGain(fade, 950, 1'000) < 1.0f);
    CHECK(fadeGain(ClipFade{}, 0, 1) == 1.0f);
    const auto media = rampMedia(64);
    const auto plain = renderFaded(ClipFade{}, 40, 0.5f, 64, media);
    const auto faded = renderFaded(ClipFade{5, FadeCurve::linear, 6, FadeCurve::equal_power}, 40, 0.5f, 64, media);
    for (std::size_t t = 3 + 5; t < 3 + 40 - 6; ++t) {
        INFO(t);
        CHECK(faded[t] == plain[t]);
    }
}

TEST_CASE("A faded clip renders the same for any block size", "[nodes][fades]") {
    const auto media = rampMedia(1'000);
    const ClipFade fade{333, FadeCurve::equal_power, 401, FadeCurve::linear};
    const auto reference = renderFaded(fade, 900, 0.9f, 512, media);
    for (const int block : {1, 7, 64}) {
        INFO(block);
        CHECK(renderFaded(fade, 900, 0.9f, block, media) == reference);
    }
}
