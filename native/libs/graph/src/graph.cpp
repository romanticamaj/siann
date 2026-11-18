#include "siann/graph/graph.hpp"

#include <algorithm>
#include <atomic>
#include <queue>
#include <utility>

#include "siann/graph/nodes.hpp"

#include "siann/rt/spsc_queue.hpp"

namespace siann::graph {

GraphError::GraphError(std::string code, const std::string& message)
    : std::runtime_error(message), code_(std::move(code)) {}

namespace {

// Planar storage for one buffer, with a stable pointer table for the view.
struct Storage {
    std::vector<std::vector<float>> data;
    std::vector<float*> pointers;
    AudioBufferView view;

    void allocate(int channels, int frames) {
        data.assign(static_cast<std::size_t>(channels), std::vector<float>(static_cast<std::size_t>(frames), 0.0f));
        pointers.resize(static_cast<std::size_t>(channels));
        for (int c = 0; c < channels; ++c) {
            pointers[static_cast<std::size_t>(c)] = data[static_cast<std::size_t>(c)].data();
        }
        view = AudioBufferView{pointers.data(), channels, frames};
    }

    AudioBufferView sized(int frames) const noexcept { return AudioBufferView{view.channels, view.channelCount, frames}; }
};

// A per-edge delay line used for compensation. Shared between a graph and
// the graphs recompiled from it while its length is unchanged.
struct DelayLine {
    std::vector<std::vector<float>> ring;
    std::size_t position = 0;
    // A low-latency edge's weight on what it stores (m5b-engine-monitoring):
    // 0 while its monitor passes any input, so the line never holds the input,
    // then back to 1 over the monitor's fade, so the clips return without a step.
    float resume = 1.0f;

    DelayLine(int channels, std::int64_t delay)
        : ring(static_cast<std::size_t>(channels), std::vector<float>(static_cast<std::size_t>(delay), 0.0f)) {}
};

// The gain of a ramped edge at frame i of the block (see EdgeRamp).
float rampGain(const EdgeRamp& ramp, int i) noexcept {
    const int r = std::min(std::max(ramp.remaining - i, 0), ramp.fadeFrames);
    const float level = static_cast<float>(r) / static_cast<float>(ramp.fadeFrames);
    return ramp.rising ? 1.0f - level : level;
}

}  // namespace

struct PreparedGraph::Impl {
    struct Edge {
        std::size_t from;
        std::size_t to;
        int port;
        float gain;
        std::int64_t compensation;
        std::shared_ptr<DelayLine> delay;  // null without compensation
        // The low-latency edge's MonitorInputNode (shared with recompiled graphs).
        const MonitorInputNode* monitor = nullptr;
    };
    struct NodeState {
        std::shared_ptr<Node> node;  // shared with recompiled graphs
        std::string name;
        std::vector<Storage> inputs;
        std::vector<AudioBufferView> inputViews;  // resized views, rebuilt per block
        Storage output;
        std::vector<std::size_t> incoming;  // edge indexes in insertion order
        std::int64_t outputLatency = 0;
        const MeterNode* meter = nullptr;  // set at compile time for a MeterNode
        std::int64_t compiledLatency = 0;  // node->latency() when compiled
        std::int64_t reportedLatency = 0;  // the latest latency pushed to the outbox
    };

    std::vector<NodeState> nodes;
    std::vector<Edge> edges;
    std::vector<std::size_t> order;
    std::size_t outputNode = 0;
    int maxBlock = 0;
    std::int64_t compensationLimit = 0;
    AudioBufferView outputView;
    std::vector<NodeId> meters;  // MeterNodes in schedule order
    bool monitoring = false;     // a node is a MonitorInputNode
    // Set by recompile() only.
    const PreparedGraph* recompiledFrom = nullptr;
    std::vector<std::uint8_t> ramped;
    std::vector<std::uint8_t> held;  // holdEdges() output, preallocated
    std::int64_t settle = 0;
    std::vector<std::uint8_t> start;  // startEdges(): edges leaving a source
    // Audio thread -> control side. latencyQueued[n] is set while node n has
    // a change in the outbox, so the outbox holds at most one per node and
    // never fills.
    std::unique_ptr<rt::SpscQueue<LatencyChange>> latencyOutbox;
    std::unique_ptr<std::atomic<bool>[]> latencyQueued;

