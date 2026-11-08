#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <memory>
#include <vector>

#include "plugin_double.hpp"
#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/graph/plugin_node.hpp"
#include "siann/rt/realtime_thread.hpp"

// PluginNode (architecture spec, "siann-graph and siann-engine"; m4-plugin-node).

using namespace siann::graph;
using siann::test::DoublePlugin;
using siann::test::fakeNow;

namespace {

// A source of a constant, per channel: channel c is 0.25 * (c + 1).
class ConstantNode final : public Node {
public:
    explicit ConstantNode(int channels) : channels_(channels) {}
    int outputChannels() const override { return channels_; }
    void process(const ProcessContext&, std::span<const AudioBufferView>, const AudioBufferView& output) noexcept override {
        for (int c = 0; c < output.channelCount; ++c) {
            for (int i = 0; i < output.frames; ++i) {
                output.channel(c)[i] = 0.25f * static_cast<float>(c + 1);
            }
        }
    }

private:
    int channels_;
};

struct Rig {
    std::unique_ptr<PreparedGraph> graph;
    PluginNode* node = nullptr;
    NodeId slot = 0;
};

Rig build(DoublePlugin& plugin, bool timed = true, int channels = 2) {
    GraphBuilder b;
    const NodeId source = b.add(std::make_unique<ConstantNode>(channels), "source");
    auto node = std::make_unique<PluginNode>(plugin, channels, 48'000, timed, &fakeNow);
    PluginNode* raw = node.get();
    const NodeId slot = b.add(std::move(node), "plugin");
    b.connect(source, slot);
    b.setOutput(slot);
    return {std::move(b).compile(256), raw, slot};
}

}  // namespace

TEST_CASE("PluginNode calls process once per block with an empty event list", "[graph][plugin]") {
    DoublePlugin plugin(0, 2.0f);
    Rig rig = build(plugin);
    rig.graph->process(ProcessContext{0, 256});
    CHECK(plugin.calls.load() == 1);
    CHECK(plugin.lastEventCount.load() == 0);
    CHECK(rig.graph->output().channel(0)[10] == 0.5f);
    CHECK(rig.graph->output().channel(1)[10] == 1.0f);
    rig.graph->process(ProcessContext{256, 100});
    CHECK(plugin.calls.load() == 2);
    CHECK(rig.node->inputPorts() == std::vector<int>{2});
    CHECK(rig.node->outputChannels() == 2);
}

TEST_CASE("A bypassed PluginNode copies its input and never calls process", "[graph][plugin]") {
    DoublePlugin plugin(32, 2.0f);
    Rig rig = build(plugin);
    rig.node->setBypass(true);
    CHECK(rig.node->bypassed());
    CHECK(rig.node->latency() == 0);
    rig.graph->process(ProcessContext{0, 256});
    CHECK(plugin.calls.load() == 0);
    CHECK(rig.graph->output().channel(0)[0] == 0.25f);
    CHECK(rig.graph->output().channel(1)[0] == 0.5f);
    rig.node->setBypass(false);
    CHECK(rig.node->latency() == 32);
    rig.graph->process(ProcessContext{256, 256});
    CHECK(plugin.calls.load() == 1);
}

TEST_CASE("PluginNode reports the instance's latency and its changes", "[graph][plugin][latency]") {
    DoublePlugin plugin(64);
    Rig rig = build(plugin);
    CHECK(rig.node->latency() == 64);
    CHECK(rig.graph->totalLatency() == 64);
    LatencyChange change;
    rig.graph->process(ProcessContext{0, 256});
    CHECK_FALSE(rig.graph->popLatencyChange(change));
    plugin.setLatency(512);
    rig.graph->process(ProcessContext{256, 256});
    REQUIRE(rig.graph->popLatencyChange(change));
    CHECK(change.slot == rig.slot);
    CHECK(change.latency == 512);
    CHECK(rig.graph->recompile()->totalLatency() == 512);
}

TEST_CASE("Each PluginNode times its own process calls", "[graph][plugin][timing]") {
    DoublePlugin slow;
    DoublePlugin fast;
    GraphBuilder b;
    const NodeId source = b.add(std::make_unique<ConstantNode>(2), "source");
    auto slowNode = std::make_unique<PluginNode>(slow, 2, 48'000, true, &fakeNow);
    auto fastNode = std::make_unique<PluginNode>(fast, 2, 48'000, true, &fakeNow);
    PluginNode* slowRaw = slowNode.get();
    PluginNode* fastRaw = fastNode.get();
    const NodeId a = b.add(std::move(slowNode), "slow");
    const NodeId c = b.add(std::move(fastNode), "fast");
    const NodeId master = b.add(std::make_unique<BusNode>(2), "master");
    b.connect(source, a);
    b.connect(source, c);
    b.connect(a, master);
    b.connect(c, master);
    b.setOutput(master);
    auto graph = std::move(b).compile(256);

    // 256 frames at 48 kHz is 5.33 ms; the slow one takes 20 ms, the fast one 1 ms.
    slow.processNanos.store(20'000'000);
    fast.processNanos.store(1'000'000);
    for (int i = 0; i < 3; ++i) {
        graph->process(ProcessContext{i * 256, 256});
    }
    CHECK(slowRaw->timer().callbacks() == 3);
    CHECK(slowRaw->timer().misses() == 3);
    CHECK(slowRaw->timer().maxCallbackNanos() == 20'000'000);
    CHECK(fastRaw->timer().callbacks() == 3);
    CHECK(fastRaw->timer().misses() == 0);
    CHECK(fastRaw->timer().maxCallbackNanos() == 1'000'000);
}

TEST_CASE("An untimed PluginNode (offline) records nothing", "[graph][plugin][timing]") {
    DoublePlugin plugin;
    plugin.processNanos.store(20'000'000);
    Rig rig = build(plugin, false);
    rig.graph->process(ProcessContext{0, 256});
    CHECK(plugin.calls.load() == 1);
    CHECK(rig.node->timer().callbacks() == 0);
    CHECK(rig.node->timer().misses() == 0);
}

TEST_CASE("A PluginNode can time into a timer it does not own", "[graph][plugin][timing]") {
    DoublePlugin plugin;
    siann::rt::CallbackTimer shared;
    GraphBuilder b;
    const NodeId source = b.add(std::make_unique<ConstantNode>(2), "source");
    const NodeId slot = b.add(std::make_unique<PluginNode>(plugin, 2, 48'000, true, &fakeNow, &shared), "plugin");
    b.connect(source, slot);
    b.setOutput(slot);
    auto graph = std::move(b).compile(256);
    plugin.processNanos.store(6'000'000);
    graph->process(ProcessContext{0, 256});
    CHECK(shared.callbacks() == 1);
    CHECK(shared.misses() == 1);
}

TEST_CASE("PluginNode does not allocate while processing", "[graph][plugin][rt]") {
    DoublePlugin plugin(16);
    Rig rig = build(plugin);
    const auto before = siann::rt::allocationViolations();
    {
        siann::rt::ScopedRealtimeThread realtime;
        for (int i = 0; i < 8; ++i) {
            rig.graph->process(ProcessContext{i * 256, 256});
        }
        rig.node->setBypass(true);
        rig.graph->process(ProcessContext{8 * 256, 256});
    }
    CHECK(siann::rt::allocationViolations() == before);
    CHECK(plugin.calls.load() == 8);
}

TEST_CASE("A mono PluginNode feeds the instance one channel", "[graph][plugin]") {
    DoublePlugin plugin(0, 1.0f);
    Rig rig = build(plugin, true, 1);
    rig.graph->process(ProcessContext{0, 64});
    CHECK(rig.graph->outputChannels() == 1);
    CHECK(rig.graph->output().channel(0)[0] == 0.25f);
}

// m4-crash-recovery: plugin.set_parameter reaches a CLAP instance as a parameter
// event at the start of the node's next block (spec, Protocol v0 item 20). The
// driver calls setParameter on the audio thread between blocks.

TEST_CASE("A parameter change reaches the instance as one event of the next block", "[graph][plugin][param]") {
    DoublePlugin plugin;
    Rig rig = build(plugin);
    rig.graph->setParameter(rig.slot, 7, 0.75, 0);
    rig.graph->process(ProcessContext{0, 256});
    REQUIRE(plugin.receivedCount == 1);
    const siann::host::BlockEvent& event = plugin.received[0];
    CHECK(event.kind == siann::host::BlockEventKind::parameterValue);
    CHECK(event.data0 == 7u);
    CHECK(event.value == 0.75);
    CHECK(event.sampleOffset == 0);
    rig.graph->process(ProcessContext{256, 256});
    CHECK(plugin.receivedCount == 0);
    CHECK(rig.node->droppedParameters() == 0);
}

TEST_CASE("The latest of two values for one parameter wins", "[graph][plugin][param]") {
    DoublePlugin plugin;
    Rig rig = build(plugin);
    rig.graph->setParameter(rig.slot, 3, 0.2, 0);
    rig.graph->setParameter(rig.slot, 5, 0.4, 0);
    rig.graph->setParameter(rig.slot, 3, 0.9, 0);
    rig.graph->process(ProcessContext{0, 256});
    REQUIRE(plugin.receivedCount == 2);
    CHECK(plugin.received[0].data0 == 3u);
    CHECK(plugin.received[0].value == 0.9);
    CHECK(plugin.received[1].data0 == 5u);
    CHECK(plugin.received[1].value == 0.4);
}

TEST_CASE("Every parameter set while no block runs waits for the next one: the latest per parameter, no allocation",
          "[graph][plugin][param][rt]") {
    // More parameters than a fixed queue would hold (Surge XT has hundreds), all set
    // while the transport is stopped: none is lost (spec, Protocol v0 item 20).
    constexpr std::uint32_t count = 300;
    DoublePlugin plugin;
    plugin.setParameterCount(count);
    Rig rig = build(plugin);
    CHECK(rig.node->pendingParameterCapacity() == count);
    const auto before = siann::rt::allocationViolations();
    {
        siann::rt::ScopedRealtimeThread realtime;
        for (std::uint32_t index = 0; index < count; ++index) {
            rig.graph->setParameter(rig.slot, index, 0.1, 0);
        }
        rig.graph->setParameter(rig.slot, 0, 0.6, 0);
        rig.graph->setParameter(rig.slot, count - 1, 0.7, 0);
        rig.graph->process(ProcessContext{0, 256});
    }
    CHECK(siann::rt::allocationViolations() == before);
    REQUIRE(plugin.receivedCount == count);
    CHECK(plugin.received[0].data0 == 0u);
    CHECK(plugin.received[0].value == 0.6);
    CHECK(plugin.received[count - 1].data0 == count - 1);
    CHECK(plugin.received[count - 1].value == 0.7);
    CHECK(rig.node->droppedParameters() == 0);
    // Delivered: the next block carries only what was set since.
    rig.graph->setParameter(rig.slot, 5, 0.3, 0);
    rig.graph->process(ProcessContext{256, 256});
    REQUIRE(plugin.receivedCount == 1);
    CHECK(plugin.received[0].data0 == 5u);
    CHECK(plugin.received[0].value == 0.3);
}

TEST_CASE("An index past the instance's parameter list at construction is counted, never stored",
          "[graph][plugin][param]") {
    DoublePlugin plugin;
    plugin.setParameterCount(4);
    Rig rig = build(plugin);
    CHECK(rig.node->pendingParameterCapacity() == 4);
    rig.graph->setParameter(rig.slot, 4, 0.5, 0);
    rig.graph->setParameter(rig.slot, 3, 0.5, 0);
    rig.graph->process(ProcessContext{0, 256});
    REQUIRE(plugin.receivedCount == 1);
    CHECK(plugin.received[0].data0 == 3u);
    CHECK(rig.node->droppedParameters() == 1);
}

TEST_CASE("A bypassed node keeps a parameter change for the next processed block", "[graph][plugin][param]") {
    DoublePlugin plugin;
    Rig rig = build(plugin);
    rig.node->setBypass(true);
    rig.graph->setParameter(rig.slot, 2, 0.5, 0);
    rig.graph->process(ProcessContext{0, 256});
    CHECK(plugin.calls.load() == 0);
    rig.node->setBypass(false);
    rig.graph->process(ProcessContext{256, 256});
    REQUIRE(plugin.receivedCount == 1);
    CHECK(plugin.received[0].data0 == 2u);
    CHECK(plugin.received[0].value == 0.5);
}
