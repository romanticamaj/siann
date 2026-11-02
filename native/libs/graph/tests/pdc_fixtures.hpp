#pragma once

// PDC null-test topologies shared by the offline graph tests (siann-graph) and
// the realtime driver tests (siann-realtime). Each builder returns the
// GraphBuilder before compilation plus the node IDs a test needs, so the same
// recipe can be compiled more than once (fresh state each time).
//
// Every FakeLatency node is built with maxLatency = max(its latency,
// maxLatency), so a test can raise its latency at runtime without allocating.

#include <algorithm>
#include <cstdint>
#include <memory>
#include <span>
#include <utility>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"

namespace siann::graph::pdc {

// A deterministic noise source: every sample differs, so a misaligned null
// test cannot cancel by accident.
class NoiseNode final : public Node {
public:
    explicit NoiseNode(int channels) : channels_(channels) {}

    // The value at timeline sample `t` on `channel`.
    static float sample(int channel, std::int64_t t) noexcept {
        const auto n = static_cast<std::uint64_t>(t) * 2654435761u + static_cast<unsigned>(channel) * 97u;
        return static_cast<float>((n % 2001u)) / 1000.0f - 1.0f;
    }

    int outputChannels() const override { return channels_; }
    void process(const ProcessContext& context, std::span<const AudioBufferView>,
                 const AudioBufferView& output) noexcept override {
        for (int c = 0; c < channels_; ++c) {
            for (int i = 0; i < context.frames; ++i) {
                output.channel(c)[i] = sample(c, context.blockStart + i);
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

struct EdgeRef {
    NodeId from = 0;
    NodeId to = 0;
    int port = 0;
};

// What every topology has in common.
struct Built {
    GraphBuilder builder;
    NodeId output = 0;
    int channels = 0;
    // The FakeLatency node a latency-change test retunes. The pointer stays
    // valid while the builder, then the compiled graph, owns the node.
    NodeId changing = 0;
    FakeLatencyNode* changingNode = nullptr;
    // An edge whose compensation depends on the changing node's latency.
    EdgeRef compensated;
};

inline FakeLatencyNode* addLatency(GraphBuilder& builder, NodeId& id, int channels, std::int64_t samples,
                                   std::int64_t maxLatency, const char* name) {
    auto node = std::make_unique<FakeLatencyNode>(channels, samples, std::max(samples, maxLatency));
    FakeLatencyNode* raw = node.get();
    id = builder.add(std::move(node), name);
    return raw;
}

// source -> latency -> master, plus source -> master (dryGain; -1 nulls).
struct Direct : Built {
    NodeId source = 0;
    NodeId delayed = 0;
    NodeId master = 0;
};

inline Direct buildDirect(std::int64_t latency, std::int64_t maxLatency = 0, float dryGain = -1.0f) {
    Direct d;
    d.source = d.builder.add(std::make_unique<NoiseNode>(1), "source");
    d.changingNode = addLatency(d.builder, d.delayed, 1, latency, maxLatency, "latency");
    d.master = d.builder.add(std::make_unique<BusNode>(1), "master");
    d.builder.connect(d.source, d.delayed);
    d.builder.connect(d.delayed, d.master);
    d.builder.connect(d.source, d.master, 0, dryGain);  // the dry path
    d.builder.setOutput(d.master);
    d.output = d.master;
    d.channels = 1;
    d.changing = d.delayed;
    d.compensated = EdgeRef{d.source, d.master, 0};
    return d;
}

// Stereo: track -> insert -> master (post-insert main path) and a pre-insert
// send (sendGain; -1 nulls) into an aux bus with its own insert. The aux
// insert is the changing node.
struct Send : Built {
    NodeId source = 0;
    NodeId insert = 0;
    NodeId aux = 0;
    NodeId auxInsert = 0;
    NodeId master = 0;
};

inline Send buildSend(std::int64_t insertLatency, std::int64_t auxLatency, std::int64_t maxLatency = 0,
                      float sendGain = -1.0f) {
    Send s;
    s.source = s.builder.add(std::make_unique<NoiseNode>(2), "track");
    addLatency(s.builder, s.insert, 2, insertLatency, maxLatency, "insert");
    s.aux = s.builder.add(std::make_unique<BusNode>(2), "aux");
    s.changingNode = addLatency(s.builder, s.auxInsert, 2, auxLatency, maxLatency, "aux insert");
    s.master = s.builder.add(std::make_unique<BusNode>(2), "master");
    s.builder.connect(s.source, s.insert);
    s.builder.connect(s.insert, s.master);             // main path
    s.builder.connect(s.source, s.aux, 0, sendGain);   // pre-insert send
    s.builder.connect(s.aux, s.auxInsert);
    s.builder.connect(s.auxInsert, s.master);          // aux return
    s.builder.setOutput(s.master);
    s.output = s.master;
    s.channels = 2;
    s.changing = s.auxInsert;
    s.compensated = EdgeRef{s.insert, s.master, 0};
    return s;
}

// Mono, nested aux buses at different depths: source -> a -> bus1 -> c ->
// bus2 (+ half the dry source) -> master, and source -> d -> master at -1.5,
// which cancels the 1.0 + 0.5 copies. c is the changing node.
struct Nested : Built {
    NodeId source = 0;
    NodeId a = 0;
    NodeId bus1 = 0;
    NodeId c = 0;
    NodeId bus2 = 0;
    NodeId d = 0;
    NodeId master = 0;
};

inline Nested buildNested(std::int64_t aLatency, std::int64_t cLatency, std::int64_t dLatency,
                          std::int64_t maxLatency = 0) {
    Nested n;
    n.source = n.builder.add(std::make_unique<NoiseNode>(1), "source");
    addLatency(n.builder, n.a, 1, aLatency, maxLatency, "a");
    n.bus1 = n.builder.add(std::make_unique<BusNode>(1), "bus1");
    n.changingNode = addLatency(n.builder, n.c, 1, cLatency, maxLatency, "c");
    n.bus2 = n.builder.add(std::make_unique<BusNode>(1), "bus2");
    addLatency(n.builder, n.d, 1, dLatency, maxLatency, "d");
    n.master = n.builder.add(std::make_unique<BusNode>(1), "master");
    n.builder.connect(n.source, n.a);
    n.builder.connect(n.a, n.bus1);
    n.builder.connect(n.bus1, n.c);
    n.builder.connect(n.c, n.bus2);
    n.builder.connect(n.source, n.bus2, 0, 0.5f);
    n.builder.connect(n.bus2, n.master);
    n.builder.connect(n.source, n.d);
    n.builder.connect(n.d, n.master, 0, -1.5f);
    n.builder.setOutput(n.master);
    n.output = n.master;
    n.channels = 1;
    n.changing = n.c;
    n.compensated = EdgeRef{n.source, n.bus2, 0};
    return n;
}

// Stereo: source -> insert -> compressor main input, source -> compressor
// sidechain key (port 1). The compressor outputs main minus key.
struct Sidechain : Built {
    NodeId source = 0;
    NodeId insert = 0;
    NodeId comp = 0;
};

inline Sidechain buildSidechain(std::int64_t latency, std::int64_t maxLatency = 0) {
    Sidechain s;
    s.source = s.builder.add(std::make_unique<NoiseNode>(2), "source");
    s.changingNode = addLatency(s.builder, s.insert, 2, latency, maxLatency, "insert");
    s.comp = s.builder.add(std::make_unique<DifferenceNode>(2), "compressor");
    s.builder.connect(s.source, s.insert);
    s.builder.connect(s.insert, s.comp, 0);  // main input
    s.builder.connect(s.source, s.comp, 1);  // sidechain key, undelayed at the source
    s.builder.setOutput(s.comp);
    s.output = s.comp;
    s.channels = 2;
    s.changing = s.insert;
    s.compensated = EdgeRef{s.source, s.comp, 1};
    return s;
}

inline std::unique_ptr<PreparedGraph> compile(Built&& built, int maxBlockFrames) {
    return std::move(built.builder).compile(maxBlockFrames);
}

}  // namespace siann::graph::pdc
