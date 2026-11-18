// EngineHost in process (m4-engine-device; spec, "Process model"): the session's
// playback graph on a device, the transport and status ports the protocol server
// uses, and the auditioner behind AuditionPort. ManualAudioDevice runs a known
// number of blocks; the callback is marked realtime and this binary links
// siann_rt_alloc_guard, so an allocation on the audio path counts as a violation.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
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
#include "siann/engine_app/engine.hpp"
#include "siann/engine_app/engine_host.hpp"
#include "siann/host/fake_audio_device.hpp"
#include "siann/host/fake_callback_clock.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/protocol/realtime_channel.hpp"
#include "siann/protocol/transport_port.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "support/flac_test_encoder.hpp"
#include "support/protocol_fixture.hpp"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <stdlib.h>
#include <windows.h>
#endif

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
    void start(host::AudioCallback callback) override {
        ++starts;
        inner.start(std::move(callback));
    }
    void setOnStopped(std::function<void(bool)> handler) override { inner.setOnStopped(std::move(handler)); }
    void stop() override {
        ++stops;
        inner.stop();
    }
    void close() override {
        ++closes;
        if (closeLog != nullptr) {
            ++*closeLog;  // outlives the device, which the host may destroy
        }
        inner.close();
    }

    ManualAudioDevice inner;
    int refusals = 0;
    int opens = 0;
    int starts = 0;
    int stops = 0;
    int closes = 0;
    int* closeLog = nullptr;
};

