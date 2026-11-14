// Recording through the engine host (m5b-engine-record; spec, "Recording",
// Protocol v0 items 22 and 27): device inputs, the armed set, transport.record
// committing one revision per recording, early ends and the loopback placement.
// A ManualAudioDevice with loopback and reported latencies runs every block on
// this thread; the recorders' writer is drained by the host's tick
// (writerThread false), so nothing here waits on a clock. The binary links
// siann_rt_alloc_guard: the capture path is checked for allocations.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <optional>
#include <random>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include "siann/command/command.hpp"
#include "siann/engine_app/engine_host.hpp"
#include "siann/hash/json.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/media/wav_stream_writer.hpp"
#include "siann/protocol/plugin_port.hpp"
#include "siann/protocol/record_port.hpp"
#include "siann/protocol/transport_port.hpp"
#include "siann/realtime/recorder.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/session.hpp"
#include "siann/session/takes.hpp"

using namespace siann;
using engine_app::EngineHost;
using engine_app::EngineHostOptions;
using host::ManualAudioDevice;
using protocol::TransportPortError;

namespace {

namespace fs = std::filesystem;

constexpr int kBlock = 256;
constexpr std::int64_t kImpulseAt = 10'000;
// Loopback needs at least one buffer of round trip (as FakeAudioDevice).
constexpr int kInputLatency = 128;
constexpr int kOutputLatency = 256;

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-rec-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

command::Command cmd(const std::string& json) {
    return command::Command::fromJson(json::parse(json));
}

std::string addTrack(const std::string& id, int channels) {
    return R"({"op":"track.add","trackId":")" + id + R"(","name":")" + id + R"(","channels":)" +
           std::to_string(channels) + "}";
}

std::string setInput(const std::string& id, int port, int channels) {
    return R"({"op":"track.set_input","trackId":")" + id + R"(","input":{"port":)" + std::to_string(port) +
           R"(,"channels":)" + std::to_string(channels) + "}}";
}

// A source track playing a one-sample impulse at kImpulseAt, a mono and a stereo
// track to record on, and one track with no input.
struct RecordFixture {
    TempDir dir;
    session::Session session;

    RecordFixture()
        : session(session::Session::create(dir.path() / "Rec.siann", model::Document::create("Rec", 48'000), "test",
                                           "t0")) {
        media::AudioBuffer impulse;
        impulse.info = media::AudioInfo{1, 48'000, 100};
        impulse.samples.assign(100, 0.0f);
        impulse.samples[0] = 1.0f;
        const fs::path file = dir.path() / "impulse.wav";
        io::writeFileAtomic(file, media::encodeWavFloat32(impulse));
        session::importMedia(session, file, "med_imp", "test", "t");
        exec(addTrack("trk_src", 1));
        exec(R"({"op":"clip.place","clipId":"clp_imp","trackId":"trk_src","mediaId":"med_imp","position":{"domain":"audio","value":")" +
             std::to_string(kImpulseAt) + R"("},"sourceStart":"0","length":"100"})");
        exec(addTrack("trk_mono", 1));
        exec(setInput("trk_mono", 0, 1));
        exec(addTrack("trk_st", 2));
        exec(setInput("trk_st", 0, 2));
        exec(addTrack("trk_dry", 1));
    }

    void exec(const std::string& json) { session.commit({cmd(json)}, "test", "t"); }
    const model::Document& doc() const { return session.history().head().document; }
};

ManualAudioDevice::Options loopback(std::int64_t fixedRate = 0) {
    ManualAudioDevice::Options options;
    options.loopback = true;
    options.inputLatencyFrames = kInputLatency;
    options.outputLatencyFrames = kOutputLatency;
    options.fixedSampleRate = fixedRate;
    return options;
}

std::vector<protocol::DeviceDescription> listed() {
    protocol::DeviceDescription manual{"manual", "test", "manual", false, false};
    manual.inputChannels = 2;
    manual.outputChannels = 2;
    protocol::DeviceDescription other{"other", "test", "other", false, false};
    other.inputChannels = 2;
    other.outputChannels = 2;
    protocol::DeviceDescription mic{"mic", "test", "mic", false, false};
    mic.inputChannels = 1;
    mic.outputChannels = 0;
    protocol::DeviceDescription foreign{"elsewhere/in", "elsewhere", "in", false, false};
    foreign.inputChannels = 2;
    foreign.outputChannels = 0;
    return {manual, other, mic, foreign};
}

struct RecordRig {
    RecordFixture fixture;
    ManualAudioDevice* device = nullptr;
    std::vector<ManualAudioDevice*> made;
    std::unique_ptr<EngineHost> host;
    std::int64_t fixedRate = 0;
    int maxInputs = -1;  // the input channels the devices it makes open at most

