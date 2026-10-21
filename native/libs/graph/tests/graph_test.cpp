#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <memory>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"

using namespace siann::graph;

namespace {

// A deterministic noise source: every sample differs, so a misaligned null
// test cannot cancel by accident.
class NoiseNode final : public Node {
public:
    explicit NoiseNode(int channels) : channels_(channels) {}
    int outputChannels() const override { return channels_; }
    void process(const ProcessContext& context, std::span<const AudioBufferView>,
                 const AudioBufferView& output) noexcept override {
        for (int c = 0; c < channels_; ++c) {
            for (int i = 0; i < context.frames; ++i) {
                const auto n = static_cast<std::uint64_t>(context.blockStart + i) * 2654435761u + static_cast<unsigned>(c) * 97u;
                output.channel(c)[i] = static_cast<float>((n % 2001u)) / 1000.0f - 1.0f;
            }
        }
    }

private:
    int channels_;
};

// Two input ports: output = port 0 minus port 1. Stands in for a sidechain.
class DifferenceNode final : public Node {
public:
    explicit DifferenceNode(int channels) : channels_(channels) {}
    std::vector<int> inputPorts() const override { return {channels_, channels_}; }
    int outputChannels() const override { return channels_; }
    void process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                 const AudioBufferView& output) noexcept override {
        for (int c = 0; c < channels_; ++c) {
            for (int i = 0; i < context.frames; ++i) {
                output.channel(c)[i] = inputs[0].channel(c)[i] - inputs[1].channel(c)[i];
            }
        }
    }

private:
    int channels_;
};

// Renders the graph block by block and returns channel 0.
std::vector<float> run(PreparedGraph& graph, std::int64_t frames, int block) {
    std::vector<float> out;
    for (std::int64_t start = 0; start < frames; start += block) {
        const int n = static_cast<int>(std::min<std::int64_t>(block, frames - start));
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
    GraphBuilder b;
    const NodeId source = b.add(std::make_unique<NoiseNode>(1), "source");
    const NodeId delayed = b.add(std::make_unique<FakeLatencyNode>(1, 100), "latency");
    const NodeId master = b.add(std::make_unique<BusNode>(1), "master");
    b.connect(source, delayed);
    b.connect(delayed, master);
    b.connect(source, master, 0, -1.0f);  // inverted dry path
    b.setOutput(master);
    auto graph = std::move(b).compile(64);

    CHECK(graph->edgeCompensation(source, master) == 100);
    CHECK(graph->edgeCompensation(delayed, master) == 0);
    CHECK(graph->totalLatency() == 100);
    CHECK(allZero(run(*graph, 5'000, 64)));
}

TEST_CASE("PDC null test: a send to an aux bus with its own latency", "[graph][pdc]") {
    GraphBuilder b;
    const NodeId source = b.add(std::make_unique<NoiseNode>(2), "track");
    const NodeId insert = b.add(std::make_unique<FakeLatencyNode>(2, 64), "insert");
    const NodeId aux = b.add(std::make_unique<BusNode>(2), "aux");
    const NodeId auxInsert = b.add(std::make_unique<FakeLatencyNode>(2, 256), "aux insert");
    const NodeId master = b.add(std::make_unique<BusNode>(2), "master");
    b.connect(source, insert);
    b.connect(insert, master);                 // post-insert main path, latency 64
    b.connect(source, aux, 0, -1.0f);          // pre-insert send, inverted
    b.connect(aux, auxInsert);
    b.connect(auxInsert, master);              // aux return, latency 256
    b.setOutput(master);
    auto graph = std::move(b).compile(128);

    CHECK(graph->edgeCompensation(insert, master) == 192);
    CHECK(graph->edgeCompensation(auxInsert, master) == 0);
    CHECK(graph->totalLatency() == 256);
    CHECK(allZero(run(*graph, 4'096, 128)));
}

TEST_CASE("PDC null test: nested aux buses at different depths", "[graph][pdc]") {
    GraphBuilder b;
    const NodeId source = b.add(std::make_unique<NoiseNode>(1), "source");
    const NodeId a = b.add(std::make_unique<FakeLatencyNode>(1, 10), "a");
    const NodeId bus1 = b.add(std::make_unique<BusNode>(1), "bus1");
    const NodeId c = b.add(std::make_unique<FakeLatencyNode>(1, 33), "c");
    const NodeId bus2 = b.add(std::make_unique<BusNode>(1), "bus2");
    const NodeId d = b.add(std::make_unique<FakeLatencyNode>(1, 7), "d");
    const NodeId master = b.add(std::make_unique<BusNode>(1), "master");
    b.connect(source, a);
    b.connect(a, bus1);
    b.connect(bus1, c);
    b.connect(c, bus2);
    b.connect(source, bus2, 0, 0.5f);
    b.connect(bus2, master);          // 43 + half the dry signal, aligned
    b.connect(source, d);
    b.connect(d, master, 0, -1.5f);   // cancels 1.0 + 0.5 of the source
    b.setOutput(master);
    auto graph = std::move(b).compile(32);

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
    GraphBuilder b;
    const NodeId source = b.add(std::make_unique<NoiseNode>(2), "source");
    const NodeId insert = b.add(std::make_unique<FakeLatencyNode>(2, 300), "insert");
    const NodeId comp = b.add(std::make_unique<DifferenceNode>(2), "compressor");
    b.connect(source, insert);
    b.connect(insert, comp, 0);  // main input
    b.connect(source, comp, 1);  // sidechain key, undelayed at the source
    b.setOutput(comp);
    auto graph = std::move(b).compile(100);

    CHECK(graph->edgeCompensation(source, comp, 1) == 300);
    CHECK(allZero(run(*graph, 3'000, 100)));
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
