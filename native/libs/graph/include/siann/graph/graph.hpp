#pragma once

// The processing graph (architecture spec, "Realtime data flow" and "Latency
// model"). A GraphBuilder collects nodes and edges; compile() checks the graph,
// orders it, computes plugin delay compensation and preallocates every buffer.
// PreparedGraph::process() then runs without allocating, locking or throwing.
//
// Latency: a node's arrival latency is the maximum output latency over all of
// its incoming edges (across every input port, so sidechain inputs line up with
// the main input); its output latency adds its own reported latency. Every
// edge is delayed by arrival(destination) - output(source). Summation follows
// edge insertion order, so results are deterministic.
//
// A node whose reported latency changes after compile (a plugin's
// pluginEventRt for built-in nodes) is reported through a preallocated
// realtime outbox: process() compares each node's latency() with what it last
// reported and pushes one LatencyChange per change. The graph's compensation
// stays as compiled; the control side answers with recompile().
//
// recompile() is the latency model's "recompile with state migration": the
// new graph shares every node instance and every compensation delay line
// whose length is unchanged with the graph it came from, rebuilds only the
// delay lines whose compensation changed, and marks the affected edges (those
// with a rebuilt delay line or leaving a node whose latency changed). The
// graph driver ramps only those edges around the swap. Exactly one of the two
// graphs is processed per block, so shared instances are never processed
// twice; whichever graph is destroyed last frees them, on the control side.

#include <array>
#include <cstdint>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

#include "siann/host/buffer.hpp"

namespace siann::graph {

using host::AudioBufferView;

struct ProcessContext {
    std::int64_t blockStart = 0;  // timeline position of the first frame, in samples
    int frames = 0;
};

class Node {
public:
    virtual ~Node() = default;

    // Channel count of each input port (empty for sources).
    virtual std::vector<int> inputPorts() const { return {}; }
    virtual int outputChannels() const = 0;
    virtual std::int64_t latency() const { return 0; }

    // Non-realtime: allocate whatever process() needs.
    virtual void prepare(int maxBlockFrames) { (void)maxBlockFrames; }

    // inputs[i] holds the aligned sum of everything connected to port i.
    virtual void process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                         const AudioBufferView& output) noexcept = 0;

    // Audio thread, between blocks: moves a parameter to value over rampFrames
    // (0 = immediately). Unknown parameter IDs are ignored.
    virtual void setParameter(std::uint32_t paramId, double value, int rampFrames) noexcept {
        (void)paramId;
        (void)value;
        (void)rampFrames;
    }

    // Audio thread, between blocks: the transport jumped to `position` for the
    // locate with `generation` (revision 3.1, "Locate").
    virtual void onLocate(std::uint64_t generation, std::int64_t position) noexcept {
        (void)generation;
        (void)position;
    }
};

class GraphError : public std::runtime_error {
public:
    GraphError(std::string code, const std::string& message);

    // One of: unknown_node, invalid_port, channel_mismatch, cycle, no_output,
    // compensation_limit, invalid_block_size.
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

using NodeId = std::size_t;

// Channels a meter reports; wider nodes report their first channels.
inline constexpr int kMaxMeterChannels = 2;

// Peak and RMS of one block, per channel. Fixed size, so it travels through
// the realtime queues without allocating. channels == 0 means no reading.
struct MeterReading {
    int channels = 0;
    std::array<float, kMaxMeterChannels> peak{};
    std::array<float, kMaxMeterChannels> rms{};
};

class PreparedGraph;

// A node of a compiled graph now reports `latency` (audio thread to control side).
struct LatencyChange {
    NodeId slot = 0;
    std::int64_t latency = 0;
};

// A duck-and-swap ramp on some edges of a graph (revision 3.1, "Publishing
// and retiring graphs"). At frame i of the block, with r = max(remaining - i, 0),
// a ramped edge's gain is min(r, fadeFrames) / fadeFrames while ducking and
// 1 - min(r, fadeFrames) / fadeFrames while rising, so a rise with remaining
// above fadeFrames first holds the edges at zero. `edges` is indexed like the
// graph's edges (rampedEdges() of a recompiled graph fits the graph it was
// recompiled from); an empty or mismatched mask ramps nothing.
struct EdgeRamp {
    std::span<const std::uint8_t> edges;
    int fadeFrames = 0;
    int remaining = 0;
    bool rising = false;
};

class GraphBuilder {
public:
    NodeId add(std::unique_ptr<Node> node, std::string name);
    // Sums the source's output, times gain, into the destination's input port.
    void connect(NodeId from, NodeId to, int port = 0, float gain = 1.0f);
    void setOutput(NodeId node);

