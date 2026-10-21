#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <filesystem>
#include <random>
#include <string>

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
