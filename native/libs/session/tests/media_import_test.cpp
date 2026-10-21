#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <filesystem>
#include <numbers>
#include <random>
#include <string>

#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/session/media_import.hpp"

namespace fs = std::filesystem;
using siann::command::CommandError;
using siann::media::AudioBuffer;
using siann::media::AudioInfo;
using siann::media::MediaError;
using siann::model::Document;
using siann::session::OpenReport;
using siann::session::Session;
using siann::session::importMedia;
using siann::session::mediaPath;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-import-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

fs::path writeSine(const fs::path& file, std::int64_t rate, std::int64_t frames) {
    AudioBuffer buffer;
    buffer.info = AudioInfo{2, rate, frames};
    for (std::int64_t i = 0; i < frames; ++i) {
        const auto v = static_cast<float>(0.25 * std::sin(2.0 * std::numbers::pi * 440.0 * static_cast<double>(i) /
                                                          static_cast<double>(rate)));
        buffer.samples.push_back(v);
        buffer.samples.push_back(v);
    }
    siann::io::writeFileAtomic(file, siann::media::encodeWavFloat32(buffer));
    return file;
}

Session newSession(const fs::path& bundle) {
    return Session::create(bundle, Document::create("Song", 48'000), "tester", "t0");
}

}  // namespace

TEST_CASE("A file at the session rate is stored byte for byte", "[import]") {
    TempDir dir;
    const fs::path source = writeSine(dir.path() / "loop.wav", 48'000, 4'800);
    Session session = newSession(dir.path() / "Song.siann");

    const auto result = importMedia(session, source, "med_loop", "agent", "t1");
    CHECK_FALSE(result.converted);
    const auto* media = result.revision->document.media("med_loop");
    REQUIRE(media != nullptr);
    CHECK(media->frames == 4'800);
    CHECK(media->channels == 2);
    CHECK_FALSE(media->originalHash.has_value());

    const std::string original = siann::io::readFile(source);
    CHECK(media->contentHash == siann::hash::sha256(original));
    CHECK(result.storedFile == mediaPath(session.bundlePath(), media->contentHash));
    CHECK(siann::io::readFile(result.storedFile) == original);
}

TEST_CASE("A file at another rate is converted and keeps its original hash", "[import]") {
    TempDir dir;
    const fs::path source = writeSine(dir.path() / "loop44.wav", 44'100, 44'100);
    Session session = newSession(dir.path() / "Song.siann");

    const auto result = importMedia(session, source, "med_loop", "agent", "t1");
    CHECK(result.converted);
    const auto* media = result.revision->document.media("med_loop");
    REQUIRE(media != nullptr);
    CHECK(media->sampleRate == 48'000);
    CHECK(media->frames == 48'000);
    REQUIRE(media->originalHash.has_value());
    CHECK(*media->originalHash == siann::hash::sha256(siann::io::readFile(source)));

    const auto stored = siann::media::decodeWav(siann::io::readFile(result.storedFile));
    CHECK(stored.info.sampleRate == 48'000);
    CHECK(stored.info.frames == 48'000);
    CHECK(media->contentHash == siann::hash::sha256(siann::io::readFile(result.storedFile)));
}

TEST_CASE("Reopening replays media.add without re-running the import", "[import]") {
    TempDir dir;
    const fs::path source = writeSine(dir.path() / "loop.wav", 48'000, 480);
    const fs::path bundle = dir.path() / "Song.siann";
    siann::hash::Digest hash{};
    {
        Session session = newSession(bundle);
        hash = importMedia(session, source, "med_loop", "agent", "t1").revision->document.media("med_loop")->contentHash;
    }
    fs::remove(source);  // the job's input is gone; replay must not need it
    const Session reopened = Session::open(bundle);
    REQUIRE(reopened.history().head().document.media("med_loop") != nullptr);
    CHECK(reopened.history().head().document.media("med_loop")->contentHash == hash);
    CHECK(fs::exists(mediaPath(bundle, hash)));
}

TEST_CASE("The same content imported twice shares one file", "[import]") {
    TempDir dir;
    const fs::path source = writeSine(dir.path() / "loop.wav", 48'000, 480);
    Session session = newSession(dir.path() / "Song.siann");
    const auto a = importMedia(session, source, "med_a", "agent", "t1");
    const auto b = importMedia(session, source, "med_b", "agent", "t2");
    CHECK(a.storedFile == b.storedFile);
    std::size_t files = 0;
    for (const auto& entry : fs::directory_iterator(session.bundlePath() / "media")) {
        (void)entry;
        ++files;
    }
    CHECK(files == 1);
}

TEST_CASE("A rejected media.add leaves the stored file but no revision", "[import]") {
    TempDir dir;
    const fs::path source = writeSine(dir.path() / "loop.wav", 48'000, 480);
    Session session = newSession(dir.path() / "Song.siann");
    importMedia(session, source, "med_a", "agent", "t1");
    const auto seq = session.lastSeq();
    CHECK_THROWS_AS(importMedia(session, source, "med_a", "agent", "t2"), CommandError);
    CHECK(session.lastSeq() == seq);
}

TEST_CASE("Unsupported files are rejected before anything is stored", "[import]") {
    TempDir dir;
    const fs::path source = dir.path() / "notes.txt";
    siann::io::writeFileAtomic(source, "not audio at all");
    Session session = newSession(dir.path() / "Song.siann");
    CHECK_THROWS_AS(importMedia(session, source, "med_x", "agent", "t1"), MediaError);
    CHECK(fs::is_empty(session.bundlePath() / "media"));
    CHECK(session.lastSeq() == 1);
}