    // Default limit on any single edge's compensation delay, in samples.
    static constexpr std::int64_t kDefaultCompensationLimit = std::int64_t{1} << 20;

    std::unique_ptr<PreparedGraph> compile(int maxBlockFrames,
                                           std::int64_t compensationLimit = kDefaultCompensationLimit) &&;

private:
    struct EdgeSpec {
        NodeId from;
        NodeId to;
        int port;
        float gain;
    };
    std::vector<std::unique_ptr<Node>> nodes_;
    std::vector<std::string> names_;
    std::vector<EdgeSpec> edges_;
    NodeId output_ = static_cast<NodeId>(-1);
};

class PreparedGraph {
public:
    ~PreparedGraph();
    PreparedGraph(const PreparedGraph&) = delete;
    PreparedGraph& operator=(const PreparedGraph&) = delete;

    // Processes one block of at most maxBlockFrames frames.
    void process(const ProcessContext& context) noexcept;
    // The same, with the edges in `ramp` scaled by its gain.
    void process(const ProcessContext& context, const EdgeRamp& ramp) noexcept;

    // Control side: a new graph for the nodes' current latencies, migrating
    // state (see the header comment). Safe while this graph is live on the
    // audio thread: it reads only compiled data and each node's latency().
    // Throws GraphError("compensation_limit") like compile().
    std::unique_ptr<PreparedGraph> recompile() const;

    // The graph this one was recompiled from (nullptr after compile()).
    // Only for identity checks: that graph may have been destroyed.
    const PreparedGraph* recompiledFrom() const noexcept;
    // Per edge, 1 when a recompile changed it (empty after compile()).
    std::span<const std::uint8_t> rampedEdges() const noexcept;
    bool edgeRamped(NodeId from, NodeId to, int port = 0) const noexcept;
    // Frames after the swap until every rebuilt delay line has filled and its
    // signal reached the output: the affected edges stay at zero that long.
    std::int64_t settleFrames() const noexcept;
    // The node instance in a slot (nullptr for an unknown slot).
    const Node* nodeAt(NodeId slot) const noexcept;

    // The output node's buffer after process().
    const AudioBufferView& output() const noexcept;
    int outputChannels() const noexcept;
    int maxBlockFrames() const noexcept;

    // Output latency of the output node: how far its signal trails the timeline.
    std::int64_t totalLatency() const noexcept;

    // Compensation delay applied on the edge from -> to at port; -1 if absent.
    std::int64_t edgeCompensation(NodeId from, NodeId to, int port = 0) const noexcept;
    std::int64_t outputLatency(NodeId node) const noexcept;

    // Audio thread, between blocks. Ignored for an unknown node.
    void setParameter(NodeId node, std::uint32_t paramId, double value, int rampFrames) noexcept;
    // Audio thread, between blocks: tells every node about a locate.
    void locate(std::uint64_t generation, std::int64_t position) noexcept;
    std::size_t nodeCount() const noexcept;

    // Every MeterNode, in schedule order.
    std::span<const NodeId> meteredNodes() const noexcept;
    // The reading of a MeterNode after process(); empty for any other node.
    MeterReading meterReading(NodeId node) const noexcept;
    // Control side: the next latency change reported by process(), oldest
    // first. Single consumer; the thread that calls process() is the producer.
    // Each change is reported once; while a node's change waits here, its
    // later changes coalesce and the newest follows once this one is taken.
    bool popLatencyChange(LatencyChange& change) noexcept;

private:
    friend class GraphBuilder;
    struct Impl;
    explicit PreparedGraph(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::graph
