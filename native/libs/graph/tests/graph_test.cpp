#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <memory>
#include <stdexcept>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "pdc_fixtures.hpp"

using namespace siann::graph;
using pdc::DifferenceNode;
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