    // Latency and compensation in topological order, from each node's
    // current latency().
    void computeLatency() {
        for (const std::size_t n : order) {
            auto& state = nodes[n];
            std::int64_t arrival = 0;
            for (const std::size_t e : state.incoming) {
                arrival = std::max(arrival, nodes[edges[e].from].outputLatency);
            }
            for (const std::size_t e : state.incoming) {
                auto& edge = edges[e];
                edge.compensation = arrival - nodes[edge.from].outputLatency;
                if (edge.compensation > compensationLimit) {
                    throw GraphError("compensation_limit", "edge '" + nodes[edge.from].name + "' -> '" + state.name +
                                                               "' needs " + std::to_string(edge.compensation) +
                                                               " samples of compensation, above the limit");
                }
            }
            state.compiledLatency = state.node->latency();
            state.reportedLatency = state.compiledLatency;
            state.outputLatency = arrival + state.compiledLatency;
        }
    }

    // This graph's own buffers (never shared); prepares the nodes when asked.
    void allocateBuffers(bool prepareNodes) {
        for (auto& state : nodes) {
            const auto ports = state.node->inputPorts();
            state.inputs.resize(ports.size());
            state.inputViews.resize(ports.size());
            for (std::size_t p = 0; p < ports.size(); ++p) {
                state.inputs[p].allocate(ports[p], maxBlock);
            }
            state.output.allocate(state.node->outputChannels(), maxBlock);
            if (prepareNodes) {
                state.node->prepare(maxBlock);
            }
        }
        outputView = nodes[outputNode].output.view;
        latencyOutbox = std::make_unique<rt::SpscQueue<LatencyChange>>(nodes.size());
        latencyQueued = std::make_unique<std::atomic<bool>[]>(nodes.size());
    }

    // Lists every MeterNode in schedule order, whether the graph monitors and
    // the edges leaving a source.
    void listMeters() {
        meters.clear();
        monitoring = false;
        for (const std::size_t n : order) {
            auto& state = nodes[n];
            state.meter = dynamic_cast<const MeterNode*>(state.node.get());
            if (state.meter != nullptr) {
                meters.push_back(n);
            }
            monitoring = monitoring || dynamic_cast<const MonitorInputNode*>(state.node.get()) != nullptr;
        }
        start.assign(edges.size(), 0);
        for (std::size_t e = 0; e < edges.size(); ++e) {
            start[e] = nodes[edges[e].from].node->inputPorts().empty() ? 1 : 0;
        }
    }

