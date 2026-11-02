#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <random>
#include <string>
#include <vector>

#include "siann/command/command.hpp"
#include "siann/engine/offline.hpp"
#include "siann/hash/json.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/playback/playback_engine.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/session.hpp"

// Structural edits while playing (architecture spec, revision 3.1,
// "Publishing and retiring graphs", "State migration"): the playback engine
// recompiles the latest document, reuses unchanged disk streams, prefills new
// ones from the playhead, publishes with duck-and-swap and destroys a stream
// only after its last graph retired and the butler released it.

namespace fs = std::filesystem;
using namespace siann;
using command::Command;
using model::Document;
using playback::PlaybackEngine;
using playback::PlaybackOptions;
using session::Session;

namespace {

constexpr int kBlock = 256;

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-live-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

// Two tracks with distinct WAV media, one stereo and one mono.
struct Fixture {
    TempDir dir;
    Session session;

    Fixture() : session(Session::create(dir.path() / "Song.siann", Document::create("Song", 48'000), "test", "t0")) {
        importWav("med_st", 2, 60'000);
        importWav("med_mono", 1, 40'000);
        exec(addTrack("trk_a"));
        exec(addTrack("trk_b"));
        exec(place("clp_a", "trk_a", "med_st", 0, 0, 50'000));
        exec(place("clp_b", "trk_b", "med_mono", 1'000, 200, 35'000));
    }

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
    o.fadeFrames = kBlock;  // a duck or a rise is exactly one block
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

// A loaded engine playing on a manual device. Each pumped block is followed by
// the engine's tick (retire bookkeeping and compiles), a butler pass and a
// second tick (publishing what the butler prefilled).
struct Live {
    host::ManualAudioDevice device;
    PlaybackEngine engine;
    std::vector<std::vector<float>> out{2};
    std::vector<bool> inFlightBefore;  // per block: a graph waited in the inbox

    explicit Live(Session& session) : engine(session, testOptions()) {
        engine.load();
        engine.start(device, deviceConfig());
    }
    ~Live() { engine.stop(); }

    void pump(int blocks) {
        for (int b = 0; b < blocks; ++b) {
            inFlightBefore.push_back(engine.driver().transitionInFlight());
            device.pumpAll(1, out);
            engine.tick();
            engine.butler().runOnce();
            engine.tick();
        }
    }

    int blockCount() const { return static_cast<int>(out[0].size()) / kBlock; }

    // The last block that started with a graph in the inbox: it ducks the old
    // graph, the next one rises with the new graph.
    int lastDuckBlock() const {
        for (int b = static_cast<int>(inFlightBefore.size()) - 1; b >= 0; --b) {
            if (inFlightBefore[static_cast<std::size_t>(b)]) {
                return b;
            }
        }
        return -1;
    }
};

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

// Output blocks [from, to) on both channels equal the offline render.
bool matches(const Live& live, const std::vector<std::vector<float>>& reference, int from, int to) {
    return blocks(live.out[0], from, to) == blocks(reference[0], from, to) &&
           blocks(live.out[1], from, to) == blocks(reference[1], from, to);
}

std::int64_t framesOf(const Live& live) {
    return static_cast<std::int64_t>(live.blockCount()) * kBlock;
}

}  // namespace

TEST_CASE("Adding a track while playing swaps with duck-and-swap and then matches the offline render of the new "
          "document",
          "[playback][live]") {
    Fixture f;
    Live p(f.session);
    p.pump(40);
    const Document before = f.doc();
    const std::uint64_t epoch = p.engine.driver().liveEpoch();
    const std::size_t compiles = p.engine.compileCount();

    f.session.commit({cmd(addTrack("trk_c")), cmd(place("clp_c", "trk_c", "med_st", 2'000, 3'000, 40'000))}, "test",
                     "t");
    const auto allocations = rt::allocationViolations();
    p.engine.update(f.doc());
    p.pump(30);

    CHECK(p.engine.driver().liveEpoch() != epoch);
    CHECK(p.engine.compileCount() == compiles + 1);
    CHECK(p.engine.slots().count(playback::trackSlotKey("trk_c")) == 1);
    CHECK(p.engine.streamCount() == 3);
    const int duck = p.lastDuckBlock();
    REQUIRE(duck >= 40);
    const int n = p.blockCount();
    const auto oldReference = offline(before, f.bundle(), framesOf(p));
    const auto newReference = offline(f.doc(), f.bundle(), framesOf(p));
    CHECK(matches(p, oldReference, 1, duck));
    CHECK(matches(p, newReference, duck + 2, n));

    // The duck block fades the old graph out; the rise block fades the new one in.
    // M2 ducks the whole mix, unaffected tracks included (spec, M2 interim note).
    bool withinEnvelope = true;
    for (int c = 0; c < 2; ++c) {
        for (int i = 0; i < kBlock; ++i) {
            const auto at = static_cast<std::size_t>(duck * kBlock + i);
            const float duckGain = static_cast<float>(kBlock - i) / static_cast<float>(kBlock);
            const float riseGain = 1.0f - static_cast<float>(kBlock - i) / static_cast<float>(kBlock);
            const auto& o = p.out[static_cast<std::size_t>(c)];
            const auto& oldRef = oldReference[static_cast<std::size_t>(c)];
            const auto& newRef = newReference[static_cast<std::size_t>(c)];
            withinEnvelope = withinEnvelope && std::abs(o[at]) <= std::abs(oldRef[at]) * duckGain + 1e-6f;
            withinEnvelope = withinEnvelope && std::abs(o[at + kBlock]) <= std::abs(newRef[at + kBlock]) * riseGain + 1e-6f;
        }
    }
    CHECK(withinEnvelope);
    CHECK(p.engine.underruns() == 0);
    CHECK(rt::allocationViolations() == allocations);
}

TEST_CASE("Removing a track destroys its stream only after retire and butler release", "[playback][live]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    REQUIRE(p.engine.streamCount() == 2);

    f.exec(R"({"op":"track.remove","trackId":"trk_b"})");
    p.engine.update(f.doc());
    p.engine.tick();  // compiles; every stream is reused, so it publishes at once
    REQUIRE(p.engine.driver().transitionInFlight());
    p.device.pumpAll(1, p.out);  // the duck block; the swap lands at its end
    CHECK(p.engine.streamCount() == 2);

    p.engine.tick();  // the swap acknowledgement retires the old graph
    REQUIRE_FALSE(p.engine.driver().transitionInFlight());
    CHECK(p.engine.streamCount() == 2);  // removal requested, not yet released
    p.engine.butler().runOnce();          // the butler releases it
    CHECK(p.engine.streamCount() == 2);  // destroyed on the command thread's tick
    p.engine.tick();
    CHECK(p.engine.streamCount() == 1);
    CHECK(p.engine.streamFor("trk_b") == nullptr);

    p.pump(20);
    const auto reference = offline(f.doc(), f.bundle(), framesOf(p));
    CHECK(matches(p, reference, 22, p.blockCount()));
    CHECK(p.engine.underruns() == 0);
}

TEST_CASE("A clip edit replaces only that track's stream", "[playback][live]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const realtime::DiskStream* streamA = p.engine.streamFor("trk_a");
    const realtime::DiskStream* streamB = p.engine.streamFor("trk_b");
    REQUIRE(streamA != nullptr);
    REQUIRE(streamB != nullptr);

    f.exec(R"({"op":"clip.move","clipId":"clp_b","position":{"domain":"audio","value":"9000"}})");
    p.engine.update(f.doc());
    p.pump(20);

    CHECK(p.engine.streamFor("trk_a") == streamA);
    CHECK(p.engine.streamFor("trk_b") != nullptr);
    CHECK(p.engine.streamFor("trk_b") != streamB);
    CHECK(p.engine.streamCount() == 2);
    const int duck = p.lastDuckBlock();
    REQUIRE(duck >= 20);
    const auto reference = offline(f.doc(), f.bundle(), framesOf(p));
    CHECK(matches(p, reference, duck + 2, p.blockCount()));
    CHECK(p.engine.underruns() == 0);
}

TEST_CASE("Rapid successive edits coalesce: the next compile uses the latest document", "[playback][live]") {
    Fixture f;
    Live p(f.session);
    p.pump(20);
    const std::size_t compiles = p.engine.compileCount();
    const auto allocations = rt::allocationViolations();

    f.exec(R"({"op":"track.remove","trackId":"trk_b"})");
    p.engine.update(f.doc());
    p.engine.tick();
    REQUIRE(p.engine.driver().transitionInFlight());  // doc1 is on its way
    CHECK(p.engine.compileCount() == compiles + 1);

    f.exec(addTrack("trk_c", 1));
    p.engine.update(f.doc());  // doc2: never compiled
    f.exec(place("clp_c", "trk_c", "med_mono", 4'000, 0, 30'000));
    p.engine.update(f.doc());  // doc3
    p.pump(30);

    CHECK(p.engine.compileCount() == compiles + 2);
    CHECK(p.engine.slots().size() == 2);
    CHECK(p.engine.slots().count(playback::trackSlotKey("trk_c")) == 1);
    CHECK(p.engine.streamCount() == 2);
    CHECK_FALSE(p.engine.driver().transitionInFlight());
    const int duck = p.lastDuckBlock();
    REQUIRE(duck >= 21);
    const auto reference = offline(f.doc(), f.bundle(), framesOf(p));
    CHECK(matches(p, reference, duck + 2, p.blockCount()));
    CHECK(p.engine.underruns() == 0);
    CHECK(rt::allocationViolations() == allocations);
}

TEST_CASE("A locate that lands between the compile and the publish reaches the new track's stream",
          "[playback][live][locate]") {
    Fixture f;
    Live p(f.session);
    p.pump(100);  // the playhead is well past the locate target
    constexpr std::int64_t kTarget = 2'000;

    f.session.commit({cmd(addTrack("trk_c")), cmd(place("clp_c", "trk_c", "med_st", 0, 3'000, 40'000))}, "test", "t");
    p.engine.update(f.doc());
    p.engine.tick();  // compiles from the playhead; the new stream is not prefilled yet
    REQUIRE_FALSE(p.engine.driver().transitionInFlight());

    // The butler takes the new stream and prepares the locate for every stream;
    // the locate then lands on the old graph before the new one is published.
    p.engine.butler().seek(2, kTarget);
    p.engine.butler().runOnce();
    REQUIRE(p.engine.butler().ready(2));
    REQUIRE(p.engine.driver().pushLocate(realtime::TransportCommand{2, kTarget}));
    const int locateBlock = p.blockCount();
    p.inFlightBefore.push_back(p.engine.driver().transitionInFlight());
    p.device.pumpAll(1, p.out);  // the old graph ducks; the jump lands at the block's end
    p.pump(30);                  // publishes, swaps and plays the new graph

    REQUIRE_FALSE(p.engine.driver().transitionInFlight());
    CHECK(p.engine.slots().count(playback::trackSlotKey("trk_c")) == 1);
    const int duck = p.lastDuckBlock();
    REQUIRE(duck > locateBlock);
    // From the block after the locate on, block b plays the timeline from
    // kTarget + (b - locateBlock - 1) blocks.
    const auto reference = offline(f.doc(), f.bundle(), kTarget + framesOf(p));
    bool inTime = true;
    for (int b = duck + 2; b < p.blockCount(); ++b) {
        const std::int64_t at = kTarget + static_cast<std::int64_t>(b - locateBlock - 1) * kBlock;
        for (int c = 0; c < 2; ++c) {
            const auto& o = p.out[static_cast<std::size_t>(c)];
            const auto& r = reference[static_cast<std::size_t>(c)];
            inTime = inTime && std::equal(o.begin() + static_cast<std::ptrdiff_t>(b) * kBlock,
                                          o.begin() + static_cast<std::ptrdiff_t>(b + 1) * kBlock,
                                          r.begin() + static_cast<std::ptrdiff_t>(at));
        }
    }
    CHECK(inTime);
    CHECK(p.engine.underruns() == 0);
}

TEST_CASE("An edit that only changes fader parameters does not recompile", "[playback][live]") {
    Fixture f;
    Live p(f.session);
    p.pump(10);
    const std::size_t compiles = p.engine.compileCount();
    const std::uint64_t epoch = p.engine.driver().liveEpoch();

    f.session.commit({cmd(R"({"op":"track.set_gain","trackId":"trk_a","gainMilliDb":-6000})"),
                      cmd(R"({"op":"track.set_pan","trackId":"trk_b","pan":-3000})")},
                     "test", "t");
    p.engine.update(f.doc());
    p.pump(12);

    CHECK(p.engine.compileCount() == compiles);
    CHECK(p.engine.driver().liveEpoch() == epoch);
    CHECK(p.inFlightBefore == std::vector<bool>(p.inFlightBefore.size(), false));
    // Block 10 was rendered before the dispatcher's tick; block 11 on carries the edit.
    const auto reference = offline(f.doc(), f.bundle(), framesOf(p));
    CHECK(matches(p, reference, 11, p.blockCount()));
    CHECK(p.engine.underruns() == 0);
}