// What the rig's host lists (engine.devices): the device it starts on, two more
// a client can select (one refuses its first open), and a default.
std::vector<protocol::DeviceDescription> rigDevices() {
    return {{"manual", "test", "manual", false, false},
            {"b", "test", "b", false, false},
            {"refusing", "test", "refusing", false, false},
            {"test/default", "test", "default", true, false}};
}

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
    // What the device factory made, in order (engine.select_device).
    std::vector<HeldDevice*> made;
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
        options.listDevices = rigDevices;
        options.deviceFactory = [this](const std::string& id) -> std::unique_ptr<host::AudioDevice> {
            auto one = std::make_unique<HeldDevice>(id == "refusing" ? 1 : 0);
            made.push_back(one.get());
            return one;
        };
        host = std::make_unique<EngineHost>(fixture.session, std::move(options));
    }

    // Pump the device the factory made last from here on.
    void useMade() {
        REQUIRE_FALSE(made.empty());
        held = made.back();
        device = &held->inner;
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

TEST_CASE("a session whose graph could not be built still merges and discards proposals through the port",
          "[engine][host]") {
    // Process model: a session whose media cannot be loaded is served the same
    // way, so proposal.merge and proposal.discard work while nothing is heard.
    Fixture fixture;
    std::filesystem::remove_all(fixture.bundle() / "media");
    EngineHost host(fixture.session, manualOptions(std::make_unique<ManualAudioDevice>()));
    REQUIRE(host.status().deviceError.has_value());
    REQUIRE(host.status().deviceError->code == "media_missing");
    protocol::AuditionPort* const port = host.auditionPort();
    REQUIRE(port != nullptr);

    session::Session& session = fixture.session;
    const command::BranchId kept = session.branch(session.history().head().envelope.id);
    session.commitOn(kept, {live_rig::cmd(live_rig::addTrack("trk_c"))}, "test", "t");
    const command::BranchId dropped = session.branch(session.history().head().envelope.id);
    session.commitOn(dropped, {live_rig::cmd(live_rig::addTrack("trk_d"))}, "test", "t");

    const command::Revision* merged = nullptr;
    REQUIRE_NOTHROW(merged = &port->merge(kept, "test", "t"));
    CHECK(merged->envelope.id == session.history().head().envelope.id);
    CHECK_FALSE(session.history().isOpen(kept));
    REQUIRE_NOTHROW(port->discard(dropped));
    CHECK_FALSE(session.history().isOpen(dropped));
    CHECK_FALSE(port->heard().has_value());

    CHECK_THROWS_AS(port->merge("no_such_branch", "test", "t"), command::CommandError);
    REQUIRE_NOTHROW(host.tick());  // retries at the new head; the media is still gone
    CHECK(host.status().deviceError->code == "media_missing");
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
        REQUIRE(host.auditionPort() != nullptr);  // one port for the host's life
        CHECK_FALSE(host.auditionPort()->heard().has_value());
        CHECK_THROWS_AS(host.auditionPort()->hearMain(), protocol::AuditionPortError);
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
            REQUIRE(host->auditionPort() != nullptr);
            CHECK_FALSE(host->auditionPort()->heard().has_value());
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
    // Each tick sends the meter frame, then the loudness frame (m5b-engine-load-loudness).
    const auto newestMeterFrame = [&] {
        const auto frames = harness.transport.binary(realtimeConnection);
        for (auto it = frames.rbegin(); it != frames.rend(); ++it) {
            if (auto decoded = protocol::decodeMeterFrame(*it)) {
                return decoded;
            }
        }
        return std::optional<protocol::MeterFrame>{};
    };
    auto frame = newestMeterFrame();
    REQUIRE(frame.has_value());
    CHECK_FALSE(frame->playing);
    CHECK(frame->playheadSamples == 0);

    rig.host->locate(4'800);
    rig.host->tick();
    frame = newestMeterFrame();
    REQUIRE(frame.has_value());
    CHECK(frame->playheadSamples == 4'800);

    // The command goes through the server; the host follows and tells clients.
    harness.commit(listener, json::Array{json::parse(live_rig::addTrack("trk_c"))});
    for (int i = 0; i < 100 && legends() < 2; ++i) {
        rig.pump(1);
    }
    CHECK(legends() == 2);
}

// ---- engine.devices and engine.select_device (Protocol v0 item 22) ----------------

TEST_CASE("devices lists what listDevices returns and marks the current one", "[engine][host][devices]") {
    SECTION("by the id the host runs") {
        Rig rig;
        const std::vector<protocol::DeviceDescription> listed = rig.host->devices();
        REQUIRE(listed.size() == 4);
        for (std::size_t i = 0; i < listed.size(); ++i) {
            INFO(listed[i].id);
            CHECK(listed[i].id == rigDevices()[i].id);
            CHECK(listed[i].type == rigDevices()[i].type);
            CHECK(listed[i].name == rigDevices()[i].name);
            CHECK(listed[i].isDefault == rigDevices()[i].isDefault);
            CHECK(listed[i].current == (listed[i].id == "manual"));
        }
    }
    SECTION("the default one when the host was given no id") {
        Fixture fixture;
        EngineHostOptions options = manualOptions(std::make_unique<ManualAudioDevice>());
        options.deviceId.clear();
        options.listDevices = rigDevices;
        EngineHost host(fixture.session, std::move(options));
        for (const protocol::DeviceDescription& one : host.devices()) {
            INFO(one.id);
            CHECK(one.current == (one.id == "test/default"));
        }
    }
}

TEST_CASE("selecting an unknown device is not_found and the device plays on", "[engine][host][devices]") {
    Rig rig;
    rig.host->play();
    rig.settle();
    rig.pump(4);
    const int stops = rig.held->stops;
    const int closes = rig.held->closes;
    CHECK(codeOf([&] { rig.host->selectDevice("nope"); }) == "not_found");
    CHECK(rig.made.empty());  // the factory never ran
    CHECK(rig.held->stops == stops);
    CHECK(rig.held->closes == closes);
    REQUIRE(rig.host->status().device.has_value());
    CHECK(rig.host->status().device->id == "manual");
    CHECK(rig.host->status().playing);
    const std::int64_t before = rig.position();
    rig.pump(3);
    CHECK(rig.position() == before + 3 * kBlock);
}

TEST_CASE("selecting a device closes the old one and opens the new one stopped at the playhead",
          "[engine][host][devices]") {
    const std::uint64_t violations = rt::allocationViolations();
    playback::PlaybackOptions options = live_rig::testOptions();
    options.callbackClock = &host::fakeCallbackClock;
    host::setFakeCallbackNanos(20'000'000);
    Rig rig(options);
    rig.host->play();
    rig.settle();
    rig.pump(4);
    REQUIRE(rig.host->status().xruns > 0);
    int oldCloses = 0;
    rig.held->closeLog = &oldCloses;
    const std::int64_t frozen = rig.position();
    CHECK(frozen > 0);

    const protocol::DeviceInfo selected = rig.host->selectDevice("b");
    CHECK(selected.id == "b");
    CHECK(selected.sampleRate == 48'000);
    CHECK(selected.bufferFrames == kBlock);
    CHECK(oldCloses >= 1);
    REQUIRE(rig.made.size() == 1);
    rig.useMade();
    CHECK(rig.held->opens == 1);
    CHECK(rig.held->starts == 1);

    const protocol::EngineStatus status = rig.host->status();
    REQUIRE(status.device.has_value());
    CHECK(status.device->id == "b");
    CHECK_FALSE(status.deviceError.has_value());
    CHECK_FALSE(status.playing);
    CHECK(status.xruns == 0);  // counted from this device's start
    CHECK(rig.position() == frozen);
    for (const protocol::DeviceDescription& one : rig.host->devices()) {
        CHECK(one.current == (one.id == "b"));
    }

    rig.host->play();
    rig.settle();
    rig.pump(3);
    CHECK(rig.position() == frozen + 3 * kBlock);
    CHECK(rt::allocationViolations() == violations);
}

TEST_CASE("a selected device that fails to open is device_open_failed and is retried under the backoff",
          "[engine][host][devices][backoff]") {
    Rig rig(1);
    rig.advance(100ms);  // the first device opens at its second try
    REQUIRE(rig.host->status().device.has_value());
    int oldCloses = 0;
    rig.held->closeLog = &oldCloses;

    CHECK(codeOf([&] { rig.host->selectDevice("refusing"); }) == "device_open_failed");
    CHECK(oldCloses >= 1);
    REQUIRE(rig.made.size() == 1);
    rig.useMade();
    CHECK(rig.held->opens == 1);
    const protocol::EngineStatus status = rig.host->status();
    CHECK_FALSE(status.device.has_value());
    REQUIRE(status.deviceError.has_value());
    CHECK(status.deviceError->code == "device_open_failed");
    checkNoTransport(*rig.host);
    for (const protocol::DeviceDescription& one : rig.host->devices()) {
        CHECK(one.current == (one.id == "refusing"));
    }

    // The count starts over at a selection: the first retry waits `initial`.
    rig.advance(99ms);
    CHECK(rig.held->opens == 1);
    rig.advance(1ms);
    CHECK(rig.held->opens == 2);
    REQUIRE(rig.host->status().device.has_value());
    CHECK(rig.host->status().device->id == "refusing");
}

TEST_CASE("a selection while the session did not load is kept and answers its deviceError",
          "[engine][host][devices]") {
    Fixture fixture;
    fs::remove_all(fixture.bundle() / "media");
    std::vector<HeldDevice*> made;
    EngineHostOptions options = manualOptions(std::make_unique<HeldDevice>());
    options.listDevices = rigDevices;
    options.deviceFactory = [&made](const std::string&) -> std::unique_ptr<host::AudioDevice> {
        auto one = std::make_unique<HeldDevice>();
        made.push_back(one.get());
        return one;
    };
    EngineHost host(fixture.session, std::move(options));
    REQUIRE(host.status().deviceError.has_value());
    CHECK(codeOf([&] { host.selectDevice("b"); }) == "media_missing");
    REQUIRE(made.size() == 1);
    CHECK(made[0]->opens == 0);
    REQUIRE(host.status().deviceError.has_value());
    CHECK(host.status().deviceError->code == "media_missing");
    for (const protocol::DeviceDescription& one : host.devices()) {
        CHECK(one.current == (one.id == "b"));
    }
    CHECK(codeOf([&] { host.selectDevice("nope"); }) == "not_found");
}

// ---- session.open's rebind and the media retry (Protocol v0 item 22) -----------------

namespace {

// The media file a clip's media names in the bundle.
fs::path mediaFileOf(const Fixture& fixture, const std::string& mediaId) {
    const model::Media* media = fixture.doc().media(mediaId);
    REQUIRE(media != nullptr);
    return session::mediaPath(fixture.bundle(), media->contentHash, media->format);
}

int legendsOn(protocol::testing::Harness& harness, protocol::ConnectionId listener, const std::string& entity) {
    harness.server.pump();
    int count = 0;
    for (const json::Value& event : harness.events(listener)) {
        if (event.find("type")->asString() == "meters.legend" &&
            jcs::canonicalize(event).find(entity) != std::string::npos) {
            ++count;
        }
    }
    return count;
}

}  // namespace

TEST_CASE("rebind plays the new session on the same device object", "[engine][host][rebind]") {
    const std::uint64_t violations = rt::allocationViolations();
    Rig rig;
    protocol::ServerOptions serverOptions = protocol::testing::manualOptions();
    serverOptions.transportPort = rig.host.get();
    serverOptions.auditionPort = rig.host->auditionPort();
    protocol::testing::Harness harness(rig.fixture.session, serverOptions);
    const protocol::ConnectionId listener = harness.authed(true);
    rig.host->attachPublisher(harness.server.realtime(), harness.server.events());
    protocol::AuditionPort* const port = rig.host->auditionPort();
    rig.host->play();
    rig.settle();
    rig.pump(4);
    const int opens = rig.held->opens;

    // Bundle B: the fixture's two tracks and a third, trk_c, only it has.
    Fixture other;
    other.exec(live_rig::addTrack("trk_c"));
    other.exec(live_rig::place("clp_c", "trk_c", "med_st", 0, 0, 40'000));
    CHECK(legendsOn(harness, listener, "track:trk_c") == 0);

    rig.host->rebind(other.session);
    CHECK(rig.made.empty());              // no new device
    CHECK(rig.held->opens == opens + 1);  // the new driver opened the same object again
    const protocol::EngineStatus status = rig.host->status();
    REQUIRE(status.device.has_value());
    CHECK(status.device->id == "manual");
    CHECK_FALSE(status.deviceError.has_value());
    CHECK_FALSE(status.playing);  // a new transport, stopped
    CHECK(rig.engine().streamFor("trk_c") != nullptr);
    CHECK(rig.host->auditionPort() == port);
    CHECK_FALSE(port->heard().has_value());

    rig.host->play();
    rig.settle();
    const std::int64_t start = rig.position();
    rig.pump(4);
    CHECK(rig.position() == start + 4 * kBlock);
    const auto meter = rig.engine().dispatcher().meter("track:trk_c");
    REQUIRE(meter.has_value());
    CHECK(meter->reading.peak[0] > 0.01f);
    CHECK(legendsOn(harness, listener, "track:trk_c") == 1);

    // B's commits reach the live graph through the same port.
    other.exec(live_rig::addTrack("trk_d"));
    port->mainCommitted();
    rig.pump(8);
    CHECK(rig.engine().streamFor("trk_d") != nullptr);
    CHECK(rt::allocationViolations() == violations);
}

TEST_CASE("rebind without a device keeps the device problem", "[engine][host][rebind]") {
    Fixture first;
    EngineHostOptions options;
    options.deviceError = protocol::DeviceProblem{"no_audio_backend", "built without an audio backend"};
    EngineHost host(first.session, std::move(options));
    Fixture other;
    other.exec(live_rig::addTrack("trk_c"));
    host.rebind(other.session);
    REQUIRE(host.status().deviceError.has_value());
    CHECK(host.status().deviceError->code == "no_audio_backend");
    CHECK(host.playback().streamFor("trk_c") != nullptr);  // B is what plays
    CHECK(host.playback().compileCount() == 1);
}

TEST_CASE("a session whose media file is gone plays once a commit no longer needs it", "[engine][host][retry]") {
    Fixture fixture;
    fs::remove(mediaFileOf(fixture, "med_mono"));  // clp_b's
    std::vector<std::string> diagnostics;
    auto device = std::make_unique<HeldDevice>();
    HeldDevice* held = device.get();
    EngineHostOptions options = manualOptions(std::move(device));
    options.diagnostic = [&diagnostics](const std::string& line) { diagnostics.push_back(line); };
    EngineHost host(fixture.session, std::move(options));
    REQUIRE(host.status().deviceError.has_value());
    CHECK(host.status().deviceError->code == "media_missing");
    CHECK_FALSE(host.status().device.has_value());
    CHECK(held->opens == 0);
    REQUIRE(diagnostics.size() == 1);

    // Ticks at the same head try nothing again.
    for (int i = 0; i < 5; ++i) {
        REQUIRE_NOTHROW(host.tick());
    }
    CHECK(diagnostics.size() == 1);

    // A commit that still needs the file: one line, the same error, no throw.
    fixture.exec(live_rig::addTrack("trk_c"));
    host.auditionPort()->mainCommitted();
    REQUIRE_NOTHROW(host.tick());
    REQUIRE_NOTHROW(host.tick());
    CHECK(diagnostics.size() == 2);
    REQUIRE(host.status().deviceError.has_value());
    CHECK(host.status().deviceError->code == "media_missing");
    CHECK(held->opens == 0);
    checkNoTransport(host);

    // Removing the clip that names it: the graph builds and the device opens.
    fixture.exec(R"({"op":"clip.remove","clipId":"clp_b"})");
    host.auditionPort()->mainCommitted();
    host.tick();
    const protocol::EngineStatus status = host.status();
    REQUIRE(status.device.has_value());
    CHECK_FALSE(status.deviceError.has_value());
    CHECK(held->opens == 1);
    CHECK_FALSE(host.auditionPort()->heard().has_value());
    CHECK(host.playback().streamFor("trk_a") != nullptr);

    host.play();
    for (int i = 0; i < 1'000 && host.playback().transport().pendingLocate(); ++i) {
        host.tick();
        host.playback().butler().runOnce();
        host.tick();
    }
    REQUIRE_FALSE(host.playback().transport().pendingLocate());
    for (int b = 0; b < 3; ++b) {
        held->inner.pump(1);
        host.tick();
        host.playback().butler().runOnce();
        host.tick();
    }
    CHECK(host.transportState().position == 3 * kBlock);
}

TEST_CASE("a loaded session without a device is never built again", "[engine][host][retry]") {
    Fixture fixture;
    EngineHostOptions options;
    options.deviceError = protocol::DeviceProblem{"no_device", "no output device"};
    EngineHost host(fixture.session, std::move(options));
    CHECK(host.playback().compileCount() == 1);
    for (int i = 0; i < 5; ++i) {
        host.tick();
    }
    CHECK(host.playback().compileCount() == 1);
    fixture.exec(live_rig::addTrack("trk_c"));
    host.auditionPort()->mainCommitted();
    host.tick();
    CHECK(host.playback().compileCount() == 2);  // the same engine compiled, not a new one
}

// ---- cycle and click through the host (Protocol v0 item 26) -------------------------
//
// What transport.set_cycle and transport.set_click do on the device, not only what
// they report: the host passes both to the playback engine, keeps them across
// selectDevice, gives the engine bind() builds the opened session's cycle flag, and
// keeps the click across a rebind.

namespace {

// Neither locator on a block boundary; the fixture's audio runs on past both.
constexpr std::int64_t kLeft = 10'003;
constexpr std::int64_t kRight = 30'007;

std::string setLocators(std::int64_t left, std::int64_t right) {
    return R"({"op":"session.set_locators","left":")" + std::to_string(left) + R"(","right":")" +
           std::to_string(right) + R"("})";
}

// Locators committed on main and heard by the live graph.
void commitLocators(Rig& rig) {
    rig.fixture.exec(setLocators(kLeft, kRight));
    rig.host->auditionPort()->mainCommitted();
    rig.pump(2);
}

// Plays from `from` for `blocks` blocks; returns channel 0 of what the device put out.
std::vector<float> playFrom(Rig& rig, std::int64_t from, int blocks) {
    rig.host->stop();
    rig.pump(1);
    rig.host->locate(from);
    rig.host->play();
    rig.settle();
    std::vector<float> out;
    for (int b = 0; b < blocks; ++b) {
        rig.device->pump(1, &out);
        rig.service();
    }
    return out;
}

// From L, 200 blocks (51,200 frames) is more than two passes of the 20,004-frame
// range: with cycle on the playhead is back inside it, with cycle off long past R.
bool wraps(Rig& rig) {
    playFrom(rig, kLeft, 200);
    const std::int64_t at = rig.position();
    return at >= kLeft && at < kRight;
}

// At 120 BPM a beat falls on 96,000; the fixture's audio ends at 50,000, so from
// 90,000 the device is silent unless the click sounds.
float clickPeak(Rig& rig) {
    const std::vector<float> out = playFrom(rig, 90'000, 40);
    float peak = 0.0f;
    for (const float sample : out) {
        peak = std::max(peak, std::abs(sample));
    }
    return peak;
}

}  // namespace

TEST_CASE("setCycle on the host makes playback wrap on the device", "[engine][host][cycle]") {
    const std::uint64_t violations = rt::allocationViolations();
    Rig rig;
    commitLocators(rig);
    CHECK_FALSE(wraps(rig));

    CHECK(rig.host->setCycle(true).cycle);
    CHECK(rig.engine().cycle());
    CHECK(wraps(rig));

    CHECK_FALSE(rig.host->setCycle(false).cycle);
    CHECK_FALSE(wraps(rig));
    CHECK(rt::allocationViolations() == violations);
}

TEST_CASE("setClick on the host adds the click to the device output", "[engine][host][click]") {
    const std::uint64_t violations = rt::allocationViolations();
    Rig rig;
    CHECK(clickPeak(rig) == 0.0f);

    CHECK(rig.host->setClick(true, 0).click.enabled);
    const float loud = clickPeak(rig);
    CHECK(loud > 0.1f);

    // The gain reaches the engine too: -20 dB is a tenth of the level.
    rig.host->setClick(true, -20'000);
    const float quiet = clickPeak(rig);
    CHECK(quiet > 0.0f);
    CHECK(std::abs(quiet - loud / 10.0f) < loud / 100.0f);

    rig.host->setClick(false, std::nullopt);
    CHECK(clickPeak(rig) == 0.0f);
    CHECK(rt::allocationViolations() == violations);
}

TEST_CASE("cycle and click keep sounding on a device selectDevice opens", "[engine][host][cycle][click][devices]") {
    Rig rig;
    commitLocators(rig);
    rig.host->setCycle(true);
    rig.host->setClick(true, 0);

    rig.host->selectDevice("b");
    rig.useMade();
    CHECK(wraps(rig));
    CHECK(clickPeak(rig) > 0.1f);
}

TEST_CASE("rebind gives the new engine the opened session's cycle flag and keeps the click",
          "[engine][host][cycle][click][rebind]") {
    Rig rig;
    rig.host->setClick(true, 0);
    CHECK_FALSE(rig.host->setCycle(false).cycle);

    Fixture other;
    other.exec(setLocators(kLeft, kRight));
    other.session.setCycle(true);
    rig.host->rebind(other.session);
    CHECK(rig.host->status().cycle);
    CHECK(rig.engine().cycle());
    CHECK(wraps(rig));
    CHECK(clickPeak(rig) > 0.1f);

    // And a session saved with cycle off opens with it off.
    Fixture plain;
    plain.exec(setLocators(kLeft, kRight));
    rig.host->setCycle(true);
    rig.host->rebind(plain.session);
    CHECK_FALSE(rig.engine().cycle());
    CHECK_FALSE(wraps(rig));
}

// m5b-engine-punch-count-in (Protocol v0 item 34): the punch flags are the served
// session's, so session.open (rebind) hands the opened bundle's to the host; the
// pre-roll and count-in states are the host's own, kept across selectDevice and
// rebind like the click.
TEST_CASE("session.open hands the opened session's punch flags to the host; pre-roll and count-in are kept",
          "[engine][host][punch][rebind]") {
    Rig rig;
    const protocol::TransportState set = rig.host->setPunch(true, false);
    CHECK(set.punch == protocol::PunchState{true, false});
    CHECK(rig.fixture.session.punch() == session::PunchFlags{true, false});  // written with the next checkpoint
    CHECK(rig.host->setPreroll(true, 3).preroll == protocol::BarsState{true, 3});
    CHECK(rig.host->setCountIn(true, std::nullopt).countIn == protocol::BarsState{true, 2});
    CHECK(rig.host->setCountIn(true, 4).countIn == protocol::BarsState{true, 4});
    CHECK(rig.host->setPreroll(false, std::nullopt).preroll == protocol::BarsState{false, 3});
    const protocol::EngineStatus status = rig.host->status();
    CHECK(status.punch == protocol::PunchState{true, false});
    CHECK(status.preroll == protocol::BarsState{false, 3});
    CHECK(status.countIn == protocol::BarsState{true, 4});

    rig.host->selectDevice("b");
    rig.useMade();
    CHECK(rig.host->transportState().punch == protocol::PunchState{true, false});
    CHECK(rig.host->transportState().preroll == protocol::BarsState{false, 3});
    CHECK(rig.host->transportState().countIn == protocol::BarsState{true, 4});

    Fixture other;
    other.session.setPunch(session::PunchFlags{false, true});
    rig.host->rebind(other.session);
    CHECK(rig.host->status().punch == protocol::PunchState{false, true});
    CHECK(rig.host->status().countIn == protocol::BarsState{true, 4});
    CHECK(rig.host->status().preroll == protocol::BarsState{false, 3});

    // Without a device the setters answer no_device, as set_cycle does.
    Rig none(1);  // the device refuses to open: no running device
    for (const auto& call : std::vector<std::function<void()>>{
             [&] { none.host->setPunch(true, true); }, [&] { none.host->setPreroll(true, 1); },
             [&] { none.host->setCountIn(true, 1); }}) {
        try {
            call();
            FAIL("no error");
        } catch (const protocol::TransportPortError& error) {
            CHECK(error.code() == "no_device");
        }
    }
}

#if defined(_WIN32) && !defined(_DLL)
namespace {
// _set_abort_behavior of the shared Universal CRT (ucrtbase.dll), whose flags a
// plugin linked against the shared CRT reads; with a statically linked CRT (the
// desktop-release preset) the engine's own _set_abort_behavior never reaches them.
unsigned int sharedCrtAbortBehavior(unsigned int flags, unsigned int mask) {
    HMODULE crt = LoadLibraryExW(L"ucrtbase.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    REQUIRE(crt != nullptr);
    using SetAbortBehavior = unsigned int(__cdecl*)(unsigned int, unsigned int);
    const auto set = reinterpret_cast<SetAbortBehavior>(GetProcAddress(crt, "_set_abort_behavior"));
    REQUIRE(set != nullptr);
    const unsigned int previous = set(flags, mask);
    FreeLibrary(crt);
    return previous;
}
}  // namespace
#endif

// m4-crash-recovery (spec, "Process model", Crash): a plugin crash raises no WER or
// CRT dialog, so the process ends at once and the shell restarts it.
TEST_CASE("disableCrashDialogs turns off the crash dialogs and keeps the other error-mode flags",
          "[engine][crash]") {
#if defined(_WIN32)
    const UINT savedMode = GetErrorMode();
    const unsigned int savedAbort = _set_abort_behavior(0, 0);
    SetErrorMode(SEM_NOOPENFILEERRORBOX);  // what JUCE's VST3 host sets
    _set_abort_behavior(_WRITE_ABORT_MSG | _CALL_REPORTFAULT, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
#if !defined(_DLL)
    const unsigned int savedShared =
        sharedCrtAbortBehavior(_WRITE_ABORT_MSG | _CALL_REPORTFAULT, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
#endif
    engine_app::disableCrashDialogs();
    const UINT mode = GetErrorMode();
    CHECK((mode & SEM_FAILCRITICALERRORS) != 0);
    CHECK((mode & SEM_NOGPFAULTERRORBOX) != 0);
    CHECK((mode & SEM_NOOPENFILEERRORBOX) != 0);
    const unsigned int abortFlags = _set_abort_behavior(0, 0);  // a read
    CHECK((abortFlags & (_WRITE_ABORT_MSG | _CALL_REPORTFAULT)) == 0);
#if !defined(_DLL)
    // A statically linked CRT: the shared one, which a /MD plugin aborts through, too.
    const unsigned int sharedFlags = sharedCrtAbortBehavior(0, 0);  // a read
    CHECK((sharedFlags & (_WRITE_ABORT_MSG | _CALL_REPORTFAULT)) == 0);
    sharedCrtAbortBehavior(savedShared, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
#endif
    SetErrorMode(savedMode);
    _set_abort_behavior(savedAbort, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
#else
    engine_app::disableCrashDialogs();  // nothing to turn off
    SUCCEED();
#endif
}

// m5b-engine-master: the master gain target through the host's GesturePort, on the
// live graph: the start value from the heard side, the sound through the
// parameter channel, cancel back to the document's value, end one master.set_gain.
TEST_CASE("a master gesture through the port starts from the heard side and cancel returns the sound",
          "[engine][host][gesture][master]") {
    Rig rig;
    session::Session& session = rig.fixture.session;
    // trk_b muted: the master sum is trk_a alone, so master / trk_a is the master gain.
    rig.fixture.exec(R"({"op":"track.set_mute","trackId":"trk_b","mute":true})");
    rig.host->auditionPort()->mainCommitted();
    rig.host->play();
    rig.settle();
    rig.pump(8);
    protocol::GesturePort& port = *rig.host;
    const protocol::GestureTarget target = protocol::GestureTarget::masterGain();
    CHECK(target.ref() == "master:master");
    // The master meter's peak over trk_a's, both of the newest block.
    const auto masterRatio = [&]() {
        const auto master = rig.engine().dispatcher().meter(playback::masterMeterKey());
        const auto track = rig.engine().dispatcher().meter("track:trk_a");
        REQUIRE(master.has_value());
        REQUIRE(track.has_value());
        REQUIRE(master->blockStart == track->blockStart);
        REQUIRE(track->reading.peak[0] > 0.01f);
        return master->reading.peak[0] / track->reading.peak[0];
    };
    const auto atGain = [](float ratio, std::int32_t milliDb) {
        return std::abs(ratio - graph::gainFromMilliDb(milliDb)) < 1e-5f;
    };
    CHECK(atGain(masterRatio(), 0));

    // No master entity: the start value is 0, never not_found.
    CHECK(port.begin(target) == 0.0);
    port.update(target, -20'000.0);
    rig.pump(8);
    CHECK(atGain(masterRatio(), -20'000));
    port.cancel(target);
    rig.pump(8);
    CHECK(atGain(masterRatio(), 0));

    // A main revision sets -6 dB; a heard proposal holds -12 dB.
    rig.fixture.exec(R"({"op":"master.set_gain","gainMilliDb":-6000})");
    rig.host->auditionPort()->mainCommitted();
    rig.pump(8);
    CHECK(atGain(masterRatio(), -6'000));
    CHECK(port.begin(target) == -6'000.0);
    port.cancel(target);

    const command::BranchId branch = session.branch(session.history().head().envelope.id);
    session.commitOn(branch, {live_rig::cmd(R"({"op":"master.set_gain","gainMilliDb":-12000})")}, "test", "t");
    rig.host->auditionPort()->audition(branch);
    rig.pump(8);
    CHECK(atGain(masterRatio(), -12'000));
    CHECK(port.begin(target) == -12'000.0);
    port.update(target, -20'000.0);
    rig.pump(8);
    CHECK(atGain(masterRatio(), -20'000));
    port.cancel(target);
    rig.pump(8);
    CHECK(atGain(masterRatio(), -12'000));

    // Back on main, an end commits one master.set_gain on main, heard without a compile.
    rig.host->auditionPort()->hearMain();
    rig.pump(8);
    const std::size_t revisions = session.history().revisions().size();
    const std::size_t compiles = rig.engine().compileCount();
    CHECK(port.begin(target) == -6'000.0);
    port.update(target, -3'000.0);
    rig.pump(4);
    const protocol::GestureEnd end = port.end(target, "user", "t");
    REQUIRE(end.revision != nullptr);
    CHECK(end.startValue == -6'000.0);
    CHECK(end.value == -3'000.0);
    CHECK(session.history().revisions().size() == revisions + 1);
    REQUIRE(end.revision->commands.size() == 1);
    CHECK(end.revision->commands[0].op() == "master.set_gain");
    CHECK(session.history().head().document.master()->gain.milliDb == -3'000);
    rig.host->auditionPort()->mainCommitted();
    rig.pump(8);
    CHECK(rig.engine().compileCount() == compiles);
    CHECK(atGain(masterRatio(), -3'000));

    // A gesture that never moved ends with no revision.
    CHECK(port.begin(target) == -3'000.0);
    const protocol::GestureEnd still = port.end(target, "user", "t");
    CHECK(still.revision == nullptr);
    CHECK(still.value == -3'000.0);
}

// m5b-engine-buses-sends: bus gain and send level targets through the host's
// GesturePort on the live graph: not_found for an unknown id, the start value
// from the document, cancel back to it, end one bus.set_gain / send.set_level.
TEST_CASE("bus and send gestures through the port", "[engine][host][gesture][buses]") {
    Rig rig;
    session::Session& session = rig.fixture.session;
    rig.fixture.exec(R"({"op":"bus.add","busId":"b1","name":"Bus"})");
    rig.fixture.exec(R"({"op":"track.set_output","trackId":"trk_a","output":{"busId":"b1"}})");
    rig.fixture.exec(R"({"op":"send.add","sendId":"s1","trackId":"trk_b","busId":"b1","levelMilliDb":-6000})");
    rig.host->auditionPort()->mainCommitted();
    rig.host->play();
    rig.settle();
    rig.pump(8);
    protocol::GesturePort& port = *rig.host;
    const protocol::GestureTarget bus = protocol::GestureTarget::busGain("b1");
    const protocol::GestureTarget send = protocol::GestureTarget::sendLevel("s1");
    CHECK(bus.ref() == "bus:b1");
    CHECK(send.ref() == "send:s1");
    CHECK(send.param == "level");
    // The bus meter peak over the trk_a meter peak, both of the newest block: trk_a
    // and trk_b's send sum on b1, so mute trk_b's send to read the bus gain alone.
    try {
        (void)port.begin(protocol::GestureTarget::busGain("b9"));
        FAIL("expected not_found");
    } catch (const protocol::GesturePortError& error) {
        CHECK(error.code() == "not_found");
    }
    try {
        (void)port.begin(protocol::GestureTarget::sendLevel("s9"));
        FAIL("expected not_found");
    } catch (const protocol::GesturePortError& error) {
        CHECK(error.code() == "not_found");
    }

    CHECK(port.begin(bus) == 0.0);
    port.update(bus, -20'000.0);
    rig.pump(8);
    port.cancel(bus);
    rig.pump(8);
    CHECK(port.begin(send) == -6'000.0);
    port.cancel(send);

    const std::size_t revisions = session.history().revisions().size();
    const std::size_t compiles = rig.engine().compileCount();
    CHECK(port.begin(bus) == 0.0);
    port.update(bus, -3'000.0);
    rig.pump(4);
    const protocol::GestureEnd ended = port.end(bus, "user", "t");
    REQUIRE(ended.revision != nullptr);
    CHECK(ended.value == -3'000.0);
    REQUIRE(ended.revision->commands.size() == 1);
    CHECK(ended.revision->commands[0].op() == "bus.set_gain");
    CHECK(session.history().head().document.bus("b1")->gain.milliDb == -3'000);

    CHECK(port.begin(send) == -6'000.0);
    port.update(send, -12'000.0);
    rig.pump(4);
    const protocol::GestureEnd sent = port.end(send, "user", "t");
    REQUIRE(sent.revision != nullptr);
    CHECK(sent.startValue == -6'000.0);
    CHECK(sent.value == -12'000.0);
    CHECK(sent.revision->commands[0].op() == "send.set_level");
    CHECK(session.history().head().document.send("s1")->level.milliDb == -12'000);
    CHECK(session.history().revisions().size() == revisions + 2);
    rig.host->auditionPort()->mainCommitted();
    rig.pump(8);
    CHECK(rig.engine().compileCount() == compiles);
    const auto meter = rig.engine().dispatcher().meter("bus:b1");
    REQUIRE(meter.has_value());
    CHECK(meter->reading.peak[0] > 0.0f);
}

// ---- DSP load and loudness (m5b-engine-load-loudness, Protocol v0 item 31) ---------

namespace {

bool minusInfinity(float value) {
    return std::isinf(value) && value < 0.0f;
}

// Replaces the rig's two clips with `seconds` of a 1 kHz stereo sine at `dbfs`
// peak per channel on trk_a (EBU Tech 3341's test signal), from position 0.
void placeTone(Rig& rig, double dbfs, double seconds) {
    const auto frames = static_cast<std::int64_t>(seconds * 48'000.0);
    media::AudioBuffer tone;
    tone.info = media::AudioInfo{2, 48'000, frames};
    tone.samples.reserve(static_cast<std::size_t>(frames) * 2);
    const double amplitude = std::pow(10.0, dbfs / 20.0);
    for (std::int64_t i = 0; i < frames; ++i) {
        const auto v = static_cast<float>(amplitude * std::sin(2.0 * 3.14159265358979323846 * 1'000.0 *
                                                                static_cast<double>(i) / 48'000.0));
        tone.samples.push_back(v);
        tone.samples.push_back(v);
    }
    const fs::path file = rig.fixture.dir.path() / "tone.wav";
    io::writeFileAtomic(file, media::encodeWavFloat32(tone));
    session::importMedia(rig.fixture.session, file, "med_tone", "test", "t");
    rig.fixture.exec(R"({"op":"clip.remove","clipId":"clp_a"})");
    rig.fixture.exec(R"({"op":"clip.remove","clipId":"clp_b"})");
    rig.fixture.exec(live_rig::place("clp_tone", "trk_a", "med_tone", 0, 0, frames));
    rig.host->auditionPort()->mainCommitted();
    rig.service();
}

int blocksOf(double seconds) {
    return static_cast<int>(seconds * 48'000.0 / kBlock);
}

}  // namespace

TEST_CASE("a -23 dBFS 1 kHz tone through the engine reads -23 LUFS, and -6 dB of master gain 6 LU less",
          "[engine][host][loudness]") {
    const std::uint64_t violations = rt::allocationViolations();
    Rig rig;
    placeTone(rig, -23.0, 8.0);
    rig.host->play();
    rig.settle();
    rig.pump(blocksOf(5.0));
    const realtime::LoudnessReading reading = rig.engine().driver().loudness();
    CHECK(std::abs(reading.momentary - -23.0f) <= 0.1f);
    CHECK(std::abs(reading.shortTerm - -23.0f) <= 0.1f);
    CHECK(std::abs(reading.integrated - -23.0f) <= 0.1f);

    // The master gain is applied before the meter.
    rig.fixture.exec(R"({"op":"master.set_gain","gainMilliDb":-6000})");
    rig.host->auditionPort()->mainCommitted();
    rig.pump(blocksOf(1.0));
    CHECK(std::abs((reading.momentary - rig.engine().driver().loudness().momentary) - 6.0f) <= 0.05f);
    CHECK(rt::allocationViolations() == violations);
}

TEST_CASE("a realtime client receives loudness frames while the session plays", "[engine][host][loudness]") {
    Rig rig;
    placeTone(rig, -23.0, 4.0);
    protocol::ServerOptions serverOptions = protocol::testing::manualOptions();
    serverOptions.transportPort = rig.host.get();
    serverOptions.auditionPort = rig.host->auditionPort();
    protocol::testing::Harness harness(rig.fixture.session, serverOptions);
    const protocol::ConnectionId realtimeConnection = harness.realtimeAuthed();
    rig.host->attachPublisher(harness.server.realtime(), harness.server.events());

    rig.host->play();
    rig.settle();
    rig.pump(blocksOf(1.0));
    rig.host->tick();
    const auto frames = harness.transport.binary(realtimeConnection);
    REQUIRE(frames.size() >= 2);
    // Every tick: the meter frame, then the loudness frame.
    CHECK(protocol::decodeMeterFrame(frames[frames.size() - 2]).has_value());
    const auto loudness = protocol::decodeLoudnessFrame(frames.back());
    REQUIRE(loudness.has_value());
    CHECK(std::abs(loudness->momentary - -23.0f) <= 0.1f);
    CHECK(loudness->integrated == rig.engine().driver().loudness().integrated);
    CHECK(protocol::decodeMeterFrame(frames.back()) == std::nullopt);  // an SMTR-only client ignores it
}

TEST_CASE("engine.select_device keeps the integrated value; meter.reset_loudness returns it to -inf",
          "[engine][host][loudness][devices]") {
    Rig rig;
    placeTone(rig, -23.0, 8.0);
    rig.host->play();
    rig.settle();
    rig.pump(blocksOf(3.0));
    const float integrated = rig.engine().driver().loudness().integrated;
    REQUIRE(std::abs(integrated - -23.0f) <= 0.1f);

    rig.host->selectDevice("b");
    rig.useMade();
    CHECK(rig.engine().driver().loudness().integrated == integrated);
    // Stopped on the new device: silence. The gating blocks that overlap the
    // stop still count, then the absolute gate leaves the silence out.
    rig.pump(blocksOf(0.5));
    const float held = rig.engine().driver().loudness().integrated;
    CHECK(held > -24.0f);  // three partial blocks against about 27 at -23, not a restart
    rig.pump(blocksOf(1.0));
    CHECK(rig.engine().driver().loudness().integrated == held);

    rig.host->resetLoudness();
    rig.pump(1);
    CHECK(minusInfinity(rig.engine().driver().loudness().integrated));
    rig.host->play();
    rig.settle();
    rig.pump(blocksOf(2.0));
    CHECK(std::abs(rig.engine().driver().loudness().integrated - -23.0f) <= 0.1f);

    // Without a device it is no error: the meter is the engine's.
    rig.device->reportLost();
    rig.host->tick();
    REQUIRE_FALSE(rig.host->status().device.has_value());
    REQUIRE_NOTHROW(rig.host->resetLoudness());
    CHECK(minusInfinity(rig.engine().driver().loudness().integrated));
}

TEST_CASE("engine.status load is the driver's and 0 once the device is gone", "[engine][host][load]") {
    playback::PlaybackOptions options = live_rig::testOptions();
    options.callbackClock = &host::fakeCallbackClock;
    host::setFakeCallbackNanos(1'000'000);  // 1 ms of a 5.33 ms period
    Rig rig(options);
    CHECK(rig.host->status().load.average == 0.0);
    rig.pump(187);  // 47,872 frames: not a full second yet
    CHECK(rig.host->status().load.average == 0.0);
    rig.pump(1);
    const protocol::EngineStatus status = rig.host->status();
    const double expected = 1'000'000.0 * 48'000.0 / (kBlock * 1e9);
    CHECK(std::abs(status.load.average - expected) <= 1e-9);
    CHECK(std::abs(status.load.peak - expected) <= 1e-9);

    rig.device->reportLost();
    rig.host->tick();
    REQUIRE_FALSE(rig.host->status().device.has_value());
    CHECK(rig.host->status().load.average == 0.0);
    CHECK(rig.host->status().load.peak == 0.0);
}
