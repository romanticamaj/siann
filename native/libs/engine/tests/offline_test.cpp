#include <catch2/catch_test_macros.hpp>

#include <climits>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <random>
#include <string>
#include <vector>

#include "siann/engine/offline.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/session.hpp"

namespace fs = std::filesystem;
using siann::command::Command;
using siann::engine::EngineError;
using siann::engine::MediaLibrary;
using siann::engine::RenderOptions;
using siann::engine::documentEnd;
using siann::engine::loadMedia;
using siann::engine::renderOffline;
using siann::media::AudioBuffer;
using siann::media::AudioInfo;
using siann::model::Document;
using siann::session::Session;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-engine-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

// A stereo file: an impulse of 1.0 at frame `at` in both channels, else silence.
fs::path writeImpulse(const fs::path& file, std::int64_t frames, std::int64_t at, int channels = 2) {
    AudioBuffer buffer;
    buffer.info = AudioInfo{channels, 48'000, frames};
    buffer.samples.assign(static_cast<std::size_t>(frames * channels), 0.0f);
    for (int c = 0; c < channels; ++c) {
        buffer.samples[static_cast<std::size_t>(at * channels + c)] = 1.0f;
    }
    siann::io::writeFileAtomic(file, siann::media::encodeWavFloat32(buffer));
    return file;
}

Command cmd(const std::string& json) {
    return Command::fromJson(siann::json::parse(json));
}

struct Fixture {
    TempDir dir;
    Session session;

    Fixture()
        : session(Session::create(dir.path() / "Song.siann", Document::create("Song", 48'000), "test", "t0")) {
        siann::session::importMedia(session, writeImpulse(dir.path() / "impulse.wav", 100, 10), "med_imp", "test", "t1");
        session.commit({cmd(R"({"op":"track.add","trackId":"trk_a","name":"A","channels":2})"),
                        cmd(R"({"op":"track.add","trackId":"trk_b","name":"B","channels":2})")},
                       "test", "t2");
    }

    void exec(const std::string& json) { session.commit({cmd(json)}, "test", "t"); }
    const Document& doc() const { return session.history().head().document; }
    MediaLibrary library() const { return loadMedia(doc(), session.bundlePath()); }
};

float left(const AudioBuffer& b, std::int64_t frame) {
    return b.samples[static_cast<std::size_t>(frame * 2)];
}
float right(const AudioBuffer& b, std::int64_t frame) {
    return b.samples[static_cast<std::size_t>(frame * 2 + 1)];
}

std::size_t nonZero(const AudioBuffer& b) {
    std::size_t n = 0;
    for (const float s : b.samples) {
        if (s != 0.0f) {
            ++n;
        }
    }
    return n;
}

const char* kPlaceA =
    R"({"op":"clip.place","clipId":"clp_a","trackId":"trk_a","mediaId":"med_imp",
        "position":{"domain":"audio","value":"1000"},"sourceStart":"0","length":"100"})";

}  // namespace

