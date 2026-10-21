#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <chrono>
#include <functional>
#include <memory>
#include <thread>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/fake_audio_device.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/rt/realtime_thread.hpp"

using namespace siann;
using realtime::DriverState;
using realtime::GraphDriver;

namespace {

// Outputs a constant on both channels and counts its own destruction.
class ConstantNode final : public graph::Node {
public:
    ConstantNode(float value, std::shared_ptr<std::atomic<int>> destroyed)
        : value_(value), destroyed_(std::move(destroyed)) {}
    ~ConstantNode() override {
        if (destroyed_) {
            destroyed_->fetch_add(1);
        }
    }
    int outputChannels() const override { return 2; }
    void process(const graph::ProcessContext& context, std::span<const graph::AudioBufferView>,
                 const graph::AudioBufferView& output) noexcept override {
        for (int c = 0; c < 2; ++c) {
            for (int i = 0; i < context.frames; ++i) {
                output.channel(c)[i] = value_;
            }
        }
    }

private:
    float value_;
    std::shared_ptr<std::atomic<int>> destroyed_;
};

std::unique_ptr<graph::PreparedGraph> constantGraph(float value, std::shared_ptr<std::atomic<int>> destroyed = {},
                                                    int maxBlock = 64) {
    graph::GraphBuilder b;
    const auto n = b.add(std::make_unique<ConstantNode>(value, std::move(destroyed)), "constant");
    b.setOutput(n);
    return std::move(b).compile(maxBlock);
}

host::AudioDeviceConfig config(int frames = 64) {
    host::AudioDeviceConfig c;
    c.sampleRate = 48'000;
    c.bufferFrames = frames;
    c.outputChannels = 2;
    return c;
}

bool waitFor(const std::function<bool()>& condition, GraphDriver* driver = nullptr) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (std::chrono::steady_clock::now() < deadline) {
        if (driver != nullptr) {
            driver->poll();
        }
        if (condition()) {
            return true;
        }
        std::this_thread::sleep_for(std::chrono::microseconds(200));
    }
    return false;
}

// A device that forwards to a fake device and records the left output channel
// into preallocated storage; `written` is the only shared counter.
struct TapDevice final : host::AudioDevice {
    explicit TapDevice(std::size_t capacity) : samples(capacity, 0.0f) {}
    // Paced like real hardware, so the test can act between blocks.
    host::FakeAudioDevice inner{host::FakeAudioDevice::Options{true}};
    std::vector<float> samples;
    std::atomic<std::size_t> written{0};

    host::AudioDeviceStatus open(const host::AudioDeviceConfig& c) override { return inner.open(c); }
    void setOnStopped(std::function<void(bool)> h) override { inner.setOnStopped(std::move(h)); }
    void start(host::AudioCallback cb) override {
        inner.start([this, cb](const host::AudioBufferView& in, const host::AudioBufferView& out) {
            cb(in, out);
            std::size_t n = written.load(std::memory_order_relaxed);
            for (int i = 0; i < out.frames && n < samples.size(); ++i) {
                samples[n++] = out.channel(0)[i];
            }
            written.store(n, std::memory_order_release);
        });
    }
    void stop() override { inner.stop(); }
    void close() override { inner.close(); }
};

}  // namespace

TEST_CASE("Publishing while stopped installs at once and retires the old graph", "[driver]") {
    GraphDriver driver({});
    auto destroyedA = std::make_shared<std::atomic<int>>(0);
    const auto a = driver.publish(constantGraph(1.0f, destroyedA));
    CHECK(driver.state() == DriverState::stopped);
    CHECK(driver.liveEpoch() == a);
    const auto b = driver.publish(constantGraph(0.5f));
    CHECK(driver.liveEpoch() == b);
    CHECK(destroyedA->load() == 1);
    CHECK(driver.ownedGraphs() == 1);
}

