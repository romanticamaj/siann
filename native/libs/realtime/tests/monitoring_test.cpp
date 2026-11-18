// Input monitoring through the graph driver (m5b-engine-monitoring; spec,
// "Recording" and "Latency model"): the driver hands each callback's input to
// the graph, a MonitorInputNode passes it to the device output in the same
// callback, and a graph that monitors runs while the transport is stopped. The
// capture bank writes each slot's monitor gate on the audio thread. This binary
// links siann_rt_alloc_guard and ManualAudioDevice marks its callback realtime,
// so an allocation on the audio path counts as a violation.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <optional>
#include <random>
#include <string>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/realtime/capture_bank.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "support/signal_metrics.hpp"

namespace fs = std::filesystem;
using namespace siann;
using graph::MonitorGate;
using graph::MonitorInputMode;
using realtime::GraphDriver;

namespace {

constexpr int kBlock = 64;
constexpr int kFade = 32;
constexpr int kInputs = 2;

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-monitor-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    const fs::path& path() const { return path_; }

private:
    fs::path path_;
};

// Every frame distinct and never zero, so a delay, a gap or a silent block shows.
float inputValue(int channel, std::int64_t frame) {
    return static_cast<float>(channel + 1) * 0.1f + static_cast<float>(frame % 1'000) / 100'000.0f;
}

// A track (no clips) whose strip starts with a monitor node on input channel 1,
// into a stereo master; without `mode` the strip has no monitor node (off).
std::unique_ptr<graph::PreparedGraph> trackGraph(std::optional<MonitorInputMode> mode, const MonitorGate* gate,
                                                 graph::NodeId* meterOut = nullptr) {
    graph::GraphBuilder b;
    const graph::NodeId clips =
        b.add(std::make_unique<graph::ClipPlayerNode>(1, std::vector<graph::ClipPlayerNode::Clip>{}), "trk.clips");
    graph::NodeId head = clips;
    if (mode) {
        head = b.add(std::make_unique<graph::MonitorInputNode>(1, *mode, 1, 1, gate, kFade), "trk.monitor");
        b.connect(clips, head);
    }
    const graph::NodeId fader = b.add(std::make_unique<graph::TrackFaderNode>(1, 0, 0, false), "trk.fader");
    const graph::NodeId meter = b.add(std::make_unique<graph::MeterNode>(2), "trk.meter");
    const graph::NodeId master = b.add(std::make_unique<graph::BusNode>(2), "master");
    b.connect(head, fader);
    b.connect(fader, meter);
    if (mode) {
        b.connectLowLatency(meter, master, head);
    } else {
        b.connect(meter, master);
    }
    b.setOutput(master);
    if (meterOut != nullptr) {
        *meterOut = meter;
    }
    return std::move(b).compile(kBlock);
}

host::AudioDeviceConfig config(std::int64_t rate = 48'000, int buffer = kBlock) {
    host::AudioDeviceConfig c;
    c.sampleRate = rate;
    c.bufferFrames = buffer;
    c.inputChannels = kInputs;
    c.outputChannels = 2;
    return c;
}

GraphDriver::Options options(std::size_t slots = 0) {
    GraphDriver::Options o;
    o.fadeFrames = kFade;
    o.capture.slots = slots;
    o.capture.recorder.writerThread = false;
    return o;
}

// A mono track at the master's centre: -3 dB on each side.
constexpr float kCentre = 0.70710678f;

// True when every frame of `out` from `from` is input channel 1 at the frame
// pumped in that position (frame counts from the first pumped block), at the
// fader's centre gain.
bool passesInput(const std::vector<float>& out, std::int64_t from, std::int64_t firstFrame = 0) {
    for (std::size_t i = static_cast<std::size_t>(from); i < out.size(); ++i) {
        const float expected = inputValue(1, firstFrame + static_cast<std::int64_t>(i)) * kCentre;
        if (std::fabs(out[i] - expected) > 1e-5f) {
            return false;
        }
    }
    return true;
}

bool silent(const std::vector<float>& out, std::size_t from = 0) {
    for (std::size_t i = from; i < out.size(); ++i) {
        if (out[i] != 0.0f) {
            return false;
        }
    }
    return true;
}

// The input track of trackGraph(input) plus a second, unmonitored mono track
// playing a constant 0.5 from frame 0 (centre pan too), both into the master.
std::unique_ptr<graph::PreparedGraph> inputAndClipGraph() {
    graph::GraphBuilder b;
    const graph::NodeId clips =
        b.add(std::make_unique<graph::ClipPlayerNode>(1, std::vector<graph::ClipPlayerNode::Clip>{}), "trk.clips");
    const graph::NodeId monitor = b.add(
        std::make_unique<graph::MonitorInputNode>(1, MonitorInputMode::input, 1, 1, nullptr, kFade), "trk.monitor");
    b.connect(clips, monitor);
    const graph::NodeId fader = b.add(std::make_unique<graph::TrackFaderNode>(1, 0, 0, false), "trk.fader");
    const graph::NodeId master = b.add(std::make_unique<graph::BusNode>(2), "master");
    b.connect(monitor, fader);
    b.connectLowLatency(fader, master, monitor);

    auto media = std::make_shared<graph::PlanarAudio>();
    media->channels = 1;
    media->frames = 100'000;
    media->data.assign(1, std::vector<float>(static_cast<std::size_t>(media->frames), 0.5f));
    const graph::NodeId tape = b.add(std::make_unique<graph::ClipPlayerNode>(
                                         1, std::vector<graph::ClipPlayerNode::Clip>{{0, 0, media->frames, 1.0f, media}}),
                                     "tape.clips");
    const graph::NodeId tapeFader = b.add(std::make_unique<graph::TrackFaderNode>(1, 0, 0, false), "tape.fader");
    b.connect(tape, tapeFader);
    b.connect(tapeFader, master);
    b.setOutput(master);
    return std::move(b).compile(kBlock);
}

}  // namespace

