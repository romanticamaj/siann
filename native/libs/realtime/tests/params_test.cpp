#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/realtime/control_dispatcher.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/rt/realtime_thread.hpp"

using namespace siann;
using graph::TrackFaderNode;
using realtime::ControlDispatcher;
using realtime::GraphDriver;
using realtime::ParamChange;
using realtime::ParamKey;

namespace {

constexpr int kBlock = 64;
constexpr float kMinus6 = 0.501187f;

class ConstantNode final : public graph::Node {
public:
    int outputChannels() const override { return 2; }
    void process(const graph::ProcessContext& context, std::span<const graph::AudioBufferView>,
                 const graph::AudioBufferView& output) noexcept override {
        for (int c = 0; c < 2; ++c) {
            for (int i = 0; i < context.frames; ++i) {
                output.channel(c)[i] = 1.0f;
            }
        }
    }
};

// constant 1.0 -> fader(gain) -> output; the fader is node 1.
constexpr graph::NodeId kFader = 1;

std::unique_ptr<graph::PreparedGraph> faderGraph(std::int32_t gainMilliDb = 0) {
    graph::GraphBuilder b;
    const auto source = b.add(std::make_unique<ConstantNode>(), "source");
    const auto fader = b.add(std::make_unique<TrackFaderNode>(2, gainMilliDb, 0, false), "fader");
    b.connect(source, fader);
    b.setOutput(fader);
    return std::move(b).compile(kBlock);
}

host::AudioDeviceConfig config() {
    host::AudioDeviceConfig c;
    c.sampleRate = 48'000;
    c.bufferFrames = kBlock;
    c.outputChannels = 2;
    return c;
}

struct Rig {
    GraphDriver driver{GraphDriver::Options{kBlock, std::chrono::milliseconds(500)}};
    host::ManualAudioDevice device;
    std::uint64_t first = 0;

    Rig() {
        first = driver.publish(faderGraph());
        driver.play();
        driver.start(device, config());
        device.pump(4);  // past the initial fade-in
    }
    std::vector<float> pump(int blocks) {
        std::vector<float> out;
        device.pump(blocks, &out);
        driver.poll();
        return out;
    }
    ~Rig() { driver.stop(); }
};

bool near(float a, float b) {
    return std::abs(a - b) < 1e-5f;
}

}  // namespace

