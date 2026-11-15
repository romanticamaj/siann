#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <chrono>
#include <functional>
#include <memory>
#include <thread>
#include <vector>

#include "siann/dsp/loudness.hpp"
#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/fake_audio_device.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/rt/callback_timer.hpp"
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

TEST_CASE("The driver reports retired epochs on the control side", "[driver][retire]") {
    std::vector<std::uint64_t> retired;
    const auto control = std::this_thread::get_id();
    bool offThread = false;
    GraphDriver::Options options;
    options.onRetired = [&](std::uint64_t epoch) {
        offThread = offThread || std::this_thread::get_id() != control;
        retired.push_back(epoch);
    };
    GraphDriver driver(options);
    const auto a = driver.publish(constantGraph(1.0f));
    CHECK(retired.empty());
    host::FakeAudioDevice device({});
    driver.play();
    driver.start(device, config());

    const auto b = driver.publish(constantGraph(0.5f));
    REQUIRE(waitFor([&] { return !driver.transitionInFlight(); }, &driver));
    CHECK(retired == std::vector<std::uint64_t>{a});

    // c is sent, d waits behind it, e supersedes d before it is ever sent.
    const auto c = driver.publish(constantGraph(0.4f));
    const auto d = driver.publish(constantGraph(0.3f));
    const auto e = driver.publish(constantGraph(0.2f));
    CHECK(retired == std::vector<std::uint64_t>{a, d});
    REQUIRE(waitFor([&] { return driver.liveEpoch() == e && !driver.transitionInFlight(); }, &driver));
    CHECK(retired == std::vector<std::uint64_t>{a, d, b, c});

    // Stopping right after a publish still reports what it retires.
    const auto f = driver.publish(constantGraph(0.1f));
    driver.stop();
    CHECK(driver.liveEpoch() == f);
    CHECK(retired == std::vector<std::uint64_t>{a, d, b, c, e});
    CHECK(driver.ownedGraphs() == 1);
    CHECK_FALSE(offThread);
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

namespace {

// A clock the test advances itself: every reading is `fakeStepNanos` later than
// the previous one, so a callback timed between two readings lasts exactly one
// step. No wall clock, no sleep.
std::int64_t fakeNanos = 0;
std::int64_t fakeStepNanos = 0;
std::int64_t fakeClock() noexcept {
    fakeNanos += fakeStepNanos;
    return fakeNanos;
}

}  // namespace

TEST_CASE("The driver counts deadline misses and the longest callback without allocating", "[driver][alloc][xrun]") {
    // 64 frames at 48 kHz: a period of 1,333,333.3 ns. The spec's vocabulary:
    // an xrun is a deadline miss, separate from disk underruns and srcUnderruns.
    GraphDriver::Options options;
    options.nowNanos = &fakeClock;
    GraphDriver driver(options);
    driver.publish(constantGraph(1.0f));
    host::ManualAudioDevice device;
    driver.play();
    driver.start(device, config(64));
    const rt::CallbackTimer& timing = driver.callbackTiming();
    CHECK(timing.callbacks() == 0);
    CHECK(timing.misses() == 0);

    const auto before = rt::allocationViolations();
    fakeStepNanos = 1'000'000;  // on time
    device.pump(3);
    CHECK(timing.callbacks() == 3);
    CHECK(timing.misses() == 0);
    CHECK(timing.maxCallbackNanos() == 1'000'000);

    fakeStepNanos = 1'333'333;  // the last nanosecond that is not a miss
    device.pump(1);
    CHECK(timing.misses() == 0);
    fakeStepNanos = 1'333'334;  // one past the period
    device.pump(1);
    CHECK(timing.misses() == 1);

    fakeStepNanos = 5'000'000;  // a hosted plugin's restart, say
    device.pump(2);
    CHECK(timing.callbacks() == 7);
    CHECK(timing.misses() == 3);
    CHECK(timing.maxCallbackNanos() == 5'000'000);
    CHECK(timing.unmeasured() == 0);
    CHECK(rt::allocationViolations() == before);
    CHECK(driver.srcUnderruns() == 0);  // a deadline miss is not SRC underfill
    driver.stop();

    // start() begins a new count.
    driver.start(device, config(64));
    CHECK(timing.callbacks() == 0);
    CHECK(timing.misses() == 0);
    CHECK(timing.maxCallbackNanos() == 0);
    driver.stop();
}

TEST_CASE("The driver times callbacks with the steady clock by default", "[driver][xrun]") {
    GraphDriver driver({});
    driver.publish(constantGraph(1.0f));
    host::ManualAudioDevice device;
    driver.play();
    driver.start(device, config(512));  // eight graph blocks per callback: measurably long
    device.pump(64);
    CHECK(driver.callbackTiming().callbacks() == 64);
    CHECK(driver.callbackTiming().unmeasured() == 0);
    // A real clock: the longest of 64 callbacks took time. A clock that stood
    // still (or returned a constant) would report 0 here.
    CHECK(driver.callbackTiming().maxCallbackNanos() > 0);
    driver.stop();
}

namespace {

std::unique_ptr<const realtime::ClickTempo> clickAt(std::int32_t milliBpm) {
    return realtime::ClickTempo::build({time::TempoPoint{time::MusicTime{0}, milliBpm}}, 48'000);
}

// Each burst's first non-zero sample after at least `gap` zeros.
std::vector<std::size_t> clickOnsets(const std::vector<float>& samples, std::size_t gap = 2'000) {
    std::vector<std::size_t> out;
    std::size_t zeros = gap;
    for (std::size_t i = 0; i < samples.size(); ++i) {
        if (samples[i] != 0.0f) {
            if (zeros >= gap) {
                out.push_back(i);
            }
            zeros = 0;
        } else {
            ++zeros;
        }
    }
    return out;
}

}  // namespace

TEST_CASE("Tempo tables past the click inbox never throw: the newest wins on a later poll", "[driver][click]") {
    // Spec, "Queues": clickInbox is latest-wins with a control-side retry, so
    // the update of a committed revision never fails because the audio thread
    // has not run.
    GraphDriver driver({});
    driver.publish(constantGraph(0.0f));
    driver.setClickTempo(clickAt(120'000));  // stopped: installed at once
    host::ManualAudioDevice device;
    driver.setClick(true, 1.0f);
    driver.play();
    driver.start(device, config(64));
    // No callback between these: far more tables than the inbox holds.
    for (int i = 0; i < 20; ++i) {
        REQUIRE_NOTHROW(driver.setClickTempo(clickAt(240'000)));
    }
    REQUIRE_NOTHROW(driver.setClickTempo(clickAt(60'000)));  // the newest: one beat a second
    // Owned: the live table, the ones handed over and the one waiting.
    CHECK(driver.clickTempoTables() <= GraphDriver::kClickTempoTables + 1);

    std::vector<std::vector<float>> capture;
    for (int b = 0; b < 48'000 * 5 / 2 / 64; ++b) {
        device.pumpAll(1, capture);
        driver.poll();
    }
    driver.stop();
    // Every superseded table was reclaimed: only the live one is left.
    CHECK(driver.clickTempoTables() == 1);
    // After the beat at 0 and the hand-over, the beats are a second apart.
    const std::vector<std::size_t> found = clickOnsets(capture[0]);
    REQUIRE(found.size() >= 3);
    CHECK(found[found.size() - 1] == 96'000);
    CHECK(found[found.size() - 2] == 48'000);
}

TEST_CASE("The click tempo hand-over neither allocates on the audio thread nor leaks tables", "[driver][click][alloc]") {
    GraphDriver driver({});
    driver.publish(constantGraph(0.0f));
    host::ManualAudioDevice device;
    driver.setClick(true, 1.0f);
    driver.play();
    driver.start(device, config(64));
    std::vector<std::vector<float>> capture;
    device.pumpAll(1, capture);
    for (int round = 0; round < 4; ++round) {
        for (int i = 0; i < 12; ++i) {
            driver.setClickTempo(clickAt(100'000 + round * 1'000 + i));  // control side allocates; fine
        }
        const auto before = rt::allocationViolations();
        device.pumpAll(1, capture);
        CHECK(rt::allocationViolations() == before);
        driver.poll();
    }
    device.pumpAll(1, capture);
    driver.poll();
    driver.stop();
    CHECK(driver.clickTempoTables() == 1);
}

// ---- DSP load and the master loudness meter (m5b-engine-load-loudness) ----------

namespace {

constexpr int kLoudBlock = 480;  // 10 ms at 48 kHz

bool minusInfinity(float value) {
    return std::isinf(value) && value < 0.0f;
}

// A 1 kHz sine on both channels at `dbfs` peak, phase-locked to the timeline.
class SineNode final : public graph::Node {
public:
    explicit SineNode(double dbfs, double rate) : amplitude_(std::pow(10.0, dbfs / 20.0)), rate_(rate) {}
    int outputChannels() const override { return 2; }
    void process(const graph::ProcessContext& context, std::span<const graph::AudioBufferView>,
                 const graph::AudioBufferView& output) noexcept override {
        for (int i = 0; i < context.frames; ++i) {
            const double phase =
                2.0 * 3.14159265358979323846 * 1'000.0 * static_cast<double>(context.blockStart + i) / rate_;
            const auto v = static_cast<float>(amplitude_ * std::sin(phase));
            output.channel(0)[i] = v;
            output.channel(1)[i] = v;
        }
    }

private:
    double amplitude_;
    double rate_;
};

// sine -> fader at `gainMilliDb` (the master gain node of the playback graph).
std::unique_ptr<graph::PreparedGraph> sineGraph(double dbfs, std::int32_t gainMilliDb = 0, double rate = 48'000.0) {
    graph::GraphBuilder b;
    const auto sine = b.add(std::make_unique<SineNode>(dbfs, rate), "sine");
    const auto gain = b.add(std::make_unique<graph::TrackFaderNode>(2, gainMilliDb, 0, false), "master.gain");
    b.connect(sine, gain);
    b.setOutput(gain);
    return std::move(b).compile(kLoudBlock);
}

// Pumps `seconds` of callbacks of kLoudBlock device frames, polling between them.
void pumpSeconds(GraphDriver& driver, host::ManualAudioDevice& device, double seconds,
                 std::vector<std::vector<float>>* capture = nullptr, int deviceRate = 48'000) {
    const int blocks = static_cast<int>(std::lround(seconds * deviceRate / kLoudBlock));
    std::vector<std::vector<float>> scratch;
    for (int b = 0; b < blocks; ++b) {
        device.pumpAll(1, capture != nullptr ? *capture : scratch);
        driver.poll();
        if (capture == nullptr) {
            scratch.clear();
        }
    }
}

}  // namespace

TEST_CASE("The driver reports DSP load from the callback clock", "[driver][load][alloc]") {
    GraphDriver::Options options;
    options.nowNanos = &fakeClock;
    GraphDriver driver(options);
    driver.publish(constantGraph(1.0f));
    host::ManualAudioDevice device;
    driver.play();
    driver.start(device, config(kLoudBlock));
    const auto before = rt::allocationViolations();
    fakeStepNanos = 2'500'000;  // a quarter of the 10 ms period
    device.pump(99);
    CHECK(driver.load().average() == 0.0);  // not a full second yet
    CHECK(driver.load().peak() == 0.0);
    device.pump(1);
    CHECK(std::abs(driver.load().average() - 0.25) <= 1e-9);
    CHECK(std::abs(driver.load().peak() - 0.25) <= 1e-9);
    fakeStepNanos = 1'000'000;
    device.pump(99);
    fakeStepNanos = 9'000'000;
    device.pump(1);
    CHECK(std::abs(driver.load().average() - (99.0 * 1.0 + 9.0) / 1'000.0) <= 1e-9);
    CHECK(std::abs(driver.load().peak() - 0.9) <= 1e-9);
    CHECK(rt::allocationViolations() == before);
    driver.stop();

    // A device's start restarts the window, as it restarts the CallbackTimer.
    driver.start(device, config(kLoudBlock));
    CHECK(driver.load().average() == 0.0);
    CHECK(driver.load().peak() == 0.0);
    driver.stop();
}

TEST_CASE("Before the first start the loudness reads minus infinity", "[driver][loudness]") {
    GraphDriver driver({});
    driver.publish(sineGraph(-23.0));
    const realtime::LoudnessReading reading = driver.loudness();
    CHECK(minusInfinity(reading.momentary));
    CHECK(minusInfinity(reading.shortTerm));
    CHECK(minusInfinity(reading.integrated));
    driver.requestLoudnessReset();  // stopped, nothing to restart: fine
    CHECK(minusInfinity(driver.loudness().integrated));
}

TEST_CASE("The loudness meter reads the master output before the click", "[driver][loudness][click][alloc]") {
    const auto run = [](bool click, std::vector<std::vector<float>>& capture) {
        GraphDriver driver({});
        driver.publish(sineGraph(-23.0));
        driver.setClickTempo(clickAt(120'000));
        driver.setClick(click, 1.0f);
        host::ManualAudioDevice device;
        driver.play();
        driver.start(device, config(kLoudBlock));
        const auto before = rt::allocationViolations();
        pumpSeconds(driver, device, 10.0, &capture);
        CHECK(rt::allocationViolations() == before);
        const realtime::LoudnessReading reading = driver.loudness();
        driver.stop();
        return reading;
    };
    std::vector<std::vector<float>> plain;
    std::vector<std::vector<float>> clicked;
    const realtime::LoudnessReading quiet = run(false, plain);
    const realtime::LoudnessReading loud = run(true, clicked);
    CHECK(plain != clicked);                   // the click is in the output...
    CHECK(loud.momentary == quiet.momentary);  // ...and in none of the readings
    CHECK(loud.shortTerm == quiet.shortTerm);
    CHECK(loud.integrated == quiet.integrated);
    CHECK(std::abs(quiet.integrated - -23.0f) <= 0.1f);
    CHECK(std::abs(quiet.momentary - -23.0f) <= 0.1f);

    // The driver's reading is the meter's over exactly what the device played.
    dsp::LoudnessMeter reference(48'000.0, 2);
    const float* channels[] = {plain[0].data(), plain[1].data()};
    reference.process(channels, 2, static_cast<int>(plain[0].size()));
    CHECK(quiet.momentary == static_cast<float>(reference.momentary()));
    CHECK(quiet.shortTerm == static_cast<float>(reference.shortTerm()));
    CHECK(quiet.integrated == static_cast<float>(reference.integrated()));
}

TEST_CASE("The master gain at -6 dB lowers the loudness by 6 LU", "[driver][loudness]") {
    const auto integrated = [](std::int32_t gainMilliDb) {
        GraphDriver driver({});
        driver.publish(sineGraph(-20.0, gainMilliDb));
        host::ManualAudioDevice device;
        driver.play();
        driver.start(device, config(kLoudBlock));
        pumpSeconds(driver, device, 5.0);
        const float value = driver.loudness().integrated;
        driver.stop();
        return value;
    };
    const float unity = integrated(0);
    const float lowered = integrated(-6'000);
    CHECK(std::abs(unity - -20.0f) <= 0.1f);
    CHECK(std::abs((unity - lowered) - 6.0f) <= 0.01f);
}

TEST_CASE("The loudness history survives a graph swap and a device change", "[driver][loudness][alloc]") {
    GraphDriver driver({});
    driver.publish(sineGraph(-23.0));
    host::ManualAudioDevice device;
    driver.play();
    driver.start(device, config(kLoudBlock));
    const auto before = rt::allocationViolations();
    pumpSeconds(driver, device, 10.0);
    REQUIRE(std::abs(driver.loudness().integrated - -23.0f) <= 0.1f);

    // A structural publish: duck, swap, rise. The new graph is 7 LU quieter; a
    // meter that restarted would read about -30 after two seconds.
    driver.publish(sineGraph(-30.0));
    pumpSeconds(driver, device, 2.0);
    REQUIRE_FALSE(driver.transitionInFlight());
    const float afterSwap = driver.loudness().integrated;
    CHECK(afterSwap > -25.0f);
    CHECK(afterSwap < -23.0f);
    CHECK(std::abs(driver.loudness().momentary - -30.0f) <= 0.1f);
    CHECK(rt::allocationViolations() == before);

    // Another device configuration at the same session rate: the meter is kept.
    driver.stop();
    const realtime::LoudnessReading stopped = driver.loudness();
    host::ManualAudioDevice other;
    driver.start(other, config(256));
    CHECK(driver.loudness().integrated == stopped.integrated);
    CHECK(driver.loudness().momentary == stopped.momentary);
    const auto during = rt::allocationViolations();
    for (int i = 0; i < 48'000 * 2 / 256; ++i) {
        other.pump(1);
        driver.poll();
    }
    CHECK(rt::allocationViolations() == during);
    CHECK(driver.loudness().integrated > -25.0f);
    CHECK(driver.loudness().integrated < afterSwap);  // more of the quieter tone, still one history
    driver.stop();

    // Another session rate is another meter.
    host::AudioDeviceConfig rate44 = config(kLoudBlock);
    rate44.sampleRate = 44'100;
    driver.start(other, rate44);
    CHECK(minusInfinity(driver.loudness().integrated));
    CHECK(minusInfinity(driver.loudness().momentary));
    driver.stop();
}

TEST_CASE("A locate and a transport stop do not restart the integrated value; a reset request does",
          "[driver][loudness][alloc]") {
    GraphDriver driver({});
    driver.publish(sineGraph(-23.0));
    host::ManualAudioDevice device;
    driver.play();
    driver.start(device, config(kLoudBlock));
    const auto before = rt::allocationViolations();
    pumpSeconds(driver, device, 10.0);
    REQUIRE(std::abs(driver.loudness().integrated - -23.0f) <= 0.1f);

    // Stopped: digital silence. Momentary and short-term fall; integrated takes
    // the three gating blocks that overlap the stop, then holds (the absolute
    // gate drops silent blocks).
    driver.pause();
    pumpSeconds(driver, device, 0.5);
    const float integrated = driver.loudness().integrated;
    CHECK(std::abs(integrated - -23.0f) <= 0.1f);
    pumpSeconds(driver, device, 3.5);
    CHECK(minusInfinity(driver.loudness().momentary));
    CHECK(minusInfinity(driver.loudness().shortTerm));
    CHECK(driver.loudness().integrated == integrated);

    // A locate that starts the transport again, on a quieter graph: one history.
    driver.publish(sineGraph(-30.0));
    pumpSeconds(driver, device, 0.1);
    REQUIRE(driver.pushLocate(realtime::TransportCommand{1, 480'000, true}));
    pumpSeconds(driver, device, 2.0);
    REQUIRE(driver.playing());
    REQUIRE(driver.appliedLocate() == 1);
    const float afterLocate = driver.loudness().integrated;
    CHECK(afterLocate > -25.0f);
    CHECK(afterLocate < integrated);
    // A locate while playing: still one history.
    REQUIRE(driver.pushLocate(realtime::TransportCommand{2, 0, true}));
    pumpSeconds(driver, device, 0.5);
    REQUIRE(driver.appliedLocate() == 2);
    CHECK(driver.loudness().integrated > -25.0f);

    // The reset: integrated restarts; what follows is the -30 dBFS tone alone.
    driver.requestLoudnessReset();
    device.pump(1);
    CHECK(minusInfinity(driver.loudness().integrated));
    CHECK(std::abs(driver.loudness().momentary - -30.0f) <= 0.1f);  // momentary is not restarted
    pumpSeconds(driver, device, 5.0);
    CHECK(std::abs(driver.loudness().integrated - -30.0f) <= 0.1f);
    CHECK(rt::allocationViolations() == before);

    // While stopped the control side applies a reset itself.
    driver.stop();
    driver.requestLoudnessReset();
    CHECK(minusInfinity(driver.loudness().integrated));
}

TEST_CASE("The loudness meter runs at the session rate behind device-side SRC", "[driver][loudness][src]") {
    GraphDriver driver({});
    driver.publish(sineGraph(-23.0));
    host::ManualAudioDevice::Options deviceOptions;
    deviceOptions.fixedSampleRate = 44'100;  // the device runs at another rate
    host::ManualAudioDevice device(deviceOptions);
    driver.play();
    driver.start(device, config(kLoudBlock));
    REQUIRE(driver.resampling().active);
    pumpSeconds(driver, device, 6.0, nullptr, 44'100);
    CHECK(std::abs(driver.loudness().integrated - -23.0f) <= 0.1f);
    driver.stop();
}
