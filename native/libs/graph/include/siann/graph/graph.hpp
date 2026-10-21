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

class PreparedGraph;

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

    // The output node's buffer after process().
    const AudioBufferView& output() const noexcept;
    int outputChannels() const noexcept;
    int maxBlockFrames() const noexcept;

    // Output latency of the output node: how far its signal trails the timeline.
    std::int64_t totalLatency() const noexcept;

    // Compensation delay applied on the edge from -> to at port; -1 if absent.
    std::int64_t edgeCompensation(NodeId from, NodeId to, int port = 0) const noexcept;
    std::int64_t outputLatency(NodeId node) const noexcept;

private:
    friend class GraphBuilder;
    struct Impl;
    explicit PreparedGraph(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::graph