TEST_CASE("A running device plays the live graph and advances the playhead", "[driver]") {
    GraphDriver driver({});
    driver.publish(constantGraph(0.25f));
    host::FakeAudioDevice::Options options;
    options.stopAfterCallbacks = -1;
    host::FakeAudioDevice device(options);
    driver.play();
    driver.start(device, config());
    CHECK(driver.state() == DriverState::realtime);
    REQUIRE(waitFor([&] { return driver.playhead() >= 48'000; }, &driver));
    driver.stop();
    CHECK(driver.state() == DriverState::stopped);
    CHECK(driver.playhead() % 64 == 0);
    CHECK_FALSE(device.running());
}

TEST_CASE("A swap acknowledges, retires the old graph after the swap, and keeps one transition in flight",
          "[driver]") {
    GraphDriver driver({});
    auto destroyedA = std::make_shared<std::atomic<int>>(0);
    auto destroyedB = std::make_shared<std::atomic<int>>(0);
    auto destroyedC = std::make_shared<std::atomic<int>>(0);
    driver.publish(constantGraph(1.0f, destroyedA));
    host::FakeAudioDevice device({});
    driver.play();
    driver.start(device, config());

    const auto b = driver.publish(constantGraph(0.5f, destroyedB));
    CHECK(driver.transitionInFlight());
    CHECK(destroyedA->load() == 0);  // still live on the audio thread
    // Published during the transition: waits, and a later one replaces it.
    driver.publish(constantGraph(0.4f, destroyedC));
    const auto d = driver.publish(constantGraph(0.3f));
    CHECK(destroyedC->load() == 1);  // superseded before it was sent

    REQUIRE(waitFor([&] { return driver.liveEpoch() == d && !driver.transitionInFlight(); }, &driver));
    CHECK(destroyedA->load() == 1);
    CHECK(destroyedB->load() == 1);
    CHECK(driver.ownedGraphs() == 1);
    (void)b;
    driver.stop();
}

TEST_CASE("Duck-and-swap fades out, swaps at a block boundary, then fades in", "[driver]") {
    GraphDriver::Options options;
    options.fadeFrames = 100;
    GraphDriver driver(options);
    driver.publish(constantGraph(1.0f));
    TapDevice tap(64 * 400);
    driver.play();
    driver.start(tap, config(64));
    REQUIRE(waitFor([&] { return tap.written.load() >= 64 * 20; }, &driver));
    driver.publish(constantGraph(0.5f));
    REQUIRE(waitFor([&] { return !driver.transitionInFlight(); }, &driver));
    REQUIRE(waitFor([&] { return tap.written.load() >= tap.samples.size(); }, &driver));
    driver.stop();

    // The signal steps down from 1 to 0 and back up to 0.5 with no jump larger
    // than one fade step, and goes silent only on a block boundary.
    const auto& left = tap.samples;
    float maxStep = 0.0f;
    std::size_t silentAt = 0;
    const std::size_t settled = 64 * 20;  // after the initial fade-in from silence
    for (std::size_t i = 1; i < left.size(); ++i) {
        maxStep = std::max(maxStep, std::abs(left[i] - left[i - 1]));
        if (silentAt == 0 && i >= settled && left[i] == 0.0f) {
            silentAt = i;
        }
    }
    CHECK(maxStep <= 1.0f / 100.0f + 1e-6f);
    CHECK(left.front() == 0.0f);  // the first graph fades in from silence
    CHECK(left[settled] == 1.0f);
    CHECK(left.back() == 0.5f);
    REQUIRE(silentAt != 0);
    // The duck takes 100 frames from the start of a block, so the first silent
    // frame is 100 frames into that block, and silence lasts until the next block.
    CHECK(silentAt % 64 == 100 % 64);
    CHECK(left[(silentAt / 64 + 1) * 64] == 0.0f);  // the new graph rises from 0
}

TEST_CASE("Stopping with a graph still in the inbox installs it as live", "[driver]") {
    GraphDriver driver({});
    auto destroyedA = std::make_shared<std::atomic<int>>(0);
    driver.publish(constantGraph(1.0f, destroyedA));
    host::FakeAudioDevice::Options options;
    options.stall = true;  // the callback never runs, so the graph stays in the inbox
    host::FakeAudioDevice device(options);
    driver.start(device, config());
    const auto b = driver.publish(constantGraph(0.5f));
    CHECK(driver.transitionInFlight());
    driver.stop();
    CHECK(driver.state() == DriverState::stopped);
    CHECK(driver.liveEpoch() == b);
    CHECK(destroyedA->load() == 1);
    CHECK(driver.ownedGraphs() == 1);
}

TEST_CASE("Device loss returns ownership and later publishes install directly", "[driver]") {
    GraphDriver driver({});
    driver.publish(constantGraph(1.0f));
    host::FakeAudioDevice device({});
    driver.play();
    driver.start(device, config());
    REQUIRE(waitFor([&] { return device.callbacks() > 10; }, &driver));
    device.simulateUnplug();
    REQUIRE(waitFor([&] { return driver.state() == DriverState::stopped; }, &driver));
    const auto b = driver.publish(constantGraph(0.5f));
    CHECK(driver.liveEpoch() == b);
    CHECK_FALSE(driver.transitionInFlight());
}

TEST_CASE("The watchdog stops a device that never acknowledges", "[driver]") {
    GraphDriver::Options options;
    options.ackTimeout = std::chrono::milliseconds(50);
    GraphDriver driver(options);
    driver.publish(constantGraph(1.0f));
    host::FakeAudioDevice::Options deviceOptions;
    deviceOptions.stall = true;  // a hung driver: running, no callbacks, no loss report
    host::FakeAudioDevice device(deviceOptions);
    driver.start(device, config());
    const auto b = driver.publish(constantGraph(0.5f));
    REQUIRE(waitFor([&] { return driver.state() == DriverState::stopped; }, &driver));
    CHECK(driver.watchdogTrips() == 1);
    CHECK(driver.liveEpoch() == b);
    CHECK_FALSE(device.running());
}

TEST_CASE("The audio callback path does not allocate", "[driver][alloc]") {
    GraphDriver driver({});
    driver.publish(constantGraph(1.0f));
    host::FakeAudioDevice device({});
    driver.play();
    driver.start(device, config());
    REQUIRE(waitFor([&] { return device.callbacks() > 50; }, &driver));
    const auto before = rt::allocationViolations();
    for (int i = 0; i < 20; ++i) {
        driver.publish(constantGraph(0.1f * static_cast<float>(i % 5)));  // control side allocates; fine
        REQUIRE(waitFor([&] { return !driver.transitionInFlight(); }, &driver));
    }
    REQUIRE(waitFor([&] { return device.callbacks() > 500; }, &driver));
    driver.stop();
    CHECK(rt::allocationViolations() == before);
}

TEST_CASE("Device blocks larger than the graph block size are processed in chunks", "[driver]") {
    GraphDriver driver({});
    driver.publish(constantGraph(1.0f, {}, 32));
    host::FakeAudioDevice device({});
    driver.play();
    driver.start(device, config(256));
    REQUIRE(waitFor([&] { return driver.playhead() >= 256 * 10; }, &driver));
    driver.stop();
    CHECK(driver.playhead() % 256 == 0);
}