TEST_CASE("A current-epoch change applies at the next block", "[params]") {
    Rig rig;
    REQUIRE(rig.driver.pushParam(ParamChange{rig.first, kFader, TrackFaderNode::kGainMilliDb, -6'000, 0}));
    const auto out = rig.pump(1);
    CHECK(std::all_of(out.begin(), out.end(), [](float s) { return near(s, kMinus6); }));
}

TEST_CASE("A ramped change moves linearly and lands on its target", "[params]") {
    Rig rig;
    REQUIRE(rig.driver.pushParam(ParamChange{rig.first, kFader, TrackFaderNode::kGainMilliDb, -6'000, 100}));
    const auto out = rig.pump(3);
    const float step = (kMinus6 - 1.0f) / 100.0f;
    for (int i = 0; i < 100; ++i) {
        INFO("frame " << i);
        CHECK(std::abs(out[static_cast<std::size_t>(i)] - (1.0f + step * static_cast<float>(i + 1))) < 1e-4f);
    }
    CHECK(near(out[99], kMinus6));     // lands on the target
    CHECK(near(out.back(), kMinus6));  // and stays there
}

TEST_CASE("Changes for an older epoch are dropped", "[params]") {
    Rig rig;
    rig.driver.publish(faderGraph());
    rig.pump(4);  // duck, swap, rise
    REQUIRE_FALSE(rig.driver.transitionInFlight());
    REQUIRE(rig.driver.pushParam(ParamChange{rig.first, kFader, TrackFaderNode::kGainMilliDb, -6'000, 0}));
    const auto out = rig.pump(2);
    CHECK(std::all_of(out.begin(), out.end(), [](float s) { return s == 1.0f; }));
}

TEST_CASE("A change for a newer epoch waits until that graph is swapped in", "[params]") {
    Rig rig;
    const auto second = rig.driver.publish(faderGraph());  // unity, like a recompile from the document
    REQUIRE(rig.driver.pushParam(ParamChange{second, kFader, TrackFaderNode::kGainMilliDb, -6'000, 0}));
    const auto before = rt::allocationViolations();
    const auto out = rig.pump(4);
    CHECK(rt::allocationViolations() == before);

    // Block 0 ducks the old graph, which the change must not touch.
    CHECK(out[0] == 1.0f);
    // From the swap on, the new graph already carries the change: it rises from
    // silence toward -6 dB and never reaches unity.
    for (std::size_t i = kBlock; i < out.size(); ++i) {
        CHECK(out[i] <= kMinus6 + 1e-5f);
    }
    CHECK(near(out.back(), kMinus6));
}

TEST_CASE("The dispatcher keeps a held fader across a recompile", "[params][dispatcher]") {
    Rig rig;
    ControlDispatcher dispatcher(rig.driver);
    const std::map<std::string, graph::NodeId> slots{{"track:trk_1", kFader}};
    dispatcher.graphPublished(rig.first, slots);
    const ParamKey gain{"track:trk_1", TrackFaderNode::kGainMilliDb};

    dispatcher.beginGesture(gain);
    dispatcher.updateGesture(gain, -6'000, 0);
    CHECK(dispatcher.tick() == 1);
    CHECK(near(rig.pump(1).back(), kMinus6));

    // A structural edit recompiles the graph from the document, where the
    // fader is still at 0 dB because the gesture has not been committed.
    const auto second = rig.driver.publish(faderGraph(0));
    dispatcher.graphPublished(second, slots);
    CHECK(dispatcher.tick() == 1);
    const auto out = rig.pump(4);
    CHECK(near(out.back(), kMinus6));
    for (std::size_t i = kBlock; i < out.size(); ++i) {
        CHECK(out[i] <= kMinus6 + 1e-5f);
    }

    const auto committed = dispatcher.endGesture(gain);
    REQUIRE(committed.has_value());
    CHECK(*committed == -6'000.0);
    CHECK_FALSE(dispatcher.gestureOpen(gain));
}

TEST_CASE("Pending values coalesce per parameter", "[params][dispatcher]") {
    Rig rig;
    ControlDispatcher dispatcher(rig.driver);
    dispatcher.graphPublished(rig.first, {{"track:trk_1", kFader}});
    const ParamKey gain{"track:trk_1", TrackFaderNode::kGainMilliDb};
    for (int i = 0; i < 1'000; ++i) {
        dispatcher.setParameter(gain, -static_cast<double>(i), 0);
    }
    dispatcher.setParameter(gain, -6'000, 0);
    CHECK(dispatcher.pendingCount() == 1);
    CHECK(dispatcher.tick() == 1);
    CHECK(near(rig.pump(1).back(), kMinus6));
}

TEST_CASE("Changes that do not fit stay pending and go out on the next tick", "[params][dispatcher]") {
    Rig rig;
    ControlDispatcher dispatcher(rig.driver);
    std::map<std::string, graph::NodeId> slots;
    for (int i = 0; i < 2'000; ++i) {
        slots["track:t" + std::to_string(i)] = kFader;
    }
    dispatcher.graphPublished(rig.first, slots);
    for (int i = 0; i < 2'000; ++i) {
        dispatcher.setParameter({"track:t" + std::to_string(i), TrackFaderNode::kPan}, 0, 0);
    }
    CHECK(dispatcher.tick() == 1'024);
    CHECK(dispatcher.pendingCount() == 976);
    rig.pump(1);
    CHECK(dispatcher.tick() == 976);
    CHECK(dispatcher.pendingCount() == 0);
}

TEST_CASE("Changes for entities the graph does not have yet wait", "[params][dispatcher]") {
    Rig rig;
    ControlDispatcher dispatcher(rig.driver);
    dispatcher.graphPublished(rig.first, {});
    const ParamKey gain{"track:new", TrackFaderNode::kGainMilliDb};
    dispatcher.setParameter(gain, -6'000, 0);
    CHECK(dispatcher.tick() == 0);
    CHECK(dispatcher.pendingCount() == 1);
    dispatcher.graphPublished(rig.first, {{"track:new", kFader}});
    CHECK(dispatcher.tick() == 1);
    CHECK(near(rig.pump(1).back(), kMinus6));
}

TEST_CASE("While stopped, poll applies queued changes to the live graph", "[params]") {
    GraphDriver driver({});
    const auto epoch = driver.publish(faderGraph());
    REQUIRE(driver.pushParam(ParamChange{epoch, kFader, TrackFaderNode::kGainMilliDb, -6'000, 0}));
    driver.poll();
    host::ManualAudioDevice device;
    driver.play();
    driver.start(device, config());
    std::vector<float> out;
    device.pump(8, &out);
    driver.stop();
    CHECK(near(out.back(), kMinus6));
}