TEST_CASE("Input monitoring reaches the output in the same callback, stopped and playing", "[monitor][rt]") {
    GraphDriver driver(options());
    driver.publish(trackGraph(MonitorInputMode::input, nullptr));
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.start(device, config());

    const auto before = rt::allocationViolations();
    std::vector<float> stopped;
    device.pump(8, &stopped);  // the first block rises from silence
    CHECK(passesInput(stopped, kBlock));
    CHECK(driver.playhead() == 0);  // stopped: the playhead stays

    driver.play();
    std::vector<float> playing;
    device.pump(8, &playing);
    CHECK(passesInput(playing, 0, 8 * kBlock));
    CHECK(driver.playhead() == 8 * kBlock);
    CHECK(rt::allocationViolations() == before);
    driver.stop();
}

// Transport::play() starts through pushLocate. A start used to raise the whole
// driver output from zero ("from silence"), which no longer holds once a graph
// is audible while stopped: the monitored input dropped to silence and faded
// back in at every play or record start. Only the sources rise now.
TEST_CASE("A start through pushLocate keeps monitored input at full level and raises the clips", "[monitor][rt]") {
    GraphDriver driver(options());
    driver.publish(inputAndClipGraph());
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.start(device, config());

    const auto before = rt::allocationViolations();
    std::vector<float> stopped;
    device.pump(8, &stopped);  // the first block rises from silence; the tape is silent while stopped
    CHECK(passesInput(stopped, kBlock));

    // A locate while stopped moves nothing audible: the input stays.
    REQUIRE(driver.pushLocate(realtime::TransportCommand{1, 4'800, false}));
    std::vector<float> located;
    device.pump(2, &located);
    CHECK(passesInput(located, 0, 8 * kBlock));

    // The production start: a locate that carries play.
    REQUIRE(driver.pushLocate(realtime::TransportCommand{2, 9'600, true}));
    std::vector<float> playing;
    device.pump(4, &playing);
    REQUIRE(playing.size() == 4 * kBlock);
    const std::int64_t first = 10 * kBlock;
    // Every frame carries the input at full level; the rest is the tape, rising
    // linearly from zero over the fade (i / kFade) and at full level after it.
    const float fullTape = 0.5f * kCentre;
    int wrong = 0;
    for (std::size_t i = 0; i < playing.size(); ++i) {
        const float tape = playing[i] - inputValue(1, first + static_cast<std::int64_t>(i)) * kCentre;
        const float rise = std::min(static_cast<float>(i) / static_cast<float>(kFade), 1.0f);
        if (std::fabs(tape - fullTape * rise) > 1e-5f) {
            ++wrong;
        }
    }
    CHECK(wrong == 0);
    CHECK(driver.playing());
    CHECK(driver.playhead() == 9'600 + 4 * kBlock);
    CHECK(rt::allocationViolations() == before);
    driver.stop();
}

TEST_CASE("A stopped monitoring graph publishes its meters; a graph without one stays idle", "[monitor][meter]") {
    {
        graph::NodeId meter = 0;
        GraphDriver driver(options());
        driver.publish(trackGraph(MonitorInputMode::input, nullptr, &meter));
        host::ManualAudioDevice device;
        device.setInputGenerator(&inputValue);
        driver.start(device, config());
        device.pump(4);
        bool sawTrack = false;
        realtime::MeterSample sample;
        while (driver.popMeter(sample)) {
            if (sample.slot == meter) {
                sawTrack = true;
                CHECK(sample.reading.peak[0] > 0.1f);  // the input, while stopped
            }
        }
        CHECK(sawTrack);
        driver.stop();
    }
    {
        GraphDriver driver(options());
        driver.publish(trackGraph(std::nullopt, nullptr));
        host::ManualAudioDevice device;
        device.setInputGenerator(&inputValue);
        driver.start(device, config());
        std::vector<float> out;
        device.pump(4, &out);
        realtime::MeterSample sample;
        CHECK_FALSE(driver.popMeter(sample));  // not processed while stopped, as before
        CHECK(silent(out));
        driver.play();
        out.clear();
        device.pump(4, &out);
        CHECK(silent(out));  // off never passes the input
        driver.stop();
    }
}

TEST_CASE("Auto monitoring follows the bank's gate: stopped and armed, or capturing", "[monitor][record][rt]") {
    TempDir dir;
    GraphDriver driver(options(2));
    realtime::CaptureBank& bank = *driver.captureBank();
    MonitorGate gate;
    driver.publish(trackGraph(MonitorInputMode::automatic, &gate));
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.start(device, config());
    const auto before = rt::allocationViolations();

    // Stopped, unarmed: nothing passes (the clips are silent while stopped).
    std::vector<float> out;
    device.pump(4, &out);
    CHECK(silent(out));
    std::int64_t frame = 4 * kBlock;

    // Stopped and armed: the input, after one fade.
    gate.armed.store(true);
    bank.arm(1, 1, 1);
    bank.bindMonitorGate(1, &gate);
    out.clear();
    device.pump(4, &out);
    CHECK(passesInput(out, kFade, frame));
    frame += 4 * kBlock;

    // Playing, armed but not capturing: the clips (silence) again.
    driver.play();
    out.clear();
    device.pump(4, &out);
    CHECK(silent(out, kFade));
    frame += 4 * kBlock;
    CHECK_FALSE(gate.capturing.load());

    // Capturing: the bank flips the gate on the audio thread; the input passes.
    bank.recorder(1).start(dir.path() / "take.wav", 48'000, {}, {}, 1);
    out.clear();
    device.pump(4, &out);
    CHECK(gate.capturing.load());
    CHECK(passesInput(out, kBlock + kFade, frame));
    frame += 4 * kBlock;
    bank.recorder(1).drain();
    CHECK(bank.recorder(1).stop().frames >= 3 * kBlock);

    // Stopped after the take, still armed: the input (stopped and armed).
    driver.pause();
    out.clear();
    device.pump(4, &out);
    CHECK_FALSE(gate.capturing.load());
    CHECK(passesInput(out, kBlock, frame));

    // Disarmed while stopped: nothing again.
    bank.bindMonitorGate(1, nullptr);
    bank.disarm(1);
    gate.armed.store(false);
    out.clear();
    device.pump(4, &out);
    CHECK(silent(out, kFade));
    CHECK(rt::allocationViolations() == before);
    driver.stop();
}

TEST_CASE("Gate flips and a publish while monitoring allocate nothing on the audio thread", "[monitor][rt]") {
    GraphDriver driver(options(1));
    realtime::CaptureBank& bank = *driver.captureBank();
    MonitorGate gate;
    driver.publish(trackGraph(MonitorInputMode::automatic, &gate));
    host::ManualAudioDevice device;
    device.setInputGenerator(&inputValue);
    driver.start(device, config());
    auto next = trackGraph(MonitorInputMode::input, &gate);  // built on the control side
    const auto before = rt::allocationViolations();
    bank.arm(0, 1, 1);
    bank.bindMonitorGate(0, &gate);
    gate.armed.store(true);
    device.pump(3);
    gate.armed.store(false);
    device.pump(3);
    driver.play();
    device.pump(3);
    driver.publish(std::move(next));  // a structural change: duck, swap, rise
    std::vector<float> out;
    device.pump(6, &out);
    driver.poll();
    CHECK_FALSE(driver.transitionInFlight());
    CHECK(rt::allocationViolations() == before);
    // After the swap the input passes (input mode), playing.
    CHECK(std::fabs(out.back()) > 0.05f);
    driver.stop();
}

TEST_CASE("Through device-side SRC the monitored input arrives after exactly the reported terms", "[monitor][src]") {
    // Session 44.1 kHz on a 48 kHz device, and the other way round.
    struct Rates {
        std::int64_t session;
        std::int64_t device;
    };
    for (const Rates rates : {Rates{44'100, 48'000}, Rates{48'000, 44'100}}) {
        for (const int buffer : {37, 64, 100, 256, 1000}) {
            INFO("session " << rates.session << " Hz, device " << rates.device << " Hz, buffer " << buffer);
            GraphDriver driver(options());
            driver.publish(trackGraph(MonitorInputMode::input, nullptr));
            host::ManualAudioDevice::Options deviceOptions;
            deviceOptions.fixedSampleRate = rates.device;
            host::ManualAudioDevice device(deviceOptions);
            constexpr std::int64_t kAt = 20'000;  // device input frame of the impulse
            device.setInputGenerator([](int channel, std::int64_t f) { return channel == 1 && f == kAt ? 1.0f : 0.0f; });
            driver.start(device, config(rates.session, buffer));
            const realtime::LatencyReport report = driver.latency();
            CHECK(report.srcMonitorFifoFrames > 0);
            CHECK(report.monitorRoundTripFrames == report.srcOutputLatencyFrames +
                                                       report.srcMonitorFifoFrames);
            const auto before = rt::allocationViolations();
            std::vector<float> out;
            device.pump(static_cast<int>(2 * rates.device / buffer), &out);
            CHECK(rt::allocationViolations() == before);
            CHECK(driver.srcUnderruns() == 0);
            CHECK(driver.srcMonitorUnderruns() == 0);
            const double expected =
                static_cast<double>(kAt) + static_cast<double>(report.monitorRoundTripFrames) *
                                               static_cast<double>(rates.device) / static_cast<double>(rates.session);
            const auto peak = test::peakIndex(out);
            INFO("peak at " << peak << ", expected " << expected);
            CHECK(std::fabs(static_cast<double>(peak) - expected) <= 1.0);
            driver.stop();
        }
    }
}

TEST_CASE("The monitored round trip is the device terms plus the monitored path", "[monitor][latency]") {
    host::ManualAudioDevice::Options deviceOptions;
    deviceOptions.inputLatencyFrames = 128;
    deviceOptions.outputLatencyFrames = 192;
    host::ManualAudioDevice device(deviceOptions);
    GraphDriver driver(options());

    // A latent insert on the monitored strip counts; one on another track does not.
    graph::GraphBuilder b;
    const graph::NodeId clips =
        b.add(std::make_unique<graph::ClipPlayerNode>(1, std::vector<graph::ClipPlayerNode::Clip>{}), "a.clips");
    const graph::NodeId monitor =
        b.add(std::make_unique<graph::MonitorInputNode>(1, MonitorInputMode::input, 0, 1, nullptr, kFade), "a.monitor");
    const graph::NodeId insertA = b.add(std::make_unique<graph::FakeLatencyNode>(1, 40), "a.insert");
    const graph::NodeId other =
        b.add(std::make_unique<graph::ClipPlayerNode>(1, std::vector<graph::ClipPlayerNode::Clip>{}), "b.clips");
    const graph::NodeId insertB = b.add(std::make_unique<graph::FakeLatencyNode>(1, 300), "b.insert");
    const graph::NodeId master = b.add(std::make_unique<graph::BusNode>(1), "master");
    b.connect(clips, monitor);
    b.connect(monitor, insertA);
    b.connectLowLatency(insertA, master, monitor);
    b.connect(other, insertB);
    b.connect(insertB, master);
    b.setOutput(master);
    driver.publish(std::move(b).compile(kBlock));
    driver.start(device, config());
    const realtime::LatencyReport report = driver.latency();
    CHECK(report.srcMonitorFifoFrames == 0);
    CHECK(report.monitorInputPathFrames == 40);
    CHECK(report.monitorRoundTripFrames == 128 + 192 + 40);
    // The record offset still follows the master path (300), not the monitored one.
    CHECK(report.recordOffsetFrames == 128 + 192 + 300);
    driver.stop();

    // Without a monitored track the path adds nothing.
    GraphDriver plain(options());
    plain.publish(trackGraph(std::nullopt, nullptr));
    host::ManualAudioDevice other2(deviceOptions);
    plain.start(other2, config());
    CHECK(plain.latency().monitorRoundTripFrames == 128 + 192);
    plain.stop();
}