    explicit RecordRig(const std::function<void(EngineHostOptions&)>& adjust = {}, std::int64_t rate = 0)
        : fixedRate(rate) {
        auto first = std::make_unique<ManualAudioDevice>(loopback(fixedRate));
        device = first.get();
        EngineHostOptions options;
        options.device = std::move(first);
        options.deviceId = "manual";
        options.bufferFrames = kBlock;
        options.playback.maxBlockFrames = kBlock;
        options.playback.fadeFrames = kBlock;
        options.playback.ringFrames = 8'192;
        options.playback.butler = realtime::Butler::Options{2'048, 512, std::chrono::microseconds(200)};
        options.playback.butlerThread = false;
        options.playback.capture.recorder.writerThread = false;  // the host's tick drains
        options.playback.capture.recorder.checkpointInterval = std::chrono::milliseconds(0);
        options.listDevices = listed;
        options.deviceFactory = [this](const std::string&) -> std::unique_ptr<host::AudioDevice> {
            ManualAudioDevice::Options deviceOptions = loopback(fixedRate);
            deviceOptions.maxInputChannels = maxInputs;
            auto one = std::make_unique<ManualAudioDevice>(deviceOptions);
            made.push_back(one.get());
            return one;
        };
        options.timestamp = [] { return std::string("2026-11-14T00:00:00Z"); };
        if (adjust) {
            adjust(options);
        }
        host = std::make_unique<EngineHost>(fixture.session, std::move(options));
    }

    // Selects the manual device with its own input and pumps that one from now on.
    void openInput() {
        host->selectDeviceWithInput("manual", std::string("manual"));
        device = made.back();
    }

    playback::PlaybackEngine& engine() { return host->playback(); }

    void service() {
        host->tick();
        engine().butler().runOnce();
        host->tick();
    }

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

    void pumpUntil(std::int64_t position, int limit = 10'000) {
        for (int i = 0; i < limit && host->transportState().position < position; ++i) {
            pump(1);
        }
        REQUIRE(host->transportState().position >= position);
    }

    // A commit made on the session directly, heard as the server's would be.
    void exec(const std::string& json) {
        fixture.exec(json);
        host->auditionPort()->mainCommitted();
        service();
    }

    std::size_t revisions() const { return fixture.session.history().revisions().size(); }
};

std::string codeOf(const std::function<void()>& call) {
    try {
        call();
    } catch (const TransportPortError& error) {
        return error.code();
    } catch (const session::SessionError& error) {
        return error.code();
    }
    return "none";
}

media::AudioBuffer readMedia(const RecordRig& rig, const model::Media& media) {
    std::ifstream in(session::mediaPath(rig.fixture.session.bundlePath(), media.contentHash), std::ios::binary);
    return media::decodeWav(std::string(std::istreambuf_iterator<char>(in), {}));
}

// Where the loudest sample of channel `channel` of a committed take lands on the
// timeline: the clip's position plus the sample's index in its media.
std::int64_t impulsePlacement(const RecordRig& rig, const std::string& takeId, int channel = 0) {
    const model::Document& doc = rig.fixture.doc();
    const model::Clip* clip = doc.clip("clp_" + takeId);
    REQUIRE(clip != nullptr);
    const model::Media* media = doc.media(clip->mediaId);
    REQUIRE(media != nullptr);
    const media::AudioBuffer audio = readMedia(rig, *media);
    std::int64_t best = -1;
    float peak = 0.0f;
    for (std::int64_t i = 0; i < audio.info.frames; ++i) {
        const float v = std::abs(audio.samples[static_cast<std::size_t>(i * audio.info.channels + channel)]);
        if (v > peak) {
            peak = v;
            best = i;
        }
    }
    REQUIRE(best >= 0);
    REQUIRE(peak > 0.1f);
    return clip->position.value + best;
}

std::vector<std::string> opsOf(const command::Revision& revision) {
    std::vector<std::string> ops;
    for (const command::Command& c : revision.commands) {
        ops.emplace_back(c.op());
    }
    std::sort(ops.begin(), ops.end());
    return ops;
}

}  // namespace