    std::shared_ptr<DelayLine> newDelay(const Edge& edge) const {
        if (edge.compensation <= 0) {
            return nullptr;
        }
        return std::make_shared<DelayLine>(nodes[edge.from].node->outputChannels(), edge.compensation);
    }
};

NodeId GraphBuilder::add(std::unique_ptr<Node> node, std::string name) {
    nodes_.push_back(std::move(node));
    names_.push_back(std::move(name));
    return nodes_.size() - 1;
}

void GraphBuilder::connect(NodeId from, NodeId to, int port, float gain) {
    if (from >= nodes_.size() || to >= nodes_.size()) {
        throw GraphError("unknown_node", "connect refers to a node that was not added");
    }
    edges_.push_back(EdgeSpec{from, to, port, gain, kNoMonitor});
}

void GraphBuilder::connectLowLatency(NodeId from, NodeId to, NodeId monitor, int port, float gain) {
    if (from >= nodes_.size() || to >= nodes_.size() || monitor >= nodes_.size()) {
        throw GraphError("unknown_node", "connectLowLatency refers to a node that was not added");
    }
    edges_.push_back(EdgeSpec{from, to, port, gain, monitor});
}

void GraphBuilder::setOutput(NodeId node) {
    if (node >= nodes_.size()) {
        throw GraphError("unknown_node", "the output node was not added");
    }
    output_ = node;
}

std::unique_ptr<PreparedGraph> GraphBuilder::compile(int maxBlockFrames, std::int64_t compensationLimit) && {
    if (maxBlockFrames <= 0) {
        throw GraphError("invalid_block_size", "the maximum block size must be positive");
    }
    if (output_ >= nodes_.size()) {
        throw GraphError("no_output", "the graph has no output node");
    }
    auto impl = std::make_unique<PreparedGraph::Impl>();
    impl->maxBlock = maxBlockFrames;
    impl->outputNode = output_;
    impl->compensationLimit = compensationLimit;

    const std::size_t count = nodes_.size();
    impl->nodes.resize(count);
    for (std::size_t i = 0; i < count; ++i) {
        impl->nodes[i].node = std::move(nodes_[i]);
        impl->nodes[i].name = names_[i];
    }

    for (const EdgeSpec& spec : edges_) {
        auto& dst = impl->nodes[spec.to];
        const auto ports = dst.node->inputPorts();
        if (spec.port < 0 || static_cast<std::size_t>(spec.port) >= ports.size()) {
            throw GraphError("invalid_port", "edge into '" + dst.name + "' uses a port it does not have");
        }
        if (ports[static_cast<std::size_t>(spec.port)] != impl->nodes[spec.from].node->outputChannels()) {
            throw GraphError("channel_mismatch", "edge '" + impl->nodes[spec.from].name + "' -> '" + dst.name +
                                                     "' connects different channel counts");
        }
        const MonitorInputNode* monitor = nullptr;
        if (spec.monitor != kNoMonitor) {
            monitor = dynamic_cast<const MonitorInputNode*>(impl->nodes[spec.monitor].node.get());
            if (monitor == nullptr) {
                throw GraphError("not_a_monitor", "the low-latency edge into '" + dst.name + "' names '" +
                                                      impl->nodes[spec.monitor].name + "', not a monitor input");
            }
        }
        impl->nodes[spec.to].incoming.push_back(impl->edges.size());
        impl->edges.push_back(
            PreparedGraph::Impl::Edge{spec.from, spec.to, spec.port, spec.gain, 0, nullptr, monitor});
    }

    // Kahn's algorithm with the lowest node id first, for a deterministic order.
    std::vector<std::size_t> pending(count, 0);
    for (const auto& edge : impl->edges) {
        ++pending[edge.to];
    }
    std::priority_queue<std::size_t, std::vector<std::size_t>, std::greater<>> ready;
    for (std::size_t i = 0; i < count; ++i) {
        if (pending[i] == 0) {
            ready.push(i);
        }
    }
    std::vector<std::vector<std::size_t>> outgoing(count);
    for (std::size_t e = 0; e < impl->edges.size(); ++e) {
        outgoing[impl->edges[e].from].push_back(e);
    }
    while (!ready.empty()) {
        const std::size_t n = ready.top();
        ready.pop();
        impl->order.push_back(n);
        for (const std::size_t e : outgoing[n]) {
            if (--pending[impl->edges[e].to] == 0) {
                ready.push(impl->edges[e].to);
            }
        }
    }
    if (impl->order.size() != count) {
        throw GraphError("cycle", "the graph contains a cycle");
    }

    impl->computeLatency();

    // Preallocate every buffer and delay line.
    impl->allocateBuffers(true);
    for (auto& edge : impl->edges) {
        edge.delay = impl->newDelay(edge);
    }
    impl->listMeters();
    return std::unique_ptr<PreparedGraph>(new PreparedGraph(std::move(impl)));
}

PreparedGraph::PreparedGraph(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
PreparedGraph::~PreparedGraph() = default;

std::unique_ptr<PreparedGraph> PreparedGraph::recompile() const {
    const Impl& old = *impl_;
    auto impl = std::make_unique<Impl>();
    impl->maxBlock = old.maxBlock;
    impl->outputNode = old.outputNode;
    impl->compensationLimit = old.compensationLimit;
    impl->order = old.order;
    impl->nodes.resize(old.nodes.size());
    for (std::size_t n = 0; n < old.nodes.size(); ++n) {
        impl->nodes[n].node = old.nodes[n].node;  // the same instance: its state carries over
        impl->nodes[n].name = old.nodes[n].name;
        impl->nodes[n].incoming = old.nodes[n].incoming;
    }
    impl->edges.reserve(old.edges.size());
    for (const auto& edge : old.edges) {
        impl->edges.push_back(Impl::Edge{edge.from, edge.to, edge.port, edge.gain, 0, nullptr, edge.monitor});
    }
    impl->computeLatency();
    // The nodes are already prepared for this block size (and may be running).
    impl->allocateBuffers(false);
    impl->listMeters();

    const std::int64_t total = impl->nodes[impl->outputNode].outputLatency;
    impl->ramped.assign(impl->edges.size(), 0);
    impl->held.assign(impl->edges.size(), 0);
    for (std::size_t e = 0; e < impl->edges.size(); ++e) {
        auto& edge = impl->edges[e];
        const auto& before = old.edges[e];
        const bool rebuilt = edge.compensation != before.compensation;
        const bool sourceChanged = impl->nodes[edge.from].compiledLatency != old.nodes[edge.from].compiledLatency;
        edge.delay = rebuilt ? impl->newDelay(edge) : before.delay;
        impl->ramped[e] = (rebuilt || sourceChanged) ? 1 : 0;
        if (rebuilt && edge.compensation > 0) {
            // The rebuilt line starts silent: full after its length, heard at
            // the output after at most the rest of the path's latency.
            const auto& to = impl->nodes[edge.to];
            const std::int64_t arrival = to.outputLatency - to.compiledLatency;
            impl->settle = std::max(impl->settle, edge.compensation + total - arrival);
        }
    }
    impl->recompiledFrom = this;
    return std::unique_ptr<PreparedGraph>(new PreparedGraph(std::move(impl)));
}

void PreparedGraph::process(const ProcessContext& context) noexcept {
    process(context, EdgeRamp{});
}

void PreparedGraph::process(const ProcessContext& context, const EdgeRamp& ramp) noexcept {
    const int frames = std::clamp(context.frames, 0, impl_->maxBlock);
    ProcessContext block = context;
    block.frames = frames;
    if (block.input != nullptr && (block.input->channels == nullptr || block.input->frames < frames)) {
        block.input = nullptr;  // too short for this block: no input
    }
    const bool ramping = ramp.fadeFrames > 0 && ramp.edges.size() == impl_->edges.size();

    for (const std::size_t n : impl_->order) {
        auto& state = impl_->nodes[n];
        for (std::size_t p = 0; p < state.inputs.size(); ++p) {
            state.inputViews[p] = state.inputs[p].sized(frames);
            state.inputViews[p].clear();
        }
        for (const std::size_t e : state.incoming) {
            auto& edge = impl_->edges[e];
            const AudioBufferView source = impl_->nodes[edge.from].output.sized(frames);
            const AudioBufferView& target = state.inputViews[static_cast<std::size_t>(edge.port)];
            const bool ramped = ramping && ramp.edges[e] != 0;
            if (edge.delay) {
                DelayLine& delay = *edge.delay;
                const std::size_t length = delay.ring.front().size();
                const float resumeStep =
                    edge.monitor != nullptr ? 1.0f / static_cast<float>(edge.monitor->fadeFrames()) : 0.0f;
                float resumed = delay.resume;  // where the envelope ends this block
                for (int c = 0; c < source.channelCount; ++c) {
                    auto& ring = delay.ring[static_cast<std::size_t>(c)];
                    std::size_t pos = delay.position;
                    float resume = delay.resume;  // the same envelope on every channel
                    for (int i = 0; i < frames; ++i) {
                        const float now = source.channel(c)[i];
                        float delayed = ring[pos];
                        if (edge.monitor != nullptr) {
                            // Monitored input skips the compensation (crossfaded),
                            // and the line stores none of it (see DelayLine::resume).
                            const float blend = edge.monitor->inputBlend(i);
                            resume = blend > 0.0f ? 0.0f : std::min(1.0f, resume + resumeStep);
                            ring[pos] = resume == 1.0f ? now : now * resume;
                            delayed = blend == 0.0f   ? delayed
                                      : blend == 1.0f ? now
                                                      : delayed * (1.0f - blend) + now * blend;
                        } else {
                            ring[pos] = now;
                        }
                        const float gain = ramped ? edge.gain * rampGain(ramp, i) : edge.gain;
                        target.channel(c)[i] += delayed * gain;
                        if (++pos == length) {
                            pos = 0;
                        }
                    }
                    resumed = resume;
                }
                delay.resume = resumed;
                delay.position = (delay.position + static_cast<std::size_t>(frames)) % length;
            } else {
                for (int c = 0; c < source.channelCount; ++c) {
                    for (int i = 0; i < frames; ++i) {
                        const float gain = ramped ? edge.gain * rampGain(ramp, i) : edge.gain;
                        target.channel(c)[i] += source.channel(c)[i] * gain;
                    }
                }
            }
        }
        const AudioBufferView out = state.output.sized(frames);
        state.node->process(block, state.inputViews, out);
        // While the node's previous change is still queued, a newer latency
        // waits; it is pushed once the control side has taken the old one.
        const std::int64_t now = state.node->latency();
        auto& queued = impl_->latencyQueued[n];
        if (now != state.reportedLatency && !queued.load(std::memory_order_acquire)) {
            queued.store(true, std::memory_order_relaxed);  // published by the push
            if (impl_->latencyOutbox->push(LatencyChange{n, now})) {
                state.reportedLatency = now;
            } else {
                queued.store(false, std::memory_order_relaxed);
            }
        }
    }
    impl_->outputView = impl_->nodes[impl_->outputNode].output.sized(frames);
}

const AudioBufferView& PreparedGraph::output() const noexcept {
    return impl_->outputView;
}

int PreparedGraph::outputChannels() const noexcept {
    return impl_->outputView.channelCount;
}

int PreparedGraph::maxBlockFrames() const noexcept {
    return impl_->maxBlock;
}

std::int64_t PreparedGraph::totalLatency() const noexcept {
    return impl_->nodes[impl_->outputNode].outputLatency;
}

bool PreparedGraph::monitors() const noexcept {
    return impl_->monitoring;
}

std::span<const std::uint8_t> PreparedGraph::startEdges() const noexcept {
    return impl_->start;
}

std::int64_t PreparedGraph::monitorPathLatency() const noexcept {
    std::int64_t slowest = 0;
    const std::int64_t total = totalLatency();
    for (const auto& edge : impl_->edges) {
        if (edge.monitor == nullptr) {
            continue;
        }
        const auto& to = impl_->nodes[edge.to];
        const std::int64_t arrival = to.outputLatency - to.compiledLatency;
        slowest = std::max(slowest, impl_->nodes[edge.from].outputLatency + total - arrival);
    }
    return slowest;
}

std::int64_t PreparedGraph::edgeCompensation(NodeId from, NodeId to, int port) const noexcept {
    for (const auto& edge : impl_->edges) {
        if (edge.from == from && edge.to == to && edge.port == port) {
            return edge.compensation;
        }
    }
    return -1;
}

const PreparedGraph* PreparedGraph::recompiledFrom() const noexcept {
    return impl_->recompiledFrom;
}

std::span<const std::uint8_t> PreparedGraph::rampedEdges() const noexcept {
    return impl_->ramped;
}

bool PreparedGraph::edgeRamped(NodeId from, NodeId to, int port) const noexcept {
    for (std::size_t e = 0; e < impl_->edges.size(); ++e) {
        const auto& edge = impl_->edges[e];
        if (edge.from == from && edge.to == to && edge.port == port) {
            return e < impl_->ramped.size() && impl_->ramped[e] != 0;
        }
    }
    return false;
}

std::int64_t PreparedGraph::settleFrames() const noexcept {
    return impl_->settle;
}

std::span<const std::uint8_t> PreparedGraph::holdEdges(std::span<const std::uint8_t> carried) noexcept {
    auto& held = impl_->held;
    const bool merge = carried.size() == held.size();
    for (std::size_t e = 0; e < held.size(); ++e) {
        held[e] = (impl_->ramped[e] != 0 || (merge && carried[e] != 0)) ? 1 : 0;
    }
    return held;
}

const Node* PreparedGraph::nodeAt(NodeId slot) const noexcept {
    return slot < impl_->nodes.size() ? impl_->nodes[slot].node.get() : nullptr;
}

void PreparedGraph::setParameter(NodeId node, std::uint32_t paramId, double value, int rampFrames) noexcept {
    if (node < impl_->nodes.size()) {
        impl_->nodes[node].node->setParameter(paramId, value, rampFrames);
    }
}

void PreparedGraph::locate(std::uint64_t generation, std::int64_t position) noexcept {
    for (auto& state : impl_->nodes) {
        state.node->onLocate(generation, position);
    }
}

std::span<const NodeId> PreparedGraph::meteredNodes() const noexcept {
    return impl_->meters;
}

MeterReading PreparedGraph::meterReading(NodeId node) const noexcept {
    if (node < impl_->nodes.size() && impl_->nodes[node].meter != nullptr) {
        return impl_->nodes[node].meter->reading();
    }
    return {};
}

std::size_t PreparedGraph::nodeCount() const noexcept {
    return impl_->nodes.size();
}

bool PreparedGraph::popLatencyChange(LatencyChange& change) noexcept {
    if (!impl_->latencyOutbox->pop(change)) {
        return false;
    }
    impl_->latencyQueued[change.slot].store(false, std::memory_order_release);
    return true;
}

std::int64_t PreparedGraph::outputLatency(NodeId node) const noexcept {
    return node < impl_->nodes.size() ? impl_->nodes[node].outputLatency : -1;
}

}  // namespace siann::graph