TEST_CASE("A clip renders at its timeline position", "[engine]") {
    Fixture f;
    f.exec(kPlaceA);
    CHECK(documentEnd(f.doc()) == 1'100);
    const AudioBuffer out = renderOffline(f.doc(), f.library());
    CHECK(out.info.channels == 2);
    CHECK(out.info.sampleRate == 48'000);
    CHECK(out.info.frames == 1'100);
    CHECK(left(out, 1'010) == 1.0f);
    CHECK(right(out, 1'010) == 1.0f);
    CHECK(nonZero(out) == 2);
}

TEST_CASE("Track gain, pan and mute shape the output", "[engine]") {
    Fixture f;
    f.exec(kPlaceA);
    f.exec(R"({"op":"track.set_gain","trackId":"trk_a","gainMilliDb":-6000})");
    AudioBuffer out = renderOffline(f.doc(), f.library());
    CHECK(std::abs(left(out, 1'010) - 0.501187f) < 1e-5f);

    f.exec(R"({"op":"track.set_pan","trackId":"trk_a","pan":5000})");
    out = renderOffline(f.doc(), f.library());
    CHECK(std::abs(left(out, 1'010) - 0.5f * 0.501187f) < 1e-5f);
    CHECK(std::abs(right(out, 1'010) - 0.501187f) < 1e-5f);

    f.exec(R"({"op":"track.set_mute","trackId":"trk_a","mute":true})");
    CHECK(nonZero(renderOffline(f.doc(), f.library())) == 0);
}

TEST_CASE("Clip gain and minus infinity", "[engine]") {
    Fixture f;
    f.exec(kPlaceA);
    f.exec(R"({"op":"clip.set_gain","clipId":"clp_a","gainMilliDb":-2147483648})");
    CHECK(nonZero(renderOffline(f.doc(), f.library())) == 0);
}

TEST_CASE("Solo silences tracks that are not soloed", "[engine]") {
    Fixture f;
    f.exec(kPlaceA);
    f.exec(R"({"op":"clip.place","clipId":"clp_b","trackId":"trk_b","mediaId":"med_imp",
        "position":{"domain":"audio","value":"2000"},"sourceStart":"0","length":"100"})");
    CHECK(nonZero(renderOffline(f.doc(), f.library())) == 4);
    f.exec(R"({"op":"track.set_solo","trackId":"trk_b","solo":true})");
    const AudioBuffer out = renderOffline(f.doc(), f.library());
    CHECK(nonZero(out) == 2);
    CHECK(left(out, 2'010) == 1.0f);
}

TEST_CASE("Music time positions follow the tempo map", "[engine]") {
    Fixture f;
    f.exec(R"({"op":"clip.place","clipId":"clp_m","trackId":"trk_a","mediaId":"med_imp",
        "position":{"domain":"music","value":"1920"},"sourceStart":"0","length":"100"})");
    AudioBuffer out = renderOffline(f.doc(), f.library());
    CHECK(left(out, 24'000 + 10) == 1.0f);  // one quarter at 120 BPM

    f.exec(R"({"op":"session.set_tempo","tempo":[{"ticks":"0","milliBpm":60000}]})");
    out = renderOffline(f.doc(), f.library());
    CHECK(left(out, 48'000 + 10) == 1.0f);  // the clip moves with the tempo
}

TEST_CASE("Trimming and render ranges", "[engine]") {
    Fixture f;
    f.exec(R"({"op":"clip.place","clipId":"clp_a","trackId":"trk_a","mediaId":"med_imp",
        "position":{"domain":"audio","value":"1000"},"sourceStart":"5","length":"20"})");
    AudioBuffer out = renderOffline(f.doc(), f.library());
    CHECK(out.info.frames == 1'020);
    CHECK(left(out, 1'005) == 1.0f);  // media frame 10 sits at 1000 + (10 - 5)

    out = renderOffline(f.doc(), f.library(), RenderOptions{1'000, 10, 4});
    CHECK(out.info.frames == 10);
    CHECK(left(out, 5) == 1.0f);
    CHECK(nonZero(out) == 2);

    f.exec(R"({"op":"clip.trim","clipId":"clp_a","sourceStart":"11","length":"20"})");
    CHECK(nonZero(renderOffline(f.doc(), f.library())) == 0);  // the impulse is trimmed away
}

TEST_CASE("Rendering is deterministic and independent of block size", "[engine]") {
    Fixture f;
    f.exec(kPlaceA);
    f.exec(R"({"op":"track.set_gain","trackId":"trk_a","gainMilliDb":-1234})");
    f.exec(R"({"op":"track.set_pan","trackId":"trk_a","pan":-3333})");
    const AudioBuffer a = renderOffline(f.doc(), f.library(), RenderOptions{0, -1, 512});
    const AudioBuffer b = renderOffline(f.doc(), f.library(), RenderOptions{0, -1, 37});
    CHECK(a.samples == b.samples);
    const Document reloaded = Document::fromJson(f.doc().toJson());
    CHECK(renderOffline(reloaded, f.library()).samples == a.samples);
}

TEST_CASE("Missing or altered media files are reported", "[engine]") {
    Fixture f;
    f.exec(kPlaceA);
    const auto* media = f.doc().media("med_imp");
    const fs::path file = siann::session::mediaPath(f.session.bundlePath(), media->contentHash);

    std::string bytes = siann::io::readFile(file);
    bytes[bytes.size() - 1] ^= 0x01;
    siann::io::writeFileAtomic(file, bytes);
    try {
        (void)f.library();
        FAIL("expected media_hash_mismatch");
    } catch (const EngineError& error) {
        CHECK(error.code() == "media_hash_mismatch");
    }

    fs::remove(file);
    try {
        (void)f.library();
        FAIL("expected media_missing");
    } catch (const EngineError& error) {
        CHECK(error.code() == "media_missing");
    }
}

TEST_CASE("An empty session renders nothing", "[engine]") {
    Fixture f;
    CHECK(documentEnd(f.doc()) == 0);
    CHECK(renderOffline(f.doc(), f.library()).info.frames == 0);
    CHECK_THROWS_AS(renderOffline(f.doc(), f.library(), RenderOptions{-1, 10, 512}), EngineError);
}

#include "support/flac_test_encoder.hpp"

TEST_CASE("FLAC media renders like WAV media", "[engine][flac]") {
    Fixture f;
    std::vector<std::int16_t> samples(2 * 32, 0);
    samples[2 * 5] = 16'384;      // left, frame 5: 0.5
    samples[2 * 5 + 1] = -16'384; // right, frame 5: -0.5
    const fs::path source = f.dir.path() / "hit.flac";
    siann::io::writeFileAtomic(source, siann::test::encodeFlac16(2, 48'000, samples));
    siann::session::importMedia(f.session, source, "med_hit", "test", "t");
    f.exec(R"({"op":"clip.place","clipId":"clp_f","trackId":"trk_a","mediaId":"med_hit",
        "position":{"domain":"audio","value":"100"},"sourceStart":"0","length":"32"})");
    const AudioBuffer out = renderOffline(f.doc(), f.library());
    CHECK(left(out, 105) == 0.5f);
    CHECK(right(out, 105) == -0.5f);
    CHECK(nonZero(out) == 2);
}

// ---- m5b-engine-master: the master gain on the master bus ---------------------

namespace {

// A stereo file whose every sample differs, so a scaled render shows anywhere.
fs::path writeRamp(const fs::path& file, std::int64_t frames) {
    AudioBuffer buffer;
    buffer.info = AudioInfo{2, 48'000, frames};
    for (std::int64_t i = 0; i < frames; ++i) {
        buffer.samples.push_back(static_cast<float>(i % 997) / 1'000.0f);
        buffer.samples.push_back(-static_cast<float>(i % 631) / 700.0f);
    }
    siann::io::writeFileAtomic(file, siann::media::encodeWavFloat32(buffer));
    return file;
}

// Two gained, panned tracks summing on the master.
void mixSession(Fixture& f) {
    siann::session::importMedia(f.session, writeRamp(f.dir.path() / "ramp.wav", 3'000), "med_ramp", "test", "t");
    f.exec(R"({"op":"clip.place","clipId":"clp_a","trackId":"trk_a","mediaId":"med_ramp",
        "position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"3000"})");
    f.exec(R"({"op":"clip.place","clipId":"clp_b","trackId":"trk_b","mediaId":"med_ramp",
        "position":{"domain":"audio","value":"500"},"sourceStart":"100","length":"2000"})");
    f.exec(R"({"op":"track.set_gain","trackId":"trk_a","gainMilliDb":-1234})");
    f.exec(R"({"op":"track.set_pan","trackId":"trk_b","pan":-3333})");
}

std::string setMaster(std::int32_t milliDb) {
    return R"({"op":"master.set_gain","gainMilliDb":)" + std::to_string(milliDb) + "}";
}

// The offline graph as it was before the master gain: per track clips and a
// fader into the master bus, which is the output.
AudioBuffer renderWithoutMasterNode(const Document& document, const MediaLibrary& library) {
    using namespace siann::graph;
    GraphBuilder builder;
    const NodeId bus = builder.add(std::make_unique<BusNode>(2), "master");
    for (const siann::engine::FlatTrack& flat : siann::engine::flattenClips(document)) {
        std::vector<ClipPlayerNode::Clip> clips;
        for (const siann::engine::FlatClip& clip : flat.clips) {
            clips.push_back(ClipPlayerNode::Clip{clip.timelineStart, clip.sourceStart, clip.length, clip.gain,
                                                 library.media.at(clip.media->contentHash)});
        }
        const NodeId player = builder.add(std::make_unique<ClipPlayerNode>(flat.track->channels, std::move(clips)),
                                          flat.track->id + ".clips");
        const NodeId fader = builder.add(std::make_unique<TrackFaderNode>(flat.track->channels, flat.track->gain.milliDb,
                                                                          flat.track->pan, flat.track->mute,
                                                                          flat.soloSilenced),
                                         flat.track->id + ".fader");
        builder.connect(player, fader);
        builder.connect(fader, bus);
    }
    builder.setOutput(bus);
    auto graph = std::move(builder).compile(512);
    return siann::engine::renderGraph(*graph, 0, documentEnd(document), document.root().sampleRate);
}

}  // namespace

TEST_CASE("A render at master -6 dB is the 0 dB render scaled sample for sample", "[engine][master]") {
    Fixture f;
    mixSession(f);
    const AudioBuffer unity = renderOffline(f.doc(), f.library());
    REQUIRE(nonZero(unity) > 1'000);
    f.exec(setMaster(-6'000));
    REQUIRE(f.doc().master() != nullptr);
    const AudioBuffer scaled = renderOffline(f.doc(), f.library());
    REQUIRE(scaled.samples.size() == unity.samples.size());
    const float g = siann::graph::gainFromMilliDb(-6'000);
    std::size_t mismatches = 0;
    for (std::size_t i = 0; i < unity.samples.size(); ++i) {
        if (scaled.samples[i] != unity.samples[i] * g) {
            ++mismatches;
        }
    }
    CHECK(mismatches == 0);
    CHECK(scaled.samples != unity.samples);
    // Independent of block size, as every render is.
    CHECK(renderOffline(f.doc(), f.library(), RenderOptions{0, -1, 37}).samples == scaled.samples);
}

TEST_CASE("A master at minus infinity renders silence", "[engine][master]") {
    Fixture f;
    mixSession(f);
    f.exec(setMaster(INT32_MIN));
    const AudioBuffer out = renderOffline(f.doc(), f.library());
    CHECK(out.info.frames == documentEnd(f.doc()));
    CHECK(nonZero(out) == 0);
}

TEST_CASE("A document without the master renders bit-identically to the graph without a master gain",
          "[engine][master]") {
    Fixture f;
    mixSession(f);
    REQUIRE(f.doc().master() == nullptr);
    const AudioBuffer reference = renderWithoutMasterNode(f.doc(), f.library());
    CHECK(renderOffline(f.doc(), f.library()).samples == reference.samples);
    // Set and set back to 0 dB: the same document, the same render.
    f.exec(setMaster(-6'000));
    f.exec(setMaster(0));
    REQUIRE(f.doc().master() == nullptr);
    CHECK(renderOffline(f.doc(), f.library()).samples == reference.samples);
    // A master of +24 dB clips nothing in a float render: exactly the scaled sum.
    f.exec(setMaster(24'000));
    const AudioBuffer loud = renderOffline(f.doc(), f.library());
    const float g = siann::graph::gainFromMilliDb(24'000);
    for (std::size_t i = 0; i < reference.samples.size(); i += 101) {
        CHECK(loud.samples[i] == reference.samples[i] * g);
    }
}
