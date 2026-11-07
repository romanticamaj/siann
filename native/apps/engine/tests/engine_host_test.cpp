// EngineHost in process (m4-engine-device; spec, "Process model"): the session's
// playback graph on a device, the transport and status ports the protocol server
// uses, and the auditioner behind AuditionPort. ManualAudioDevice runs a known
// number of blocks; the callback is marked realtime and this binary links
// siann_rt_alloc_guard, so an allocation on the audio path counts as a violation.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "live_rig.hpp"
#include "siann/engine_app/engine_host.hpp"
#include "siann/host/fake_audio_device.hpp"
#include "siann/host/fake_callback_clock.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/protocol/transport_port.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "support/flac_test_encoder.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using namespace std::chrono_literals;
using engine_app::DeviceBackoff;
using engine_app::EngineHost;
using engine_app::EngineHostOptions;
using host::ManualAudioDevice;
using live_rig::Fixture;
using live_rig::kBlock;
using protocol::TransportPortError;
using Clock = std::chrono::steady_clock;

namespace {

namespace fs = std::filesystem;

constexpr DeviceBackoff kBackoff{100ms, 300ms, 1'000ms};

// A ManualAudioDevice that another application holds for the first `refusals` opens.
class HeldDevice final : public host::AudioDevice {
public:
    explicit HeldDevice(int refuse = 0) : refusals(refuse) {}

    host::AudioDeviceStatus open(const host::AudioDeviceConfig& config) override {
        ++opens;
        if (refusals > 0) {
            --refusals;
            throw host::DeviceError("device_open_failed", "the device is held by another application");
        }
        return inner.open(config);
    }
    void start(host::AudioCallback callback) override { inner.start(std::move(callback)); }
    void setOnStopped(std::function<void(bool)> handler) override { inner.setOnStopped(std::move(handler)); }
    void stop() override { inner.stop(); }
    void close() override { inner.close(); }

    ManualAudioDevice inner;
    int refusals = 0;
    int opens = 0;
};

EngineHostOptions manualOptions(std::unique_ptr<host::AudioDevice> device) {
    EngineHostOptions options;
    options.device = std::move(device);
    options.deviceId = "manual";
    options.bufferFrames = kBlock;
    options.playback = live_rig::testOptions();
    return options;
}

// A host over the two-track fixture on a device the test pumps by hand.
struct Rig {
    Fixture fixture;
    HeldDevice* held = nullptr;
    ManualAudioDevice* device = nullptr;
    std::vector<std::string> diagnostics;
    Clock::time_point now{};  // what the host's backoff sees: only advance() moves it
    std::unique_ptr<EngineHost> host;

    explicit Rig(int refusals = 0) { build({}, refusals); }
    explicit Rig(playback::PlaybackOptions options) {
        build(std::optional<playback::PlaybackOptions>(std::move(options)), 0);
    }

    void build(std::optional<playback::PlaybackOptions> playbackOptions, int refusals) {
        auto device_ = std::make_unique<HeldDevice>(refusals);
        held = device_.get();
        device = &held->inner;
        EngineHostOptions options = manualOptions(std::move(device_));
        if (playbackOptions) {
            options.playback = std::move(*playbackOptions);
        }
        options.diagnostic = [this](const std::string& line) { diagnostics.push_back(line); };
        options.backoff = kBackoff;
        options.clock = [this] { return now; };
        host = std::make_unique<EngineHost>(fixture.session, std::move(options));
    }

    playback::PlaybackEngine& engine() { return host->playback(); }

    void advance(Clock::duration by) {
        now += by;
        host->tick();
    }

    // What the control thread and the butler do between blocks.
    void service() {
        host->tick();
        engine().butler().runOnce();
        host->tick();
    }

    // Until a pending locate (or a start) has gone to the audio thread.
    void settle() {
        for (int i = 0; i < 1'000 && engine().transport().pendingLocate(); ++i) {
            service();
        }
        REQUIRE_FALSE(engine().transport().pendingLocate());
    }

    void pump(int blocks) {
        for (int b = 0; b < blocks; ++b) {
            device->pump(1);
            service();
        }
    }

    std::int64_t position() const { return host->transportState().position; }
};

class RefusingDevice final : public host::AudioDevice {
public:
    host::AudioDeviceStatus open(const host::AudioDeviceConfig&) override {
        throw host::DeviceError("device_open_failed", "the device is held by another application");
    }
    void start(host::AudioCallback) override {}
    void setOnStopped(std::function<void(bool)>) override {}
    void stop() override {}
    void close() override {}
};

std::set<fs::path> mediaFiles(const fs::path& bundle) {
    std::set<fs::path> files;
    for (const fs::directory_entry& entry : fs::recursive_directory_iterator(bundle / "media")) {
        if (entry.is_regular_file()) {
            files.insert(entry.path());
        }
    }
    return files;
}

// As long as a header, and not one.
std::string junkWave() {
    return "JUNK" + std::string(60, '\0');
}

std::string codeOf(const std::function<void()>& call) {
    try {
        call();
    } catch (const TransportPortError& error) {
        return error.code();
    }
    return "none";
}

void checkNoTransport(EngineHost& host) {
    CHECK(codeOf([&] { host.play(); }) == "no_device");
    CHECK(codeOf([&] { host.stop(); }) == "no_device");
    CHECK(codeOf([&] { host.locate(0); }) == "no_device");
}

}  // namespace

TEST_CASE("the engine host plays, advances the playhead, locates and stops", "[engine][host]") {
    const std::uint64_t violations = rt::allocationViolations();
    Rig rig;

    const protocol::EngineStatus before = rig.host->status();
    REQUIRE(before.device.has_value());
    CHECK(before.device->id == "manual");
    CHECK(before.device->sampleRate == 48'000);
    CHECK(before.device->bufferFrames == kBlock);
    CHECK_FALSE(before.deviceError.has_value());
    CHECK_FALSE(before.playing);

    // The engine never starts on its own: the device runs, the playhead does not.
    rig.pump(4);
    CHECK_FALSE(rig.host->status().playing);
    CHECK(rig.position() == 0);

    const protocol::TransportState played = rig.host->play();
    CHECK(played.playing);
    CHECK(played.position == 0);
    rig.settle();
    rig.pump(8);
    CHECK(rig.host->status().playing);
    CHECK(rig.position() == 8 * kBlock);

    const protocol::TransportState located = rig.host->locate(96'000);
    CHECK(located.playing);
    CHECK(located.position == 96'000);
    rig.settle();
    rig.pump(4);  // the duck, then the move
    const std::int64_t after = rig.position();
    CHECK(after >= 96'000);
    rig.pump(3);
    CHECK(rig.position() == after + 3 * kBlock);

    const protocol::TransportState stopped = rig.host->stop();
    CHECK_FALSE(stopped.playing);
    rig.pump(1);
    const std::int64_t frozen = rig.position();
    rig.pump(4);
    CHECK(rig.position() == frozen);
    CHECK_FALSE(rig.host->status().playing);

    rig.host->stop();  // twice is fine
    CHECK(rt::allocationViolations() == violations);
}

TEST_CASE("the engine host runs on the paced fake device with its own butler", "[engine][host]") {
    const std::uint64_t violations = rt::allocationViolations();
    Fixture fixture;
    host::FakeAudioDevice::Options deviceOptions;
    deviceOptions.paced = true;
    deviceOptions.speed = 16.0;
    EngineHostOptions options;
    options.device = std::make_unique<host::FakeAudioDevice>(deviceOptions);
    options.deviceId = "fake";
    options.playback.ringFrames = 8'192;
    EngineHost host(fixture.session, std::move(options));

    host.play();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (host.transportState().position < 8'192 && std::chrono::steady_clock::now() < deadline) {
        host.tick();
        std::this_thread::yield();
    }
    CHECK(host.transportState().position >= 8'192);
    CHECK(host.status().playing);
    host.shutdown();
    CHECK(rt::allocationViolations() == violations);
}

TEST_CASE("without a device the host serves and play answers no_device", "[engine][host]") {
    Fixture fixture;
    std::vector<std::string> diagnostics;
    const auto log = [&diagnostics](const std::string& line) { diagnostics.push_back(line); };

    SECTION("none was asked for or built in") {
        EngineHostOptions options;
        options.deviceError = protocol::DeviceProblem{"no_audio_backend", "built without an audio backend"};
        options.diagnostic = log;
        EngineHost host(fixture.session, std::move(options));

        const protocol::EngineStatus status = host.status();
        CHECK_FALSE(status.device.has_value());
        REQUIRE(status.deviceError.has_value());
        CHECK(status.deviceError->code == "no_audio_backend");
        CHECK_FALSE(status.playing);
        checkNoTransport(host);
        REQUIRE(diagnostics.size() == 1);
        CHECK(diagnostics[0].find("no_audio_backend") != std::string::npos);
        // The auditioner still follows the session, for when a device is there.
        REQUIRE(host.auditionPort() != nullptr);
        fixture.exec(live_rig::addTrack("trk_c"));
        host.auditionPort()->mainCommitted();
        host.tick();
        CHECK(host.playback().compileCount() == 2);
    }
    SECTION("the device refused to open") {
        EngineHostOptions options;
        options.device = std::make_unique<RefusingDevice>();
        options.deviceId = "ASIO/Busy";
        options.diagnostic = log;
        EngineHost host(fixture.session, std::move(options));

        const protocol::EngineStatus status = host.status();
        CHECK_FALSE(status.device.has_value());
        REQUIRE(status.deviceError.has_value());
        CHECK(status.deviceError->code == "device_open_failed");
        CHECK(status.deviceError->message == "the device is held by another application");
        checkNoTransport(host);
        CHECK(diagnostics.size() == 1);
        host.tick();
        CHECK(diagnostics.size() == 1);  // said once, not on every tick
    }
}

TEST_CASE("a device lost while running leaves the host serving", "[engine][host]") {
    Rig rig;
    rig.host->play();
    rig.settle();
    rig.pump(2);

    rig.device->reportLost();
    rig.host->tick();

    const protocol::EngineStatus status = rig.host->status();
    CHECK_FALSE(status.device.has_value());
    REQUIRE(status.deviceError.has_value());
    CHECK(status.deviceError->code == "device_lost");
    CHECK_FALSE(status.playing);
    checkNoTransport(*rig.host);
    REQUIRE(rig.diagnostics.size() == 1);
    CHECK(rig.diagnostics[0].find("device_lost") != std::string::npos);
}

TEST_CASE("a device that refuses to open is tried again under the backoff", "[engine][host][backoff]") {
    const std::uint64_t violations = rt::allocationViolations();
    Rig rig(2);
    CHECK(rig.held->opens == 1);
    REQUIRE(rig.host->status().deviceError.has_value());
    CHECK(rig.host->status().deviceError->code == "device_open_failed");
    checkNoTransport(*rig.host);

    rig.advance(99ms);
    CHECK(rig.held->opens == 1);
    rig.advance(1ms);
    CHECK(rig.held->opens == 2);  // refused again
    CHECK_FALSE(rig.host->status().device.has_value());

    rig.advance(199ms);
    CHECK(rig.held->opens == 2);
    rig.advance(1ms);
    CHECK(rig.held->opens == 3);

    const protocol::EngineStatus status = rig.host->status();
    REQUIRE(status.device.has_value());
    CHECK(status.device->sampleRate == 48'000);
    CHECK_FALSE(status.deviceError.has_value());
    rig.advance(10s);
    CHECK(rig.held->opens == 3);  // a running device is left alone

    CHECK_FALSE(rig.host->status().playing);  // reopening never starts the transport
    rig.host->play();
    rig.settle();
    rig.pump(4);
    CHECK(rig.position() == 4 * kBlock);

    // The refusal said once, not per attempt, then that it is back.
    REQUIRE(rig.diagnostics.size() == 2);
    CHECK(rig.diagnostics[0].find("device_open_failed") != std::string::npos);
    CHECK(rig.diagnostics[1].find("running") != std::string::npos);
    CHECK(rt::allocationViolations() == violations);
}

TEST_CASE("the reopen delay stops doubling at the maximum and never gives up", "[engine][host][backoff]") {
    Rig rig(20);
    rig.advance(100ms);
    rig.advance(200ms);
    CHECK(rig.held->opens == 3);
    for (int attempt = 4; attempt <= 21; ++attempt) {
        rig.advance(299ms);
        CHECK(rig.held->opens == attempt - 1);
        rig.advance(1ms);
        CHECK(rig.held->opens == attempt);
    }
    CHECK(rig.host->status().device.has_value());
}

TEST_CASE("a lost device is reopened, stopped at the playhead", "[engine][host][backoff]") {
    const std::uint64_t violations = rt::allocationViolations();
    playback::PlaybackOptions options = live_rig::testOptions();
    options.callbackClock = &host::fakeCallbackClock;
    host::setFakeCallbackNanos(20'000'000);
    Rig rig(options);
    rig.host->play();
    rig.settle();
    rig.pump(4);
    REQUIRE(rig.host->status().xruns > 0);
    rig.device->reportLost();
    rig.host->tick();
    const std::int64_t frozen = rig.position();
    CHECK(frozen > 0);
    REQUIRE(rig.host->status().deviceError.has_value());

    rig.held->refusals = 1;  // still gone at the first try
    rig.advance(100ms);
    CHECK(rig.held->opens == 2);
    REQUIRE(rig.host->status().deviceError.has_value());
    CHECK(rig.host->status().deviceError->code == "device_open_failed");
    rig.advance(200ms);
    CHECK(rig.held->opens == 3);

    const protocol::EngineStatus status = rig.host->status();
    REQUIRE(status.device.has_value());
    CHECK_FALSE(status.playing);
    CHECK(status.xruns == 0);  // counted from this device's start
    CHECK(rig.position() == frozen);

    rig.host->play();
    rig.settle();
    rig.pump(3);
    CHECK(rig.position() == frozen + 3 * kBlock);
    CHECK(rt::allocationViolations() == violations);
}

TEST_CASE("the reopen delay resets once a device has stayed up", "[engine][host][backoff]") {
    Rig rig;
    const auto loseDevice = [&rig] {
        rig.device->reportLost();
        rig.host->tick();
        REQUIRE_FALSE(rig.host->status().device.has_value());
    };

    // A device that drops at once is backed off like one that refuses.
    loseDevice();
    rig.advance(100ms);
    REQUIRE(rig.host->status().device.has_value());
    loseDevice();
    rig.advance(199ms);
    CHECK_FALSE(rig.host->status().device.has_value());
    rig.advance(1ms);
    REQUIRE(rig.host->status().device.has_value());

    rig.advance(1'000ms);
    loseDevice();
    rig.advance(100ms);
    CHECK(rig.host->status().device.has_value());
}

TEST_CASE("only a device that could open is tried again", "[engine][host][backoff]") {
    SECTION("no backend") {
        Fixture fixture;
        Clock::time_point now{};
        EngineHostOptions options;
        options.deviceError = protocol::DeviceProblem{"no_audio_backend", "built without an audio backend"};
        options.clock = [&now] { return now; };
        EngineHost host(fixture.session, std::move(options));
        now += 1h;
        REQUIRE_NOTHROW(host.tick());
        REQUIRE(host.status().deviceError.has_value());
        CHECK(host.status().deviceError->code == "no_audio_backend");
    }
    SECTION("a session that did not load") {
        Fixture fixture;
        fs::remove_all(fixture.bundle() / "media");
        Clock::time_point now{};
        auto device = std::make_unique<HeldDevice>();
        HeldDevice* held = device.get();
        EngineHostOptions options = manualOptions(std::move(device));
        options.clock = [&now] { return now; };
        EngineHost host(fixture.session, std::move(options));
        now += 1h;
        host.tick();
        CHECK(held->opens == 0);
    }
    SECTION("after shutdown") {
        Rig rig(1);
        rig.host->shutdown();
        rig.advance(1h);
        CHECK(rig.held->opens == 1);
    }
}

TEST_CASE("a commit on main reaches the live graph", "[engine][host]") {
    Rig rig;
    rig.host->play();
    rig.settle();
    rig.pump(8);
    const std::size_t compiles = rig.engine().compileCount();
    const auto loud = rig.engine().dispatcher().meter("track:trk_a");
    REQUIRE(loud.has_value());
    REQUIRE(loud->reading.peak[0] > 0.01f);

    // A fader edit goes through the parameter channel: same graph, new sound.
    rig.fixture.exec(R"({"op":"track.set_gain","trackId":"trk_a","gainMilliDb":-60000})");
    rig.host->auditionPort()->mainCommitted();
    rig.service();
    rig.pump(8);
    const auto quiet = rig.engine().dispatcher().meter("track:trk_a");
    REQUIRE(quiet.has_value());
    CHECK(quiet->reading.peak[0] < loud->reading.peak[0] / 100.0f);
    CHECK(rig.engine().compileCount() == compiles);

    // A structural edit compiles and goes live while playing.
    rig.fixture.exec(live_rig::addTrack("trk_c"));
    rig.host->auditionPort()->mainCommitted();
    rig.pump(8);
    CHECK(rig.engine().compileCount() == compiles + 1);
    CHECK(rig.engine().streamFor("trk_c") != nullptr);
    CHECK(rig.engine().driver().liveEpoch() > 1);
}

TEST_CASE("audition.hear reaches the live graph through the port", "[engine][host]") {
    Rig rig;
    REQUIRE(rig.host->auditionPort() != nullptr);
    const command::BranchId branch = rig.fixture.session.branch(rig.fixture.session.history().head().envelope.id);
    rig.fixture.session.commitOn(branch, {live_rig::cmd(live_rig::addTrack("trk_c"))}, "test", "t");

    rig.host->auditionPort()->audition(branch);
    CHECK(rig.host->auditionPort()->heard() == branch);
    rig.pump(4);
    CHECK(rig.engine().streamFor("trk_c") != nullptr);

    rig.host->auditionPort()->hearMain();
    CHECK_FALSE(rig.host->auditionPort()->heard().has_value());
    rig.pump(4);
    CHECK(rig.engine().streamFor("trk_c") == nullptr);

    CHECK_THROWS_AS(rig.host->auditionPort()->audition("no_such_branch"), protocol::AuditionPortError);
}

TEST_CASE("a document the graph cannot load keeps the host serving", "[engine][host]") {
    SECTION("a commit whose media is not in the bundle") {
        Rig rig;
        rig.fixture.session.commit({live_rig::cmd(R"({"op":"media.add","mediaId":"med_gone","contentHash":"sha256:)" +
                                                  std::string(64, 'a') +
                                                  R"(","format":"wav","channels":2,"sampleRate":48000,"frames":"480000"})"),
                                    live_rig::cmd(live_rig::place("clp_gone", "trk_a", "med_gone", 60'000, 0, 1'000))},
                                   "test", "t");
        rig.host->auditionPort()->mainCommitted();
        const std::uint64_t epoch = rig.engine().driver().liveEpoch();
        REQUIRE_NOTHROW(rig.service());
        CHECK(rig.engine().driver().liveEpoch() == epoch);  // the old graph plays on
        REQUIRE(rig.diagnostics.size() == 1);
        CHECK(rig.diagnostics[0].find("media_missing") != std::string::npos);
        CHECK(rig.host->status().device.has_value());
    }
    SECTION("a session opened with its media gone") {
        Fixture fixture;
        std::filesystem::remove_all(fixture.bundle() / "media");
        std::vector<std::string> diagnostics;
        auto device = std::make_unique<ManualAudioDevice>();
        EngineHostOptions options = manualOptions(std::move(device));
        options.diagnostic = [&diagnostics](const std::string& line) { diagnostics.push_back(line); };
        EngineHost host(fixture.session, std::move(options));

        const protocol::EngineStatus status = host.status();
        CHECK_FALSE(status.device.has_value());
        REQUIRE(status.deviceError.has_value());
        CHECK(status.deviceError->code == "media_missing");
        CHECK(host.auditionPort() == nullptr);
        checkNoTransport(host);
        REQUIRE_NOTHROW(host.tick());
        CHECK(diagnostics.size() == 1);
    }
    SECTION("a commit whose media does not decode") {
        Rig rig;
        const fs::path source = rig.fixture.dir.path() / "more.wav";
        io::writeFileAtomic(source, media::encodeWavFloat32(live_rig::distinct(2, 4'800)));
        const std::set<fs::path> before = mediaFiles(rig.fixture.bundle());
        session::importMedia(rig.fixture.session, source, "med_bad", "test", "t");
        for (const fs::path& file : mediaFiles(rig.fixture.bundle())) {
            if (before.count(file) == 0) {
                io::writeFileAtomic(file, junkWave());
            }
        }
        rig.fixture.exec(live_rig::place("clp_bad", "trk_a", "med_bad", 60'000, 0, 1'000));
        rig.host->auditionPort()->mainCommitted();
        const std::uint64_t epoch = rig.engine().driver().liveEpoch();
        REQUIRE_NOTHROW(rig.service());
        CHECK(rig.engine().driver().liveEpoch() == epoch);
        REQUIRE(rig.diagnostics.size() == 1);
        CHECK(rig.diagnostics[0].find("unsupported_media") != std::string::npos);
        CHECK(rig.host->status().device.has_value());
    }
}

TEST_CASE("a session whose media is damaged is served with no graph", "[engine][host]") {
    struct Damage {
        const char* name;
        std::string bytes;
        const char* code;
    };
    const std::vector<Damage> damages{{"not a WAV header", junkWave(), "unsupported_media"},
                                      {"cut off inside the header", std::string("RIFF\x24\0\0\0WAVEfmt ", 16) + "abcd",
                                       "decode_failed"}};
    for (const Damage& damage : damages) {
        DYNAMIC_SECTION(damage.name) {
            Fixture fixture;
            for (const fs::path& file : mediaFiles(fixture.bundle())) {
                io::writeFileAtomic(file, damage.bytes);
            }
            std::vector<std::string> diagnostics;
            EngineHostOptions options = manualOptions(std::make_unique<ManualAudioDevice>());
            options.diagnostic = [&diagnostics](const std::string& line) { diagnostics.push_back(line); };
            std::unique_ptr<EngineHost> host;
            REQUIRE_NOTHROW(host = std::make_unique<EngineHost>(fixture.session, std::move(options)));

            const protocol::EngineStatus status = host->status();
            CHECK_FALSE(status.device.has_value());
            REQUIRE(status.deviceError.has_value());
            CHECK(status.deviceError->code == damage.code);
            CHECK(host->auditionPort() == nullptr);
            checkNoTransport(*host);
            REQUIRE_NOTHROW(host->tick());
            CHECK(diagnostics.size() == 1);
        }
    }
    SECTION("a read that fails outright") {
        Fixture fixture;
        std::vector<std::int16_t> samples(2 * 1'000, 100);
        const fs::path source = fixture.dir.path() / "hit.flac";
        io::writeFileAtomic(source, siann::test::encodeFlac16(2, 48'000, samples, 256));
        const std::set<fs::path> before = mediaFiles(fixture.bundle());
        session::importMedia(fixture.session, source, "med_flac", "test", "t");
        fixture.exec(live_rig::place("clp_flac", "trk_a", "med_flac", 60'000, 0, 1'000));
        for (const fs::path& file : mediaFiles(fixture.bundle())) {
            if (before.count(file) == 0) {
                fs::remove(file);
                fs::create_directory(file);  // exists, and cannot be read as a file
            }
        }
        EngineHostOptions options = manualOptions(std::make_unique<ManualAudioDevice>());
        std::unique_ptr<EngineHost> host;
        REQUIRE_NOTHROW(host = std::make_unique<EngineHost>(fixture.session, std::move(options)));
        REQUIRE(host->status().deviceError.has_value());
        CHECK(host->status().deviceError->code == "load_failed");
    }
}

TEST_CASE("engine.status reports the driver's CallbackTimer", "[engine][host]") {
    playback::PlaybackOptions options = live_rig::testOptions();
    options.callbackClock = &host::fakeCallbackClock;

    SECTION("every callback over its period") {
        host::setFakeCallbackNanos(20'000'000);
        Rig rig(options);
        rig.pump(5);
        const protocol::EngineStatus status = rig.host->status();
        CHECK(status.xruns == 5);
        CHECK(status.xruns == rig.engine().driver().callbackTiming().callbacks());
        CHECK(status.maxCallbackMicros == 20'000.0);
        CHECK(status.unmeasuredCallbacks == 0);
    }
    SECTION("every callback in time") {
        host::setFakeCallbackNanos(1'000'000);
        Rig rig(options);
        rig.pump(5);
        const protocol::EngineStatus status = rig.host->status();
        CHECK(status.xruns == 0);
        CHECK(status.maxCallbackMicros == 1'000.0);
        CHECK(status.unmeasuredCallbacks == 0);
    }
}

TEST_CASE("the host publishes the meter legend after each graph, and frames carry the transport",
          "[engine][host]") {
    Rig rig;
    protocol::ServerOptions serverOptions = protocol::testing::manualOptions();
    serverOptions.transportPort = rig.host.get();
    serverOptions.auditionPort = rig.host->auditionPort();
    protocol::testing::Harness harness(rig.fixture.session, serverOptions);
    const protocol::ConnectionId listener = harness.authed(true);
    const protocol::ConnectionId realtimeConnection = harness.realtimeAuthed();
    rig.host->attachPublisher(harness.server.realtime(), harness.server.events());

    const auto legends = [&] {
        harness.server.pump();  // flushes the event outboxes
        int count = 0;
        for (const json::Value& event : harness.events(listener)) {
            count += event.find("type")->asString() == "meters.legend" ? 1 : 0;
        }
        return count;
    };
    CHECK(legends() == 1);

    // A frame before any meter reading: the transport is what a client needs.
    rig.host->tick();
    auto frames = harness.transport.binary(realtimeConnection);
    REQUIRE_FALSE(frames.empty());
    auto frame = protocol::decodeMeterFrame(frames.back());
    REQUIRE(frame.has_value());
    CHECK_FALSE(frame->playing);
    CHECK(frame->playheadSamples == 0);

    rig.host->locate(4'800);
    rig.host->tick();
    frames = harness.transport.binary(realtimeConnection);
    frame = protocol::decodeMeterFrame(frames.back());
    REQUIRE(frame.has_value());
    CHECK(frame->playheadSamples == 4'800);

    // The command goes through the server; the host follows and tells clients.
    harness.commit(listener, json::Array{json::parse(live_rig::addTrack("trk_c"))});
    for (int i = 0; i < 100 && legends() < 2; ++i) {
        rig.pump(1);
    }
    CHECK(legends() == 2);
}
