#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <climits>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <random>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "siann/command/command.hpp"
#include "siann/engine/offline.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/hash/json.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/playback/playback_engine.hpp"
#include "siann/realtime/stream_resampler.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/session.hpp"
#include "support/flac_test_encoder.hpp"

namespace fs = std::filesystem;
using namespace siann;
using command::Command;
using graph::TrackFaderNode;
using model::Document;
using playback::PlaybackEngine;
using playback::PlaybackOptions;
using session::Session;

namespace {

constexpr int kBlock = 256;
constexpr std::uint32_t kGain = TrackFaderNode::kGainMilliDb;

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-playback-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

// Every sample distinct, so any misalignment shows.
media::AudioBuffer distinct(int channels, std::int64_t frames) {
    media::AudioBuffer b;
    b.info = media::AudioInfo{channels, 48'000, frames};
    for (std::int64_t i = 0; i < frames; ++i) {
        if (channels == 1) {
            b.samples.push_back(static_cast<float>(i % 6'007) / 7'000.0f + 0.0001f);
        } else {
            b.samples.push_back(static_cast<float>(i % 9'973) / 10'000.0f);
            b.samples.push_back(-static_cast<float>(i % 7'919) / 10'000.0f);
        }
    }
    return b;
}

Command cmd(const std::string& json) {
    return Command::fromJson(json::parse(json));
}

std::string place(const std::string& clipId, const std::string& trackId, const std::string& mediaId,
                  std::int64_t at, std::int64_t from, std::int64_t length) {
    return R"({"op":"clip.place","clipId":")" + clipId + R"(","trackId":")" + trackId + R"(","mediaId":")" +
           mediaId + R"(","position":{"domain":"audio","value":")" + std::to_string(at) +
           R"("},"sourceStart":")" + std::to_string(from) + R"(","length":")" + std::to_string(length) + R"("})";
}

std::string addTrack(const std::string& trackId, int channels = 2) {
    return R"({"op":"track.add","trackId":")" + trackId + R"(","name":")" + trackId + R"(","channels":)" +
           std::to_string(channels) + "}";
}

std::string setGain(const std::string& trackId, std::int32_t milliDb) {
    return R"({"op":"track.set_gain","trackId":")" + trackId + R"(","gainMilliDb":)" + std::to_string(milliDb) +
           "}";
}

struct Fixture {
    TempDir dir;
    Session session;

    Fixture() : session(Session::create(dir.path() / "Song.siann", Document::create("Song", 48'000), "test", "t0")) {}

    void exec(const std::string& json) { session.commit({cmd(json)}, "test", "t"); }
    const Document& doc() const { return session.history().head().document; }
    fs::path bundle() const { return session.bundlePath(); }

    void importWav(const std::string& mediaId, int channels, std::int64_t frames) {
        const fs::path file = dir.path() / (mediaId + ".wav");
        io::writeFileAtomic(file, media::encodeWavFloat32(distinct(channels, frames)));
        session::importMedia(session, file, mediaId, "test", "t");
    }
};

PlaybackOptions testOptions() {
    PlaybackOptions o;
    o.maxBlockFrames = kBlock;
    o.fadeFrames = kBlock;  // the initial fade-in is exactly block 0
    o.ringFrames = 8'192;
    o.butler = realtime::Butler::Options{2'048, 512, std::chrono::microseconds(200)};
    o.butlerThread = false;  // the test drives the butler
    return o;
}

host::AudioDeviceConfig deviceConfig() {
    host::AudioDeviceConfig c;
    c.sampleRate = 48'000;
    c.bufferFrames = kBlock;
    c.outputChannels = 2;
    return c;
}

// A loaded engine playing on a manual device. The device outlives the engine.
struct Player {
    host::ManualAudioDevice device;
    PlaybackEngine engine;
    std::vector<std::vector<float>> out{2};

    explicit Player(Session& session, PlaybackOptions options = testOptions()) : engine(session, std::move(options)) {
        engine.load();
        engine.start(device, deviceConfig());
    }
    ~Player() { engine.stop(); }

    void pump(int blocks) {
        for (int b = 0; b < blocks; ++b) {
            device.pumpAll(1, out);
            engine.butler().runOnce();
            engine.tick();
        }
    }
};

// Planar channels of the offline render from timeline 0.
std::vector<std::vector<float>> offline(const Document& document, const fs::path& bundle, std::int64_t frames) {
    const media::AudioBuffer rendered =
        engine::renderOffline(document, engine::loadMedia(document, bundle), engine::RenderOptions{0, frames, kBlock});
    std::vector<std::vector<float>> planar(2);
    for (std::int64_t i = 0; i < frames; ++i) {
        planar[0].push_back(rendered.samples[static_cast<std::size_t>(i * 2)]);
        planar[1].push_back(rendered.samples[static_cast<std::size_t>(i * 2 + 1)]);
    }
    return planar;
}

std::vector<float> blocks(const std::vector<float>& v, int fromBlock, int toBlock) {
    return std::vector<float>(v.begin() + static_cast<std::ptrdiff_t>(fromBlock) * kBlock,
                              v.begin() + static_cast<std::ptrdiff_t>(toBlock) * kBlock);
}

Document withCommand(const Document& document, const std::string& json) {
    return command::prepare(document, cmd(json)).result;
}

int blocksFor(std::int64_t frames) {
    return static_cast<int>((frames + kBlock - 1) / kBlock) + 2;
}

bool silent(const std::vector<float>& v) {
    for (const float s : v) {
        if (s != 0.0f) {
            return false;
        }
    }
    return true;
}

}  // namespace

TEST_CASE("compileForPlayback builds one streaming player and fader per track plus the master, and a slot per track",
          "[playback]") {
    Fixture f;
    f.importWav("med_st", 2, 20'000);
    f.importWav("med_mono", 1, 20'000);
    f.exec(addTrack("trk_a"));
    f.exec(addTrack("trk_b"));
    f.exec(place("clp_a", "trk_a", "med_st", 0, 0, 20'000));
    f.exec(place("clp_b", "trk_b", "med_mono", 0, 0, 20'000));

    const auto compiled = playback::compileForPlayback(f.doc(), f.bundle(), testOptions());
    REQUIRE(compiled.graph);
    CHECK(compiled.graph->nodeCount() == 8);  // per track player, fader, meter; master bus and meter
    REQUIRE(compiled.meterSlots.size() == 3);
    CHECK(compiled.meterSlots.count("track:trk_a") == 1);
    CHECK(compiled.meterSlots.count("track:trk_b") == 1);
    CHECK(compiled.meterSlots.count("master") == 1);
    const auto metered = compiled.graph->meteredNodes();
    CHECK(metered.size() == 3);
    CHECK(metered.back() == compiled.meterSlots.at("master"));  // the master meter runs last
    CHECK(compiled.streams.size() == 2);
    REQUIRE(compiled.slots.size() == 2);
    CHECK(compiled.slots.count("track:trk_a") == 1);
    CHECK(compiled.slots.count("track:trk_b") == 1);
    CHECK(compiled.slots.at("track:trk_a") != compiled.slots.at("track:trk_b"));

    // The slots address the faders: a gain change on each silences that track.
    Player p(f.session);
    CHECK(p.engine.slots() == compiled.slots);
    CHECK(p.engine.streamCount() == 2);
    p.pump(3);
    const auto reference = offline(f.doc(), f.bundle(), 20 * kBlock);
    CHECK(blocks(p.out[0], 1, 3) == blocks(reference[0], 1, 3));

    const std::uint64_t epoch = p.engine.driver().liveEpoch();
    REQUIRE(p.engine.driver().pushParam(
        realtime::ParamChange{epoch, p.engine.slots().at("track:trk_a"), kGain, static_cast<double>(INT32_MIN), 0}));
    p.pump(2);
    const auto onlyB = offline(withCommand(f.doc(), setGain("trk_a", INT32_MIN)), f.bundle(), 20 * kBlock);
    CHECK(blocks(p.out[0], 3, 5) == blocks(onlyB[0], 3, 5));
    CHECK(blocks(p.out[1], 3, 5) == blocks(onlyB[1], 3, 5));
    CHECK_FALSE(silent(blocks(p.out[0], 3, 5)));

    REQUIRE(p.engine.driver().pushParam(
        realtime::ParamChange{epoch, p.engine.slots().at("track:trk_b"), kGain, static_cast<double>(INT32_MIN), 0}));
    p.pump(2);
    CHECK(silent(blocks(p.out[0], 5, 7)));
    CHECK(silent(blocks(p.out[1], 5, 7)));
    CHECK(p.engine.underruns() == 0);
    // A latency recompile above the compensation limit would be flagged here.
    CHECK(p.engine.latencyRecompileFailures() == 0);
    CHECK_FALSE(p.engine.latencyFault().has_value());
}

TEST_CASE("A FLAC clip plays through the in-memory reader", "[playback][flac]") {
    Fixture f;
    constexpr int kFrames = 4'000;
    std::vector<std::int16_t> samples;
    for (int i = 0; i < kFrames; ++i) {
        samples.push_back(static_cast<std::int16_t>((i * 7) % 32'000 - 16'000));
        samples.push_back(static_cast<std::int16_t>(15'000 - (i * 13) % 30'000));
    }
    const fs::path source = f.dir.path() / "hit.flac";
    io::writeFileAtomic(source, siann::test::encodeFlac16(2, 48'000, samples, 256));
    session::importMedia(f.session, source, "med_flac", "test", "t");
    REQUIRE(f.doc().media("med_flac")->format == model::MediaFormat::flac);
    f.exec(addTrack("trk_a"));
    f.exec(addTrack("trk_m", 1));
    f.exec(place("clp_1", "trk_a", "med_flac", 300, 10, 3'900));
    f.exec(place("clp_2", "trk_a", "med_flac", 2'000, 0, 4'000));  // overlaps, shares the reader
    f.exec(place("clp_3", "trk_m", "med_flac", 700, 100, 3'000));   // stereo media into a mono track

    const std::int64_t end = engine::documentEnd(f.doc());
    const int n = blocksFor(end);
    Player p(f.session);
    p.pump(n);
    const auto reference = offline(f.doc(), f.bundle(), static_cast<std::int64_t>(n) * kBlock);
    CHECK(blocks(p.out[0], 1, n) == blocks(reference[0], 1, n));
    CHECK(blocks(p.out[1], 1, n) == blocks(reference[1], 1, n));
    CHECK_FALSE(silent(blocks(p.out[0], 1, n)));
    CHECK(p.engine.underruns() == 0);
}

TEST_CASE("Playing a session on the manual device is sample-identical to renderOffline after the fade-in",
          "[playback]") {
    Fixture f;
    f.importWav("med_st", 2, 50'000);
    f.importWav("med_mono", 1, 20'000);
    f.exec(addTrack("trk_a"));
    f.exec(addTrack("trk_b"));
    // Overlapping, trimmed and gained clips.
    f.exec(place("clp_a1", "trk_a", "med_st", 1'000, 0, 20'000));
    f.exec(place("clp_a2", "trk_a", "med_st", 15'000, 5'000, 30'000));
    f.exec(R"({"op":"clip.set_gain","clipId":"clp_a2","gainMilliDb":-6000})");
    // A mono clip on a stereo track, and a quiet stereo clip.
    f.exec(place("clp_b1", "trk_b", "med_mono", 3'000, 100, 19'000));
    f.exec(place("clp_b2", "trk_b", "med_st", 40'000, 100, 10'000));
    f.exec(R"({"op":"clip.set_gain","clipId":"clp_b2","gainMilliDb":-12000})");
    f.exec(setGain("trk_b", -6'000));
    f.exec(R"({"op":"track.set_pan","trackId":"trk_b","pan":5000})");

    const std::int64_t end = engine::documentEnd(f.doc());
    CHECK(end == 50'000);
    const int n = blocksFor(end);
    Player p(f.session);
    p.pump(n);
    REQUIRE(p.out[0].size() == static_cast<std::size_t>(n) * kBlock);
    const auto reference = offline(f.doc(), f.bundle(), static_cast<std::int64_t>(n) * kBlock);
    CHECK(blocks(p.out[0], 1, n) == blocks(reference[0], 1, n));
    CHECK(blocks(p.out[1], 1, n) == blocks(reference[1], 1, n));
    CHECK_FALSE(silent(blocks(p.out[0], 1, n)));
    CHECK(p.engine.underruns() == 0);
}

TEST_CASE("Play from stop through the transport is sample-identical to renderOffline after the fade-in",
          "[playback][transport]") {
    Fixture f;
    f.importWav("med_st", 2, 30'000);
    f.importWav("med_mono", 1, 20'000);
    f.exec(addTrack("trk_a"));
    f.exec(addTrack("trk_b"));
    f.exec(place("clp_a", "trk_a", "med_st", 0, 0, 30'000));
    f.exec(place("clp_b", "trk_b", "med_mono", 3'000, 100, 19'000));
    f.exec(setGain("trk_b", -6'000));

    PlaybackOptions options = testOptions();
    options.playOnStart = false;
    Player p(f.session, std::move(options));
    p.pump(4);
    CHECK(silent(p.out[0]));
    CHECK(p.engine.driver().playhead() == 0);
    CHECK_FALSE(p.engine.transport().playing());

    p.engine.transport().play();  // a locate to the current position carrying the start
    CHECK(p.engine.transport().playing());
    p.engine.butler().runOnce();
    p.engine.tick();
    CHECK_FALSE(p.engine.transport().pendingLocate());
    p.out.assign(2, {});
    const std::int64_t end = engine::documentEnd(f.doc());
    const int n = blocksFor(end);
    p.pump(n);
    const auto reference = offline(f.doc(), f.bundle(), static_cast<std::int64_t>(n) * kBlock);
    // Block 0 fades in from silence; from block 1 on the output is exact.
    CHECK(blocks(p.out[0], 0, 1) != blocks(reference[0], 0, 1));
    CHECK(blocks(p.out[0], 1, n) == blocks(reference[0], 1, n));
    CHECK(blocks(p.out[1], 1, n) == blocks(reference[1], 1, n));
    CHECK_FALSE(silent(blocks(p.out[0], 1, n)));
    CHECK(p.engine.transport().lateLocates() == 0);
    CHECK(p.engine.underruns() == 0);
}

TEST_CASE("A fader gesture moves the sound through the parameter channel and ending it commits exactly one "
          "revision that replays on reopen",
          "[playback][gesture]") {
    Fixture f;
    f.importWav("med_st", 2, 40'000);
    f.exec(addTrack("trk_a"));
    f.exec(place("clp_a", "trk_a", "med_st", 0, 0, 40'000));
    const fs::path bundle = f.bundle();
    const auto frames = static_cast<std::int64_t>(40) * kBlock;
    const auto at6 = offline(withCommand(f.doc(), setGain("trk_a", -6'000)), bundle, frames);
    const auto at3 = offline(withCommand(f.doc(), setGain("trk_a", -3'000)), bundle, frames);
    const std::size_t before = f.session.history().revisions().size();

    {
        Player p(f.session);
        p.pump(2);

        SECTION("a gesture that never moved commits nothing") {
            p.engine.beginGesture("trk_a", kGain);
            CHECK(p.engine.endGesture("trk_a", kGain, "user", "t9") == nullptr);
            CHECK(f.session.history().revisions().size() == before);
        }

        SECTION("an invalid final value commits nothing and the sound returns to the document") {
            p.engine.beginGesture("trk_a", kGain);
            p.engine.updateGesture("trk_a", kGain, 30'000.0, 0);  // above +24 dB
            p.engine.tick();
            p.pump(1);
            try {
                p.engine.endGesture("trk_a", kGain, "user", "t9");
                FAIL("expected invalid_gain");
            } catch (const command::CommandError& error) {
                CHECK(error.code() == "invalid_gain");
            }
            CHECK(f.session.history().revisions().size() == before);
            p.engine.tick();
            p.pump(1);
            const auto reference = offline(f.doc(), bundle, frames);
            CHECK(blocks(p.out[0], 3, 4) == blocks(reference[0], 3, 4));
        }

        SECTION("moving and ending commits one revision") {
            p.engine.beginGesture("trk_a", kGain);
            p.engine.updateGesture("trk_a", kGain, -6'000.0, 0);
            p.engine.tick();
            p.pump(2);
            CHECK(blocks(p.out[0], 2, 4) == blocks(at6[0], 2, 4));
            CHECK(blocks(p.out[1], 2, 4) == blocks(at6[1], 2, 4));
            CHECK(f.session.history().revisions().size() == before);  // nothing mid-gesture

            p.engine.updateGesture("trk_a", kGain, -3'000.0, 0);
            p.engine.tick();
            p.pump(1);
            CHECK(blocks(p.out[0], 4, 5) == blocks(at3[0], 4, 5));
            CHECK(f.session.history().revisions().size() == before);

            const command::Revision* revision = p.engine.endGesture("trk_a", kGain, "user", "t9");
            REQUIRE(revision != nullptr);
            CHECK(f.session.history().revisions().size() == before + 1);
            const command::Revision& head = f.session.history().head();
            CHECK(revision == &head);
            REQUIRE(head.commands.size() == 1);
            CHECK(head.commands[0].op() == "track.set_gain");
            CHECK(head.envelope.actor == "user");
            CHECK(head.document.track("trk_a")->gain.milliDb == -3'000);

            // The committed value keeps playing.
            p.engine.tick();
            p.pump(2);
            CHECK(blocks(p.out[0], 5, 7) == blocks(at3[0], 5, 7));
            CHECK(p.engine.underruns() == 0);
        }
    }

    if (f.session.history().revisions().size() == before + 1) {
        session::OpenReport report;
        const Session reopened = Session::open(bundle, &report);
        CHECK(report.recordsReplayed == static_cast<std::int64_t>(before + 1));
        CHECK(reopened.history().head().document.track("trk_a")->gain.milliDb == -3'000);
        CHECK(reopened.history().head().envelope.documentHash == f.session.history().head().envelope.documentHash);
    }
}

TEST_CASE("Pan and mute gestures move the sound and ending them commits their own track command",
          "[playback][gesture]") {
    Fixture f;
    f.importWav("med_st", 2, 40'000);
    f.exec(addTrack("trk_a"));
    f.exec(place("clp_a", "trk_a", "med_st", 0, 0, 40'000));
    const fs::path bundle = f.bundle();
    const auto frames = static_cast<std::int64_t>(40) * kBlock;
    const std::size_t before = f.session.history().revisions().size();
    const realtime::ParamKey panKey{playback::trackSlotKey("trk_a"), TrackFaderNode::kPan};
    const realtime::ParamKey muteKey{playback::trackSlotKey("trk_a"), TrackFaderNode::kMute};

    Player p(f.session);
    p.pump(2);

    SECTION("pan") {
        const auto panned = offline(
            withCommand(f.doc(), R"({"op":"track.set_pan","trackId":"trk_a","pan":-4000})"), bundle, frames);
        p.engine.beginGesture("trk_a", TrackFaderNode::kPan);
        p.engine.updateGesture("trk_a", TrackFaderNode::kPan, -4'000.0, 0);
        p.engine.tick();
        p.pump(2);
        CHECK(blocks(p.out[0], 2, 4) == blocks(panned[0], 2, 4));
        CHECK(blocks(p.out[1], 2, 4) == blocks(panned[1], 2, 4));
        const command::Revision* revision = p.engine.endGesture("trk_a", TrackFaderNode::kPan, "user", "t9");
        REQUIRE(revision != nullptr);
        CHECK_FALSE(p.engine.dispatcher().gestureOpen(panKey));
        CHECK(f.session.history().revisions().size() == before + 1);
        REQUIRE(revision->commands.size() == 1);
        CHECK(revision->commands[0].op() == "track.set_pan");
        CHECK(revision->document.track("trk_a")->pan == -4'000);
        p.engine.tick();
        p.pump(2);
        CHECK(blocks(p.out[0], 4, 6) == blocks(panned[0], 4, 6));
    }

    SECTION("mute") {
        p.engine.beginGesture("trk_a", TrackFaderNode::kMute);
        p.engine.updateGesture("trk_a", TrackFaderNode::kMute, 1.0, 0);
        p.engine.tick();
        p.pump(2);
        const command::Revision* revision = p.engine.endGesture("trk_a", TrackFaderNode::kMute, "user", "t9");
        REQUIRE(revision != nullptr);
        CHECK_FALSE(p.engine.dispatcher().gestureOpen(muteKey));
        REQUIRE(revision->commands.size() == 1);
        CHECK(revision->commands[0].op() == "track.set_mute");
        CHECK(revision->document.track("trk_a")->mute);
        p.engine.tick();
        p.pump(2);
        CHECK(silent(blocks(p.out[0], 4, 6)));
    }

    SECTION("an invalid pan commits nothing and the sound returns to the document") {
        p.engine.beginGesture("trk_a", TrackFaderNode::kPan);
        p.engine.updateGesture("trk_a", TrackFaderNode::kPan, 20'000.0, 0);
        try {
            p.engine.endGesture("trk_a", TrackFaderNode::kPan, "user", "t9");
            FAIL("expected invalid_pan");
        } catch (const command::CommandError& error) {
            CHECK(error.code() == "invalid_pan");
        }
        CHECK_FALSE(p.engine.dispatcher().gestureOpen(panKey));
        CHECK(f.session.history().revisions().size() == before);
        p.engine.tick();
        p.pump(1);
        const auto reference = offline(f.doc(), bundle, frames);
        CHECK(blocks(p.out[0], 2, 3) == blocks(reference[0], 2, 3));
    }

    SECTION("a parameter that cannot be committed is rejected before any gesture opens") {
        const realtime::ParamKey unknown{playback::trackSlotKey("trk_a"), 99};
        CHECK_THROWS_AS(p.engine.beginGesture("trk_a", 99), std::invalid_argument);
        CHECK_THROWS_AS(p.engine.updateGesture("trk_a", 99, 1.0, 0), std::invalid_argument);
        CHECK_FALSE(p.engine.dispatcher().gestureOpen(unknown));
    }
}

TEST_CASE("A mute gesture on a track silenced by another track's solo keeps it silent, as renderOffline does",
          "[playback][gesture][solo]") {
    Fixture f;
    f.importWav("med_st", 2, 40'000);
    f.importWav("med_mono", 1, 40'000);
    f.exec(addTrack("trk_a"));
    f.exec(addTrack("trk_b"));
    f.exec(place("clp_a", "trk_a", "med_st", 0, 0, 40'000));
    f.exec(place("clp_b", "trk_b", "med_mono", 0, 0, 40'000));
    f.exec(R"({"op":"track.set_solo","trackId":"trk_b","solo":true})");
    const fs::path bundle = f.bundle();
    const auto frames = static_cast<std::int64_t>(40) * kBlock;
    const std::size_t before = f.session.history().revisions().size();
    constexpr std::uint32_t kMute = TrackFaderNode::kMute;

    SECTION("unmuting a muted, solo-silenced track commits the mute and keeps it silent") {
        f.exec(R"({"op":"track.set_mute","trackId":"trk_a","mute":true})");
        Player p(f.session);
        p.pump(2);
        p.engine.beginGesture("trk_a", kMute);
        p.engine.updateGesture("trk_a", kMute, 0.0, 0);
        p.engine.tick();
        p.pump(2);
        const command::Revision* revision = p.engine.endGesture("trk_a", kMute, "user", "t9");
        REQUIRE(revision != nullptr);
        CHECK_FALSE(revision->document.track("trk_a")->mute);
        p.engine.tick();
        p.pump(2);
        const auto reference = offline(f.doc(), bundle, frames);
        // Mid-gesture and after the commit, only the soloed track sounds.
        CHECK(blocks(p.out[0], 2, 6) == blocks(reference[0], 2, 6));
        CHECK(blocks(p.out[1], 2, 6) == blocks(reference[1], 2, 6));
        CHECK_FALSE(silent(blocks(p.out[0], 2, 6)));
    }

    SECTION("a rejected mute gesture returns to the document's sound, still silenced by the solo") {
        Player p(f.session);
        p.pump(2);
        p.engine.beginGesture("trk_a", kMute);
        p.engine.updateGesture("trk_a", kMute, std::nan(""), 0);
        try {
            p.engine.endGesture("trk_a", kMute, "user", "t9");
            FAIL("expected invalid_mute");
        } catch (const command::CommandError& error) {
            CHECK(error.code() == "invalid_mute");
        }
        CHECK(f.session.history().revisions().size() == before);
        p.engine.tick();
        p.pump(2);
        const auto reference = offline(f.doc(), bundle, frames);
        CHECK(blocks(p.out[0], 2, 4) == blocks(reference[0], 2, 4));
        CHECK(blocks(p.out[1], 2, 4) == blocks(reference[1], 2, 4));
    }
}

TEST_CASE("No allocations on the audio thread during playback and gestures", "[playback][rt]") {
    Fixture f;
    f.importWav("med_st", 2, 30'000);
    f.importWav("med_mono", 1, 20'000);
    f.exec(addTrack("trk_a"));
    f.exec(addTrack("trk_b"));
    f.exec(place("clp_a", "trk_a", "med_st", 500, 0, 30'000));
    f.exec(place("clp_b", "trk_b", "med_mono", 0, 0, 20'000));

    Player p(f.session);
    p.pump(2);
    const auto before = rt::allocationViolations();
    p.engine.beginGesture("trk_a", kGain);
    for (int b = 0; b < 300; ++b) {
        p.engine.updateGesture("trk_a", kGain, -100.0 * (b % 60), 64);
        p.engine.updateGesture("trk_b", TrackFaderNode::kPan, 100.0 * (b % 50), 32);
        p.engine.tick();
        p.pump(1);
        if (b == 150) {
            CHECK(p.engine.endGesture("trk_a", kGain, "user", "t") != nullptr);
            p.engine.beginGesture("trk_a", kGain);
        }
    }
    CHECK(rt::allocationViolations() == before);
    CHECK(p.engine.endGesture("trk_b", TrackFaderNode::kPan, "user", "t") != nullptr);
    CHECK_FALSE(p.engine.dispatcher().gestureOpen({playback::trackSlotKey("trk_b"), TrackFaderNode::kPan}));
    CHECK(p.engine.underruns() == 0);
    CHECK_FALSE(silent(p.out[0]));
}

TEST_CASE("A session asks the device for its own rate and resamples when the device runs at another",
          "[playback][src]") {
    Fixture f;  // a 48 kHz session
    PlaybackEngine engine(f.session, testOptions());
    engine.load();

    host::ManualAudioDevice same;
    auto config = deviceConfig();
    config.sampleRate = 44'100;  // the session's rate wins over the caller's
    engine.start(same, config);
    CHECK(engine.driver().deviceStatus().sampleRate == 48'000);
    CHECK_FALSE(engine.resampling().active);
    engine.stop();

    host::ManualAudioDevice::Options fixed;
    fixed.fixedSampleRate = 44'100;
    host::ManualAudioDevice device(fixed);
    engine.start(device, deviceConfig());
    const auto state = engine.resampling();
    CHECK(state.active);
    CHECK(state.sessionRate == 48'000);
    CHECK(state.deviceRate == 44'100);
    CHECK(state.addedLatencyFrames > 0);
    for (int b = 0; b < 20; ++b) {
        device.pump(1);
        engine.butler().runOnce();
        engine.tick();
    }
    CHECK(engine.driver().srcUnderruns() == 0);
    CHECK(engine.underruns() == 0);
    engine.stop();
}

TEST_CASE("Playing through device-side SRC is sample-identical to renderOffline through the same SRC",
          "[playback][src][parity]") {
    // Spec, "Device-side SRC (M2)" and "Parity": the realtime-vs-offline
    // parity test through the same SRC. A 48 kHz session on a 44.1 kHz device.
    Fixture f;
    f.importWav("med_st", 2, 30'000);
    f.importWav("med_mono", 1, 20'000);
    f.exec(addTrack("trk_a"));
    f.exec(addTrack("trk_b"));
    // Nothing before frame 1,000, so the driver's fade-in (block 0) scales
    // only silence and the comparison can start at the first device sample.
    f.exec(place("clp_a", "trk_a", "med_st", 1'000, 0, 30'000));
    f.exec(place("clp_b", "trk_b", "med_mono", 3'000, 100, 19'000));
    f.exec(setGain("trk_b", -6'000));
    f.exec(R"({"op":"track.set_pan","trackId":"trk_b","pan":-4000})");
    constexpr std::int64_t sessionRate = 48'000;
    constexpr std::int64_t deviceRate = 44'100;
    const std::int64_t end = engine::documentEnd(f.doc());

    // Realtime: the engine on a manual device fixed at 44.1 kHz.
    host::ManualAudioDevice::Options fixed;
    fixed.fixedSampleRate = deviceRate;
    host::ManualAudioDevice device(fixed);
    PlaybackEngine engine(f.session, testOptions());
    engine.load();
    engine.start(device, deviceConfig());
    REQUIRE(engine.resampling().active);
    const realtime::LatencyReport latency = engine.driver().latency();
    // The device output covers the whole document after the SRC latency.
    const int callbacks =
        static_cast<int>(((end + latency.srcOutputLatencyFrames) * deviceRate / sessionRate + kBlock - 1) / kBlock) + 2;
    std::vector<std::vector<float>> played(2);
    for (int b = 0; b < callbacks; ++b) {
        device.pumpAll(1, played);
        engine.butler().runOnce();
        engine.tick();
    }
    CHECK(engine.driver().srcUnderruns() == 0);
    CHECK(engine.underruns() == 0);
    engine.stop();

    // Offline: renderOffline through a StreamResampler primed and fed as the
    // driver's output SRC is: its lookahead in silence (in chunks of at most
    // one graph block), the primed FIFO block of silence, then the render one
    // graph block at a time.
    realtime::StreamResampler src(static_cast<double>(sessionRate), static_cast<double>(deviceRate), 2, kBlock);
    REQUIRE(latency.srcOutputLatencyFrames == src.lookaheadFrames() + kBlock);
    const std::int64_t renderFrames = static_cast<std::int64_t>(callbacks) * kBlock * sessionRate / deviceRate + kBlock;
    const auto rendered = offline(f.doc(), f.bundle(), renderFrames);
    std::vector<std::vector<float>> expected(2);
    std::vector<std::vector<float>> in(2, std::vector<float>(kBlock, 0.0f));
    std::vector<std::vector<float>> out(2, std::vector<float>(static_cast<std::size_t>(src.maxOutputFrames())));
    const float* inPointers[2] = {in[0].data(), in[1].data()};
    float* outPointers[2] = {out[0].data(), out[1].data()};
    const auto feed = [&](int frames) {
        const int produced = src.process(inPointers, frames, outPointers);
        for (int c = 0; c < 2; ++c) {
            expected[static_cast<std::size_t>(c)].insert(expected[static_cast<std::size_t>(c)].end(),
                                                         out[static_cast<std::size_t>(c)].begin(),
                                                         out[static_cast<std::size_t>(c)].begin() + produced);
        }
    };
    for (int done = 0; done < src.lookaheadFrames();) {
        const int n = std::min(kBlock, src.lookaheadFrames() - done);
        feed(n);
        done += n;
    }
    feed(kBlock);  // the primed FIFO block
    for (std::int64_t at = 0; at + kBlock <= renderFrames; at += kBlock) {
        for (int c = 0; c < 2; ++c) {
            std::copy_n(rendered[static_cast<std::size_t>(c)].begin() + at, kBlock,
                        in[static_cast<std::size_t>(c)].begin());
        }
        feed(kBlock);
    }

    const std::size_t compared = static_cast<std::size_t>(callbacks) * kBlock;
    REQUIRE(played[0].size() == compared);
    REQUIRE(expected[0].size() >= compared);
    for (int c = 0; c < 2; ++c) {
        INFO("channel " << c);
        const auto& a = played[static_cast<std::size_t>(c)];
        const auto& e = expected[static_cast<std::size_t>(c)];
        std::size_t mismatches = 0;
        std::size_t first = compared;
        for (std::size_t i = 0; i < compared; ++i) {
            if (a[i] != e[i]) {
                ++mismatches;
                first = std::min(first, i);
            }
        }
        INFO("first mismatch at device sample " << first);
        CHECK(mismatches == 0);
        CHECK_FALSE(silent(a));
    }
}

TEST_CASE("An empty document plays silence with no underruns", "[playback]") {
    Fixture f;
    const auto compiled = playback::compileForPlayback(f.doc(), f.bundle(), testOptions());
    REQUIRE(compiled.graph);
    CHECK(compiled.graph->nodeCount() == 2);  // the master bus and its meter
    CHECK(compiled.streams.empty());
    CHECK(compiled.slots.empty());
    CHECK(compiled.meterSlots.size() == 1);
    CHECK(compiled.meterSlots.count(playback::masterMeterKey()) == 1);

    Player p(f.session);
    p.pump(10);
    REQUIRE(p.out[0].size() == static_cast<std::size_t>(10) * kBlock);
    CHECK(silent(p.out[0]));
    CHECK(silent(p.out[1]));
    CHECK(p.engine.underruns() == 0);
    CHECK(p.engine.streamCount() == 0);
}

TEST_CASE("Meter values match values computed offline from the rendered output", "[playback][meters]") {
    constexpr int kMeterBlock = 64;
    constexpr std::int64_t kFrames = 40 * kMeterBlock;
    Fixture f;
    // A stereo sine whose amplitude rises and falls, different per channel, so
    // every block reads differently.
    media::AudioBuffer sine;
    sine.info = media::AudioInfo{2, 48'000, kFrames};
    for (std::int64_t i = 0; i < kFrames; ++i) {
        const double t = static_cast<double>(i);
        const double envelope = 0.5 + 0.45 * std::sin(2.0 * 3.14159265358979323846 * t / 1'500.0);
        const double s = std::sin(2.0 * 3.14159265358979323846 * t / 37.0);
        sine.samples.push_back(static_cast<float>(envelope * s));
        sine.samples.push_back(static_cast<float>(0.8 * envelope * envelope * s));
    }
    const fs::path file = f.dir.path() / "sine.wav";
    io::writeFileAtomic(file, media::encodeWavFloat32(sine));
    session::importMedia(f.session, file, "med_sine", "test", "t");
    f.exec(addTrack("trk_a"));
    f.exec(place("clp_a", "trk_a", "med_sine", 0, 0, kFrames));

    // Reference: per-block peak and RMS of the offline render's master.
    const media::AudioBuffer rendered = engine::renderOffline(
        f.doc(), engine::loadMedia(f.doc(), f.bundle()), engine::RenderOptions{0, kFrames, kMeterBlock});
    REQUIRE(rendered.info.frames == kFrames);
    struct Expected {
        float peak[2];
        float rms[2];
    };
    std::vector<Expected> reference;
    for (std::int64_t start = 0; start < kFrames; start += kMeterBlock) {
        Expected e{};
        for (int c = 0; c < 2; ++c) {
            float peak = 0.0f;
            double sum = 0.0;
            for (std::int64_t i = start; i < start + kMeterBlock; ++i) {
                const float v = rendered.samples[static_cast<std::size_t>(i * 2 + c)];
                peak = std::max(peak, std::abs(v));
                sum += static_cast<double>(v) * static_cast<double>(v);
            }
            e.peak[c] = peak;
            e.rms[c] = static_cast<float>(std::sqrt(sum / kMeterBlock));
        }
        reference.push_back(e);
    }

    PlaybackOptions options = testOptions();
    options.maxBlockFrames = kMeterBlock;
    options.fadeFrames = kMeterBlock;
    host::AudioDeviceConfig config = deviceConfig();
    config.bufferFrames = kMeterBlock;
    host::ManualAudioDevice device;
    PlaybackEngine engine(f.session, options);
    engine.load();
    CHECK(engine.meterSlots().count("track:trk_a") == 1);
    CHECK(engine.meterSlots().count(playback::masterMeterKey()) == 1);
    engine.start(device, config);
    std::vector<std::vector<float>> out{2};
    // Drained after every block, so nothing drops; block 0 is the fade-in,
    // which the meters must not see.
    for (std::size_t b = 0; b < reference.size(); ++b) {
        INFO("block " << b);
        device.pumpAll(1, out);
        engine.butler().runOnce();
        engine.tick();
        const auto master = engine.dispatcher().meter(playback::masterMeterKey());
        const auto track = engine.dispatcher().meter("track:trk_a");
        REQUIRE(master.has_value());
        REQUIRE(track.has_value());
        CHECK(master->blockStart == static_cast<std::int64_t>(b) * kMeterBlock);
        CHECK(master->frames == kMeterBlock);
        CHECK(engine.dispatcher().meterPlayhead() == static_cast<std::int64_t>(b) * kMeterBlock);
        REQUIRE(master->reading.channels == 2);
        for (std::size_t c = 0; c < 2; ++c) {
            CHECK(master->reading.peak[c] == reference[b].peak[c]);
            CHECK(std::abs(master->reading.rms[c] - reference[b].rms[c]) < 1e-6f);
            // One track at unity master gain: the track meter reads the mix.
            CHECK(track->reading.peak[c] == master->reading.peak[c]);
            CHECK(track->reading.rms[c] == master->reading.rms[c]);
        }
    }
    CHECK(engine.driver().meterDrops() == 0);
    CHECK(engine.underruns() == 0);
    CHECK(reference[0].peak[0] > 0.0f);
    engine.stop();
}