TEST_CASE("engine.devices carries channel counts and select_device opens an input", "[engine][record][input]") {
    RecordRig rig;
    const std::vector<protocol::DeviceDescription> devices = rig.host->devices();
    REQUIRE(devices.size() == 4);
    CHECK(devices[0].current);
    CHECK(devices[0].inputChannels == std::optional<int>(2));
    CHECK(devices[0].outputChannels == std::optional<int>(2));
    CHECK(devices[2].outputChannels == std::optional<int>(0));

    // Launched without an input: no input, and recording answers no_input.
    REQUIRE(rig.host->status().device.has_value());
    CHECK_FALSE(rig.host->status().device->input.has_value());
    CHECK(codeOf([&] { rig.host->arm("trk_mono", true); }) == "no_input");
    CHECK(codeOf([&] { rig.host->record(true); }) == "no_input");
    // Playback is unaffected.
    CHECK(rig.host->play().playing);
    rig.settle();
    rig.pump(4);
    CHECK(rig.host->transportState().position == 4 * kBlock);
    CHECK_FALSE(rig.host->locate(48'000).recording);
    rig.host->stop();

    const protocol::DeviceInfo opened = rig.host->selectDeviceWithInput("manual", std::string("manual"));
    REQUIRE(opened.input.has_value());
    CHECK(opened.input->id == "manual");
    CHECK(opened.input->channels == 2);
    CHECK(opened.input->latencyFrames == kInputLatency);
    rig.device = rig.made.back();
    const protocol::EngineStatus status = rig.host->status();
    REQUIRE(status.device.has_value());
    REQUIRE(status.device->input.has_value());
    CHECK(status.device->input->channels == 2);
    CHECK_FALSE(status.recording);
    CHECK(status.armed.empty());

    CHECK(codeOf([&] { rig.host->selectDeviceWithInput("manual", std::string("nope")); }) == "not_found");
    CHECK(codeOf([&] { rig.host->selectDeviceWithInput("manual", std::string("elsewhere/in")); }) ==
          "invalid_params");
    CHECK(codeOf([&] { rig.host->selectDeviceWithInput("mic", std::nullopt); }) == "not_found");  // no outputs
    CHECK(rig.host->status().device->input.has_value());  // the refusals changed nothing

    // Without inputId the input closes.
    rig.host->selectDeviceWithInput("manual", std::nullopt);
    rig.device = rig.made.back();
    CHECK_FALSE(rig.host->status().device->input.has_value());
}

TEST_CASE("arming needs an input that covers the track's, and follows the document", "[engine][record][arm]") {
    RecordRig rig;
    rig.openInput();
    CHECK(codeOf([&] { rig.host->arm("trk_dry", true); }) == "no_input");  // no input on the track
    CHECK(codeOf([&] { rig.host->arm("trk_missing", true); }) == "not_found");
    rig.exec(setInput("trk_dry", 1, 2));  // channels 1 and 2 of a two-channel input
    CHECK(codeOf([&] { rig.host->arm("trk_dry", true); }) == "no_input");

    const protocol::RecordState armed = rig.host->arm("trk_mono", true);
    CHECK(armed.armed == std::vector<std::string>{"trk_mono"});
    CHECK_FALSE(armed.recording);
    CHECK(rig.host->status().armed == std::vector<std::string>{"trk_mono"});
    CHECK(rig.host->transportState().armed == std::vector<std::string>{"trk_mono"});
    CHECK(rig.host->arm("trk_mono", true).armed.size() == 1);  // idempotent
    rig.host->arm("trk_st", true);
    CHECK(rig.host->recordState().armed == std::vector<std::string>{"trk_mono", "trk_st"});

    // Kept across a selection whose input still covers the channels.
    rig.openInput();
    CHECK(rig.host->recordState().armed == std::vector<std::string>{"trk_mono", "trk_st"});
    // Cleared by a selection without an input.
    rig.host->selectDeviceWithInput("manual", std::nullopt);
    rig.device = rig.made.back();
    CHECK(rig.host->recordState().armed.empty());

    // Removing the track disarms it.
    rig.openInput();
    rig.host->arm("trk_mono", true);
    rig.host->arm("trk_st", true);
    rig.exec(R"({"op":"track.remove","trackId":"trk_st"})");
    CHECK(rig.host->recordState().armed == std::vector<std::string>{"trk_mono"});
    // An undo that takes the input away disarms too.
    rig.exec(addTrack("trk_new", 1));
    rig.exec(setInput("trk_new", 1, 1));
    rig.host->arm("trk_new", true);
    rig.fixture.session.undo("test", "t");
    rig.host->auditionPort()->mainCommitted();
    rig.service();
    CHECK(rig.host->recordState().armed == std::vector<std::string>{"trk_mono"});
    rig.host->arm("trk_mono", false);
    CHECK(rig.host->recordState().armed.empty());
    CHECK(rig.host->arm("trk_mono", false).armed.empty());  // disarming twice is a no-op
}

TEST_CASE("transport.record needs an armed track, starts at the playhead and stop commits one revision",
          "[engine][record]") {
    const std::uint64_t violations = rt::allocationViolations();
    RecordRig rig;
    rig.openInput();
    CHECK(codeOf([&] { rig.host->record(true); }) == "nothing_armed");
    rig.host->arm("trk_mono", true);
    rig.host->locate(48'000);
    rig.settle();

    const std::size_t before = rig.revisions();
    const protocol::TransportState started = rig.host->record(true);
    CHECK(started.recording);
    CHECK(started.playing);
    CHECK(rig.host->record(true).recording);  // a no-op while recording
    CHECK(codeOf([&] { rig.host->arm("trk_st", true); }) == "invalid_state");
    rig.settle();
    rig.pump(10);
    const protocol::RecordState during = rig.host->recordState();
    CHECK(during.recording);
    REQUIRE(during.takes.size() == 1);
    CHECK(during.takes[0].trackId == "trk_mono");
    CHECK(during.takes[0].startFrame == std::optional<std::int64_t>(48'000 - (kInputLatency + kOutputLatency)));
    CHECK(during.takes[0].durableFrames > 0);
    CHECK_FALSE(during.takes[0].endedBy.has_value());
    CHECK(rig.revisions() == before);  // nothing committed while recording

    const protocol::TransportState ended = rig.host->record(false);
    CHECK_FALSE(ended.recording);
    CHECK(ended.playing);  // playback continues
    CHECK(rig.revisions() == before + 1);
    const command::Revision& revision = rig.fixture.session.history().head();
    CHECK(opsOf(revision) == std::vector<std::string>{"clip.place", "media.add"});
    const std::string takeId = during.takes[0].takeId;
    const model::Clip* clip = rig.fixture.doc().clip("clp_" + takeId);
    REQUIRE(clip != nullptr);
    CHECK(clip->trackId == "trk_mono");
    CHECK(clip->position.value == 48'000 - (kInputLatency + kOutputLatency));
    CHECK(rig.host->recordState().takes[0].endedBy == std::optional<std::string>("stop"));
    CHECK(session::pendingTakes(rig.fixture.session.bundlePath()).empty());
    CHECK(rig.host->record(false).playing);  // nothing recording: a no-op
    CHECK(rig.revisions() == before + 1);

    // A second recording, ended by transport.stop: one more revision, and stopped.
    rig.host->record(true);
    rig.settle();
    rig.pump(6);
    const protocol::TransportState stopped = rig.host->stop();
    CHECK_FALSE(stopped.playing);
    CHECK_FALSE(stopped.recording);
    CHECK(rig.revisions() == before + 2);
    CHECK(opsOf(rig.fixture.session.history().head()) == std::vector<std::string>{"clip.place", "media.add"});
    CHECK(rt::allocationViolations() == violations);

    // Undo removes the clip and the media reference and deletes no file.
    const model::Media* media = rig.fixture.doc().media(rig.fixture.doc().clip("clp_" + rig.host->recordState().takes[0].takeId)->mediaId);
    REQUIRE(media != nullptr);
    const fs::path file = session::mediaPath(rig.fixture.session.bundlePath(), media->contentHash);
    rig.fixture.session.undo("test", "t");
    CHECK(fs::exists(file));
}

TEST_CASE("a recorded impulse lands within one sample of where it was played", "[engine][record][latency]") {
    SECTION("mono") {
        RecordRig rig;
        rig.openInput();
        rig.host->arm("trk_mono", true);
        rig.host->record(true);
        rig.settle();
        rig.pumpUntil(kImpulseAt + 4'000);
        const std::string takeId = rig.host->recordState().takes[0].takeId;
        rig.host->record(false);
        CHECK(std::llabs(impulsePlacement(rig, takeId) - kImpulseAt) <= 1);
    }
    SECTION("stereo") {
        RecordRig rig;
        rig.openInput();
        rig.host->arm("trk_st", true);
        rig.host->record(true);
        rig.settle();
        rig.pumpUntil(kImpulseAt + 4'000);
        const std::string takeId = rig.host->recordState().takes[0].takeId;
        rig.host->stop();
        CHECK(std::llabs(impulsePlacement(rig, takeId, 0) - kImpulseAt) <= 1);
        CHECK(std::llabs(impulsePlacement(rig, takeId, 1) - kImpulseAt) <= 1);
    }
    SECTION("through device-side SRC") {
        RecordRig rig({}, 44'100);
        rig.openInput();
        CHECK(rig.engine().resampling().active);
        rig.host->arm("trk_mono", true);
        rig.host->record(true);
        rig.settle();
        rig.pumpUntil(kImpulseAt + 8'000);
        const std::string takeId = rig.host->recordState().takes[0].takeId;
        rig.host->record(false);
        CHECK(std::llabs(impulsePlacement(rig, takeId) - kImpulseAt) <= 1);
    }
}

TEST_CASE("two armed tracks commit one revision with a media.add and a clip.place each", "[engine][record]") {
    RecordRig rig;
    rig.openInput();
    rig.host->arm("trk_mono", true);
    rig.host->arm("trk_st", true);
    const std::size_t before = rig.revisions();
    rig.host->record(true);
    rig.settle();
    rig.pump(8);
    const protocol::RecordState during = rig.host->recordState();
    REQUIRE(during.takes.size() == 2);
    rig.host->record(false);
    CHECK(rig.revisions() == before + 1);
    CHECK(opsOf(rig.fixture.session.history().head()) ==
          std::vector<std::string>{"clip.place", "clip.place", "media.add", "media.add"});
    for (const protocol::RecordTakeState& take : during.takes) {
        const model::Clip* clip = rig.fixture.doc().clip("clp_" + take.takeId);
        REQUIRE(clip != nullptr);
        CHECK(clip->trackId == take.trackId);
        const model::Media* media = rig.fixture.doc().media(clip->mediaId);
        REQUIRE(media != nullptr);
        CHECK(media->channels == (take.trackId == "trk_st" ? 2 : 1));
    }
}

TEST_CASE("an early end is named and what was captured is still committed", "[engine][record][early]") {
    SECTION("overflow") {
        RecordRig rig([](EngineHostOptions& options) { options.playback.capture.recorder.ringFrames = kBlock; });
        rig.openInput();
        rig.host->arm("trk_mono", true);
        rig.host->record(true);
        rig.settle();
        const std::size_t before = rig.revisions();
        rig.device->pump(3);  // nothing drains between these: the second block does not fit
        rig.service();
        const protocol::RecordState ended = rig.host->recordState();
        CHECK_FALSE(ended.recording);
        REQUIRE(ended.takes.size() == 1);
        CHECK(ended.takes[0].endedBy == std::optional<std::string>("overflow"));
        CHECK(ended.takes[0].overflows > 0);
        CHECK(rig.revisions() == before + 1);
        const model::Clip* clip = rig.fixture.doc().clip("clp_" + ended.takes[0].takeId);
        REQUIRE(clip != nullptr);
        CHECK(clip->length == kBlock);
    }
    SECTION("device") {
        RecordRig rig;
        rig.openInput();
        rig.host->arm("trk_mono", true);
        rig.host->record(true);
        rig.settle();
        rig.pump(5);
        const std::size_t before = rig.revisions();
        rig.device->reportLost();
        rig.service();
        const protocol::RecordState ended = rig.host->recordState();
        CHECK_FALSE(ended.recording);
        CHECK(ended.takes[0].endedBy == std::optional<std::string>("device"));
        CHECK(rig.revisions() == before + 1);
        CHECK(rig.fixture.doc().clip("clp_" + ended.takes[0].takeId) != nullptr);
        CHECK_FALSE(rig.host->status().device.has_value());
    }
    SECTION("disk") {
        struct FullDisk final : realtime::TakeWriter {
            FullDisk(const fs::path& file, int channels, std::int64_t rate) : inner(file, channels, rate) {}
            void append(const host::AudioBufferView& source, int frames) override {
                if (inner.frames() + frames > 2 * kBlock) {
                    throw std::runtime_error("no space left on the device");
                }
                inner.append(source, frames);
            }
            void checkpoint() override { inner.checkpoint(); }
            void close() override { inner.close(); }
            std::int64_t frames() const noexcept override { return inner.frames(); }
            media::WavStreamWriter inner;
        };
        RecordRig rig([](EngineHostOptions& options) {
            options.playback.capture.recorder.writerFactory = [](const fs::path& file, int channels, std::int64_t rate) {
                return std::make_unique<FullDisk>(file, channels, rate);
            };
        });
        rig.openInput();
        rig.host->arm("trk_mono", true);
        rig.host->record(true);
        rig.settle();
        const std::size_t before = rig.revisions();
        rig.pump(6);
        const protocol::RecordState ended = rig.host->recordState();
        CHECK_FALSE(ended.recording);
        CHECK(ended.takes[0].endedBy == std::optional<std::string>("disk"));
        CHECK(rig.revisions() == before + 1);
        const model::Clip* clip = rig.fixture.doc().clip("clp_" + ended.takes[0].takeId);
        REQUIRE(clip != nullptr);
        CHECK(clip->length == 2 * kBlock);
    }
}

TEST_CASE("recording with cycle on runs straight through the right locator", "[engine][record][cycle]") {
    RecordRig rig;
    rig.openInput();
    rig.exec(R"({"op":"session.set_locators","left":"2000","right":"6000"})");
    rig.host->setCycle(true);
    rig.host->arm("trk_mono", true);
    rig.host->locate(1'000);
    rig.settle();
    rig.host->record(true);
    rig.settle();
    rig.pumpUntil(12'000);
    CHECK(rig.engine().driver().cycleWraps() == 0);
    const std::string takeId = rig.host->recordState().takes[0].takeId;
    rig.host->record(false);
    const model::Clip* clip = rig.fixture.doc().clip("clp_" + takeId);
    REQUIRE(clip != nullptr);
    CHECK(clip->length >= 12'000 - 1'000 - kBlock);
    CHECK_FALSE(rig.engine().driver().captureActive());
}

TEST_CASE("shutdown during a recording leaves its takes pending", "[engine][record][shutdown]") {
    RecordRig rig;
    rig.openInput();
    rig.host->arm("trk_mono", true);
    rig.host->record(true);
    rig.settle();
    rig.pump(4);
    const std::string takeId = rig.host->recordState().takes[0].takeId;
    const std::size_t before = rig.revisions();
    rig.host->shutdown();
    CHECK(rig.revisions() == before);
    const std::vector<session::TakeManifest> pending = session::pendingTakes(rig.fixture.session.bundlePath());
    REQUIRE(pending.size() == 1);
    CHECK(pending[0].takeId == takeId);
    CHECK(pending[0].startPosition.has_value());
}

TEST_CASE("record.recover_take commits or trashes a pending take, idempotently", "[engine][record][recover]") {
    RecordRig rig;
    // Two takes a crash left behind.
    for (const std::string id : {"take_keep", "take_drop"}) {
        session::TakeManifest m;
        m.takeId = id;
        m.trackId = "trk_mono";
        m.channels = 1;
        m.sampleRate = 48'000;
        m.recordOffset = 96;
        const fs::path audio = session::beginTake(rig.fixture.session, m);
        session::markTakeStart(rig.fixture.session.bundlePath(), id, 1'000);
        media::WavStreamWriter writer(audio, 1, 48'000);
        std::vector<float> data(500, 0.25f);
        float* p[1] = {data.data()};
        writer.append(host::AudioBufferView{p, 1, 500}, 500);
        writer.close();
    }
    CHECK(rig.host->pendingTakes().size() == 2);
    const std::size_t before = rig.revisions();
    const protocol::RecoverResult kept = rig.host->recoverTake("take_keep", true, "user", "t");
    REQUIRE(kept.revision != nullptr);
    CHECK(rig.revisions() == before + 1);
    CHECK(rig.fixture.doc().clip("clp_take_keep") != nullptr);
    const protocol::RecoverResult again = rig.host->recoverTake("take_keep", true, "user", "t");
    REQUIRE(again.revision != nullptr);
    CHECK(again.revision->envelope.id == kept.revision->envelope.id);
    CHECK(rig.revisions() == before + 1);

    const protocol::RecoverResult dropped = rig.host->recoverTake("take_drop", false, "user", "t");
    CHECK(dropped.trashed);
    CHECK(dropped.revision == nullptr);
    CHECK(rig.host->recoverTake("take_drop", false, "user", "t").trashed);
    CHECK(fs::exists(rig.fixture.session.bundlePath() / "trash" / "take_drop.wav"));
    CHECK(rig.host->pendingTakes().empty());
    CHECK(codeOf([&] { rig.host->recoverTake("take_none", true, "user", "t"); }) == "take_not_found");
}

TEST_CASE("an armed track's input meter is read while stopped", "[engine][record][meters]") {
    RecordRig rig;
    rig.openInput();
    rig.host->arm("trk_mono", true);
    CHECK_FALSE(rig.host->inputMeter("trk_st").has_value());  // not armed
    rig.device->setInputGenerator([](int, std::int64_t) { return 0.5f; });
    rig.pump(3);
    const std::optional<graph::MeterReading> reading = rig.host->inputMeter("trk_mono");
    REQUIRE(reading.has_value());
    REQUIRE(reading->channels == 1);
    CHECK(reading->peak[0] == 0.5f);
}

TEST_CASE("an input reports the channels the device opened, and none opened is no input",
          "[engine][record][input]") {
    // A listing that does not count inputs (as a JUCE build's): the host asks for
    // up to 32, and the device opens the ones it has.
    RecordRig rig([](EngineHostOptions& options) {
        options.listDevices = [] {
            std::vector<protocol::DeviceDescription> out = listed();
            protocol::DeviceDescription unsaid{"unsaid", "test", "unsaid", false, false};
            unsaid.outputChannels = 2;
            out.push_back(unsaid);
            return out;
        };
    });

    SECTION("an output-only device named as its own input opens no input") {
        rig.maxInputs = 0;
        const protocol::DeviceInfo opened = rig.host->selectDeviceWithInput("unsaid", std::string("unsaid"));
        rig.device = rig.made.back();
        CHECK_FALSE(opened.input.has_value());
        REQUIRE(rig.host->status().device.has_value());
        CHECK_FALSE(rig.host->status().device->input.has_value());
        CHECK(rig.host->devices().back().inputChannels == std::optional<int>(0));
        CHECK(codeOf([&] { rig.host->arm("trk_mono", true); }) == "no_input");
        CHECK(codeOf([&] { rig.host->record(true); }) == "no_input");
        CHECK(rig.host->recordState().armed.empty());
        // Playback is unaffected.
        CHECK(rig.host->play().playing);
        rig.settle();
        rig.pump(2);
        CHECK(rig.host->transportState().position == 2 * kBlock);
    }
    SECTION("a device with one input opens one, whatever was asked") {
        rig.maxInputs = 1;
        const protocol::DeviceInfo opened = rig.host->selectDeviceWithInput("unsaid", std::string("unsaid"));
        rig.device = rig.made.back();
        REQUIRE(opened.input.has_value());
        CHECK(opened.input->channels == 1);
        CHECK(rig.host->status().device->input->channels == 1);
        CHECK(rig.host->devices().back().inputChannels == std::optional<int>(1));
        CHECK(codeOf([&] { rig.host->arm("trk_st", true); }) == "no_input");  // needs two
        CHECK(rig.host->arm("trk_mono", true).armed == std::vector<std::string>{"trk_mono"});
    }
}

TEST_CASE("a take recorded through a latent insert on the monitored path lands where it was played",
          "[engine][record][latency][plugin]") {
    RecordRig rig([](EngineHostOptions& options) {
        options.pluginDirs = {fs::path(SIANN_TEST_PLUGIN_CLAP).parent_path().string()};
    });
    rig.openInput();
    // siann_test_plugin reports 64 frames of latency: the impulse's track, and so
    // the master the performer hears, plays 64 frames late.
    REQUIRE(rig.host->approve("clap", SIANN_TEST_PLUGIN_CLAP, true).approved);
    protocol::PluginInstantiateRequest request;
    request.slotId = "slt_1";
    request.trackId = "trk_src";
    request.index = 0;
    request.descriptor = protocol::PluginDescriptorInfo{"clap", "", "", SIANN_TEST_PLUGIN_CLAP};
    const protocol::PluginInstantiateResult loaded = rig.host->instantiate(request);
    REQUIRE(loaded.latencyFrames == 64);
    json::Object descriptor{{"format", json::Value(loaded.descriptor.format)},
                            {"uid", json::Value(loaded.descriptor.uid)},
                            {"name", json::Value(loaded.descriptor.name)},
                            {"path", json::Value(loaded.descriptor.path)}};
    const json::Value insert(json::Object{{"op", json::Value("plugin.insert")},
                                          {"trackId", json::Value("trk_src")},
                                          {"index", json::Value(0)},
                                          {"slotId", json::Value("slt_1")},
                                          {"descriptor", json::Value(std::move(descriptor))},
                                          {"stateBlob", json::Value(nullptr)}});
    rig.fixture.session.commit({command::Command::fromJson(insert)}, "test", "t");
    rig.host->settle(*rig.fixture.doc().pluginSlot("slt_1"), true);
    rig.host->auditionPort()->mainCommitted();
    for (int i = 0; i < 200; ++i) {
        rig.pump(1);
        const graph::PreparedGraph* live = rig.engine().driver().liveGraph();
        if (live != nullptr && live->totalLatency() == 64) {
            break;
        }
    }
    REQUIRE(rig.engine().driver().liveGraph() != nullptr);
    REQUIRE(rig.engine().driver().liveGraph()->totalLatency() == 64);

    rig.host->arm("trk_mono", true);
    rig.host->record(true);
    rig.settle();
    rig.pumpUntil(kImpulseAt + 4'000);
    const std::string takeId = rig.host->recordState().takes[0].takeId;
    rig.host->record(false);
    CHECK(std::llabs(impulsePlacement(rig, takeId) - kImpulseAt) <= 1);
    rig.host->shutdown();
}

TEST_CASE("transport.locate while recording ends the take and commits it first", "[engine][record][locate]") {
    RecordRig rig;
    rig.openInput();
    rig.host->arm("trk_mono", true);
    rig.host->record(true);
    rig.settle();
    rig.pumpUntil(kImpulseAt + 4'000);
    const std::string takeId = rig.host->recordState().takes[0].takeId;
    const std::size_t before = rig.revisions();

    const protocol::TransportState located = rig.host->locate(96'000);
    CHECK_FALSE(located.recording);
    CHECK(located.playing);  // playback goes on, from the new position
    CHECK(rig.revisions() == before + 1);
    const protocol::RecordState ended = rig.host->recordState();
    REQUIRE(ended.takes.size() == 1);
    CHECK(ended.takes[0].endedBy == std::optional<std::string>("stop"));
    const model::Clip* clip = rig.fixture.doc().clip("clp_" + takeId);
    REQUIRE(clip != nullptr);
    const std::int64_t length = clip->length;
    CHECK(std::llabs(impulsePlacement(rig, takeId) - kImpulseAt) <= 1);

    // Nothing after the jump reaches the committed take.
    rig.settle();
    rig.pump(8);
    CHECK(rig.fixture.doc().clip("clp_" + takeId)->length == length);
    CHECK(rig.host->transportState().position >= 96'000);
    CHECK(rig.revisions() == before + 1);
    CHECK_FALSE(rig.engine().driver().captureActive());
}

TEST_CASE("the armed set follows a new head with no tick in between", "[engine][record][arm]") {
    // As the protocol server runs the requests of one pump: a commit on main, then
    // transport.record, with no host tick between them.
    SECTION("a removed track is no longer armed") {
        RecordRig rig;
        rig.openInput();
        rig.host->arm("trk_mono", true);
        rig.fixture.exec(R"({"op":"track.remove","trackId":"trk_mono"})");
        CHECK(rig.host->transportState().armed.empty());
        CHECK(rig.host->status().armed.empty());
        CHECK(rig.host->recordState().armed.empty());
        CHECK(codeOf([&] { rig.host->record(true); }) == "nothing_armed");
        CHECK_FALSE(rig.host->transportState().recording);
    }
    SECTION("a cleared input is no longer armed") {
        RecordRig rig;
        rig.openInput();
        rig.host->arm("trk_mono", true);
        rig.host->arm("trk_st", true);
        rig.fixture.exec(R"({"op":"track.set_input","trackId":"trk_mono","input":null})");
        CHECK(rig.host->transportState().armed == std::vector<std::string>{"trk_st"});
        const protocol::TransportState started = rig.host->record(true);
        CHECK(started.recording);
        CHECK(started.armed == std::vector<std::string>{"trk_st"});
        const protocol::RecordState during = rig.host->recordState();
        REQUIRE(during.takes.size() == 1);
        CHECK(during.takes[0].trackId == "trk_st");
        rig.host->stop();
    }
    SECTION("an input changed from mono to stereo records two channels") {
        RecordRig rig;
        rig.openInput();
        rig.host->arm("trk_mono", true);
        rig.fixture.exec(setInput("trk_mono", 0, 2));
        rig.device->setInputGenerator([](int channel, std::int64_t) { return channel == 0 ? 0.25f : 0.5f; });
        rig.host->record(true);
        rig.settle();
        rig.pump(6);
        const std::string takeId = rig.host->recordState().takes[0].takeId;
        rig.host->record(false);
        const model::Clip* clip = rig.fixture.doc().clip("clp_" + takeId);
        REQUIRE(clip != nullptr);
        const model::Media* media = rig.fixture.doc().media(clip->mediaId);
        REQUIRE(media != nullptr);
        CHECK(media->channels == 2);
        const media::AudioBuffer audio = readMedia(rig, *media);
        REQUIRE(audio.info.channels == 2);
        REQUIRE(audio.info.frames > 0);
        const std::size_t last = static_cast<std::size_t>(audio.info.frames - 1) * 2;
        CHECK(audio.samples[last] == 0.25f);
        CHECK(audio.samples[last + 1] == 0.5f);
    }
}

TEST_CASE("a device that opens fewer inputs than asked records and meters through device-side SRC",
          "[engine][record][input][src]") {
    // A listing that counts no inputs (as a JUCE build's): up to 32 are asked, the
    // device opens one, and it runs at 44.1 kHz under a 48 kHz session.
    RecordRig rig(
        [](EngineHostOptions& options) {
            options.listDevices = [] {
                std::vector<protocol::DeviceDescription> out = listed();
                protocol::DeviceDescription unsaid{"unsaid", "test", "unsaid", false, false};
                unsaid.outputChannels = 2;
                out.push_back(unsaid);
                return out;
            };
        },
        44'100);
    rig.maxInputs = 1;
    const protocol::DeviceInfo opened = rig.host->selectDeviceWithInput("unsaid", std::string("unsaid"));
    rig.device = rig.made.back();
    REQUIRE(opened.input.has_value());
    CHECK(opened.input->channels == 1);
    CHECK(rig.engine().resampling().active);
    rig.host->arm("trk_mono", true);

    rig.pump(4);  // stopped: the armed input is metered
    CHECK(rig.host->inputMeter("trk_mono").has_value());

    rig.host->record(true);
    rig.settle();
    rig.pumpUntil(kImpulseAt + 8'000);
    const std::string takeId = rig.host->recordState().takes[0].takeId;
    CHECK(rig.host->recordState().takes[0].durableFrames > 0);
    rig.host->record(false);
    CHECK(std::llabs(impulsePlacement(rig, takeId) - kImpulseAt) <= 1);
}
