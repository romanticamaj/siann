#include "siann/graph/graph.hpp"

#include <algorithm>
#include <queue>
#include <utility>

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

// A per-edge delay line used for compensation.
struct DelayLine {
    std::vector<std::vector<float>> ring;
    std::size_t position = 0;

    void allocate(int channels, std::int64_t delay) {
        ring.assign(static_cast<std::size_t>(channels), std::vector<float>(static_cast<std::size_t>(delay), 0.0f));
        position = 0;
    }
    bool active() const noexcept { return !ring.empty() && !ring.front().empty(); }
};

}  // namespace

struct PreparedGraph::Impl {
    struct Edge {
        std::size_t from;
        std::size_t to;
        int port;
        float gain;
        std::int64_t compensation;
        DelayLine delay;
    };
    struct NodeState {
        std::unique_ptr<Node> node;
        std::string name;
        std::vector<Storage> inputs;
        std::vector<AudioBufferView> inputViews;  // resized views, rebuilt per block
        Storage output;
        std::vector<std::size_t> incoming;  // edge indexes in insertion order
        std::int64_t outputLatency = 0;
    };

    std::vector<NodeState> nodes;
    std::vector<Edge> edges;
    std::vector<std::size_t> order;
    std::size_t outputNode = 0;
    int maxBlock = 0;
    AudioBufferView outputView;
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
    edges_.push_back(EdgeSpec{from, to, port, gain});
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
        impl->nodes[spec.to].incoming.push_back(impl->edges.size());
        impl->edges.push_back(PreparedGraph::Impl::Edge{spec.from, spec.to, spec.port, spec.gain, 0, {}});
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

    // Latency and compensation, in topological order.
    for (const std::size_t n : impl->order) {
        auto& state = impl->nodes[n];
        std::int64_t arrival = 0;
        for (const std::size_t e : state.incoming) {
            arrival = std::max(arrival, impl->nodes[impl->edges[e].from].outputLatency);
        }
        for (const std::size_t e : state.incoming) {
            auto& edge = impl->edges[e];
            edge.compensation = arrival - impl->nodes[edge.from].outputLatency;
            if (edge.compensation > compensationLimit) {
                throw GraphError("compensation_limit", "edge '" + impl->nodes[edge.from].name + "' -> '" + state.name +
                                                           "' needs " + std::to_string(edge.compensation) +
                                                           " samples of compensation, above the limit");
            }
        }
        state.outputLatency = arrival + state.node->latency();
    }

    // Preallocate every buffer and delay line.
    for (auto& state : impl->nodes) {
        const auto ports = state.node->inputPorts();
        state.inputs.resize(ports.size());
        state.inputViews.resize(ports.size());
        for (std::size_t p = 0; p < ports.size(); ++p) {
            state.inputs[p].allocate(ports[p], maxBlockFrames);
        }
        state.output.allocate(state.node->outputChannels(), maxBlockFrames);
        state.node->prepare(maxBlockFrames);
    }
    for (auto& edge : impl->edges) {
        if (edge.compensation > 0) {
            edge.delay.allocate(impl->nodes[edge.from].node->outputChannels(), edge.compensation);
        }
    }
    impl->outputView = impl->nodes[impl->outputNode].output.view;
    return std::unique_ptr<PreparedGraph>(new PreparedGraph(std::move(impl)));
}

PreparedGraph::PreparedGraph(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
PreparedGraph::~PreparedGraph() = default;

void PreparedGraph::process(const ProcessContext& context) noexcept {
    const int frames = std::clamp(context.frames, 0, impl_->maxBlock);
    const ProcessContext block{context.blockStart, frames};

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
            if (edge.delay.active()) {
                const std::size_t length = edge.delay.ring.front().size();
                for (int c = 0; c < source.channelCount; ++c) {
                    auto& ring = edge.delay.ring[static_cast<std::size_t>(c)];
                    std::size_t pos = edge.delay.position;
                    for (int i = 0; i < frames; ++i) {
                        const float delayed = ring[pos];
                        ring[pos] = source.channel(c)[i];
                        target.channel(c)[i] += delayed * edge.gain;
                        if (++pos == length) {
                            pos = 0;
                        }
                    }
                }
                edge.delay.position = (edge.delay.position + static_cast<std::size_t>(frames)) % length;
            } else {
                for (int c = 0; c < source.channelCount; ++c) {
                    for (int i = 0; i < frames; ++i) {
                        target.channel(c)[i] += source.channel(c)[i] * edge.gain;
                    }
                }
            }
        }
        const AudioBufferView out = state.output.sized(frames);
        state.node->process(block, state.inputViews, out);
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

std::int64_t PreparedGraph::edgeCompensation(NodeId from, NodeId to, int port) const noexcept {
    for (const auto& edge : impl_->edges) {
        if (edge.from == from && edge.to == to && edge.port == port) {
            return edge.compensation;
        }
    }
    return -1;
}

std::int64_t PreparedGraph::outputLatency(NodeId node) const noexcept {
    return node < impl_->nodes.size() ? impl_->nodes[node].outputLatency : -1;
}

}  // namespace siann::graph
