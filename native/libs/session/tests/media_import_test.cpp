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

#include "support/flac_test_encoder.hpp"

TEST_CASE("FLAC at the session rate is stored verbatim as .flac", "[import][flac]") {
    TempDir dir;
    const fs::path source = dir.path() / "take.flac";
    std::vector<std::int16_t> samples;
    for (int i = 0; i < 64; ++i) {
        samples.push_back(static_cast<std::int16_t>(i * 100));
    }
    const std::string flac = siann::test::encodeFlac16(1, 48'000, samples);
    siann::io::writeFileAtomic(source, flac);
    Session session = newSession(dir.path() / "Song.siann");

    const auto result = importMedia(session, source, "med_take", "agent", "t1");
    CHECK_FALSE(result.converted);
    const auto* media = result.revision->document.media("med_take");
    REQUIRE(media != nullptr);
    CHECK(media->format == siann::model::MediaFormat::flac);
    CHECK(media->frames == 64);
    CHECK(result.storedFile.extension() == ".flac");
    CHECK(siann::io::readFile(result.storedFile) == flac);
}

TEST_CASE("FLAC at another rate is converted to float WAV", "[import][flac]") {
    TempDir dir;
    const fs::path source = dir.path() / "take44.flac";
    std::vector<std::int16_t> samples(2 * 441, 0);
    siann::io::writeFileAtomic(source, siann::test::encodeFlac16(2, 44'100, samples, 256));
    Session session = newSession(dir.path() / "Song.siann");

    const auto result = importMedia(session, source, "med_take", "agent", "t1");
    CHECK(result.converted);
    const auto* media = result.revision->document.media("med_take");
    CHECK(media->format == siann::model::MediaFormat::wav);
    CHECK(media->frames == 480);
    CHECK(result.storedFile.extension() == ".wav");
}

TEST_CASE("A crash after the media write but before the journal append recovers", "[import][recovery]") {
    TempDir dir;
    const fs::path source = writeSine(dir.path() / "loop.wav", 48'000, 480);
    const fs::path bundle = dir.path() / "Song.siann";
    const std::string bytes = siann::io::readFile(source);
    const auto hash = siann::hash::sha256(bytes);
    {
        Session session = newSession(bundle);
        // The job wrote its output, then the process died before media.add.
        siann::io::writeFileAtomic(mediaPath(bundle, hash), bytes);
    }
    OpenReport report;
    Session reopened = Session::open(bundle, &report);
    CHECK(report.recordsReplayed == 1);
    CHECK(reopened.history().head().document.allMedia().empty());
    CHECK(fs::exists(mediaPath(bundle, hash)));  // unreferenced, kept, harmless

    // Running the import again commits it and reuses the stored file.
    const auto result = importMedia(reopened, source, "med_loop", "agent", "t2");
    CHECK(result.storedFile == mediaPath(bundle, hash));
    CHECK(reopened.lastSeq() == 2);
}

// ---- m5b-engine-project-media: the two-phase import of the media.import job ----

#include <atomic>
#include <set>
#include <thread>

#include "siann/media/audio_source.hpp"
#include "siann/media/memory_reader.hpp"
#include "siann/media/peaks.hpp"
#include "support/paced_source.hpp"

using siann::session::ImportProgress;
using siann::session::ImportSource;
using siann::session::PreparedImport;
using siann::session::commitImport;
using siann::session::discardImport;
using siann::session::mediaNameFromPath;
using siann::session::openImportSource;
using siann::session::prepareImport;

namespace {

// Every file under a directory (none when it does not exist).
std::set<fs::path> filesUnder(const fs::path& directory) {
    std::set<fs::path> out;
    std::error_code ec;
    if (!fs::exists(directory, ec)) {
        return out;
    }
    for (const auto& entry : fs::recursive_directory_iterator(directory)) {
        if (entry.is_regular_file()) {
            out.insert(entry.path());
        }
    }
    return out;
}

std::string importCode(const fs::path& bundle, std::int64_t rate, const fs::path& file) {
    try {
        ImportSource source = openImportSource(file);
        (void)prepareImport(bundle, rate, source);
    } catch (const MediaError& error) {
        return error.code();
    }
    return "no error";
}

std::string pathText(const fs::path& path) {
    const std::u8string text = path.u8string();
    return std::string(text.begin(), text.end());
}

}  // namespace

TEST_CASE("prepare writes media and peaks off the session; commit adds one media.add", "[import][job]") {
    TempDir dir;
    const fs::path file = writeSine(dir.path() / "Loop 44.wav", 44'100, 30'000);
    Session session = newSession(dir.path() / "Song.siann");
    const auto headBefore = session.history().head().envelope.id;

    ImportProgress progress;
    ImportSource source = openImportSource(file);
    CHECK(source.name == "Loop 44.wav");
    const PreparedImport prepared = prepareImport(session.bundlePath(), 48'000, source, &progress);
    CHECK(session.history().head().envelope.id == headBefore);  // nothing committed yet
    CHECK(progress.framesTotal.load() == 30'000);
    CHECK(progress.framesDone.load() == 30'000);

    // Byte for byte the whole-buffer conversion importMedia has always stored.
    const std::string original = siann::io::readFile(file);
    const std::string expected =
        siann::media::encodeWavFloat32(siann::media::resample(siann::media::decode(original), 48'000));
    CHECK(prepared.contentHash == siann::hash::sha256(expected));
    REQUIRE(prepared.originalHash.has_value());
    CHECK(*prepared.originalHash == siann::hash::sha256(original));
    CHECK(prepared.mediaFile == mediaPath(session.bundlePath(), prepared.contentHash));
    CHECK(siann::io::readFile(prepared.mediaFile) == expected);

    // The peak pyramid of the stored media.
    siann::media::MemoryMediaReader reader(siann::media::decode(expected));
    const std::string peaks = siann::media::encodePeaks(siann::media::computePeaks(reader));
    CHECK(prepared.peaksFile ==
          siann::media::peaksPath(session.bundlePath(), siann::hash::toHex(prepared.contentHash)));
    CHECK(siann::io::readFile(prepared.peaksFile) == peaks);
    CHECK(std::set<fs::path>(prepared.created.begin(), prepared.created.end()) ==
          std::set<fs::path>{prepared.mediaFile, prepared.peaksFile});

    const auto* committed = &commitImport(session, prepared, "med_1", "agent", "t1");  // GCC -Wdangling-reference
    const auto& revision = *committed;
    REQUIRE(revision.commands.size() == 1);
    CHECK(revision.commands[0].op() == "media.add");
    const auto* media = revision.document.media("med_1");
    REQUIRE(media != nullptr);
    CHECK(media->contentHash == prepared.contentHash);
    CHECK(media->originalHash == prepared.originalHash);
    CHECK(media->frames == siann::media::probe(expected).frames);
    CHECK(media->sampleRate == 48'000);
    REQUIRE(media->name.has_value());
    CHECK(*media->name == "Loop 44.wav");
    CHECK(session.lastSeq() == 2);
}

TEST_CASE("prepare stores a file at the session rate byte for byte, FLAC included", "[import][job]") {
    TempDir dir;
    std::vector<std::int16_t> samples;
    for (int i = 0; i < 2 * 5'000; ++i) {
        samples.push_back(static_cast<std::int16_t>((i * 31) % 20'000 - 10'000));
    }
    const fs::path file = dir.path() / "take.flac";
    const std::string flac = siann::test::encodeFlac16(2, 48'000, samples, 256);
    siann::io::writeFileAtomic(file, flac);
    Session session = newSession(dir.path() / "Song.siann");
    ImportSource source = openImportSource(file);
    const PreparedImport prepared = prepareImport(session.bundlePath(), 48'000, source);
    CHECK_FALSE(prepared.originalHash.has_value());
    CHECK(prepared.format == siann::model::MediaFormat::flac);
    CHECK(prepared.mediaFile.extension() == ".flac");
    CHECK(siann::io::readFile(prepared.mediaFile) == flac);
    siann::media::MemoryMediaReader reader(siann::media::decode(flac));
    CHECK(siann::io::readFile(prepared.peaksFile) ==
          siann::media::encodePeaks(siann::media::computePeaks(reader)));
}

TEST_CASE("A failing import leaves no revision and no new file under media/ or peaks/", "[import][job]") {
    TempDir dir;
    Session session = newSession(dir.path() / "Song.siann");
    const fs::path bundle = session.bundlePath();
    const auto before = filesUnder(bundle / "media");
    const auto peaksBefore = filesUnder(bundle / "peaks");

    const fs::path text = dir.path() / "notes.txt";
    siann::io::writeFileAtomic(text, "not audio at all");
    CHECK(importCode(bundle, 48'000, text) == "unsupported_media");

    const std::string wav = siann::io::readFile(writeSine(dir.path() / "whole.wav", 44'100, 4'000));
    const fs::path header = dir.path() / "header.wav";
    siann::io::writeFileAtomic(header, wav.substr(0, 30));
    CHECK(importCode(bundle, 48'000, header) == "decode_failed");
    const fs::path cut = dir.path() / "cut.wav";
    siann::io::writeFileAtomic(cut, wav.substr(0, wav.size() / 2));
    CHECK(importCode(bundle, 48'000, cut) == "decode_failed");

    std::vector<std::int16_t> samples(20'000, 1'000);
    std::string flac = siann::test::encodeFlac16(1, 44'100, samples, 256);
    const fs::path cutFlac = dir.path() / "cut.flac";
    siann::io::writeFileAtomic(cutFlac, flac.substr(0, flac.size() * 2 / 3));
    CHECK(importCode(bundle, 48'000, cutFlac) == "decode_failed");

    CHECK(importCode(bundle, 48'000, dir.path() / "missing.wav") == "not_found");

    CHECK(filesUnder(bundle / "media") == before);
    CHECK(filesUnder(bundle / "peaks") == peaksBefore);
    CHECK(session.lastSeq() == 1);
}

TEST_CASE("Cancelling during conversion stops the import and writes nothing", "[import][job]") {
    TempDir dir;
    Session session = newSession(dir.path() / "Song.siann");
    const fs::path bundle = session.bundlePath();
    auto gate = std::make_shared<siann::test::SourceGate>();
    ImportSource source;
    source.name = "generated.wav";
    source.original = "generated";
    source.originalHash = siann::hash::sha256(source.original);
    source.audio = std::make_unique<siann::test::PacedSource>(AudioInfo{2, 44'100, 200'000}, 50'000, gate);

    ImportProgress progress;
    std::string code;
    std::thread worker([&] {
        try {
            (void)prepareImport(bundle, 48'000, source, &progress);
            code = "no error";
        } catch (const MediaError& error) {
            code = error.code();
        }
    });
    REQUIRE(gate->waitReached());
    CHECK(progress.framesDone.load() > 0);
    CHECK(progress.framesTotal.load() == 200'000);
    progress.cancel = true;
    gate->release();
    worker.join();
    CHECK(code == "cancelled");
    CHECK(filesUnder(bundle / "media").empty());
    CHECK(filesUnder(bundle / "peaks").empty());
    CHECK(session.lastSeq() == 1);
}

TEST_CASE("A file the bundle held before the job is never removed by a failed or cancelled job", "[import][job]") {
    TempDir dir;
    const fs::path file = writeSine(dir.path() / "loop.wav", 48'000, 4'800);
    Session session = newSession(dir.path() / "Song.siann");
    const fs::path bundle = session.bundlePath();
    const std::string bytes = siann::io::readFile(file);
    const fs::path held = mediaPath(bundle, siann::hash::sha256(bytes));
    siann::io::writeFileAtomic(held, bytes);

    // A job that prepared the same content created only the peaks; discarding it
    // removes those and keeps the media file that was there before.
    ImportSource source = openImportSource(file);
    const PreparedImport prepared = prepareImport(bundle, 48'000, source);
    CHECK(prepared.mediaFile == held);
    CHECK(prepared.created == std::vector<fs::path>{prepared.peaksFile});
    discardImport(prepared);
    CHECK(fs::exists(held));
    CHECK_FALSE(fs::exists(prepared.peaksFile));

    // A cancelled job with the same content leaves it too.
    auto gate = std::make_shared<siann::test::SourceGate>();
    ImportSource paced;
    paced.name = "loop.wav";
    paced.original = bytes;
    paced.originalHash = siann::hash::sha256(bytes);
    paced.audio = std::make_unique<siann::test::PacedSource>(AudioInfo{2, 48'000, 4'800}, 0, gate);
    ImportProgress progress;
    progress.cancel = true;
    gate->release();
    CHECK_THROWS_AS(prepareImport(bundle, 48'000, paced, &progress), MediaError);
    CHECK(siann::io::readFile(held) == bytes);
    CHECK(session.lastSeq() == 1);
}

TEST_CASE("The media name is the source's base name, cut to 255 UTF-8 bytes at a code point", "[import][job]") {
    CHECK(mediaNameFromPath(fs::path(u8"/x/y/Kick 01.wav")) == "Kick 01.wav");
    // 100 three-byte code points: 300 bytes, cut to 85 whole ones (255 bytes).
    std::u8string longName;
    for (int i = 0; i < 100; ++i) {
        longName += u8"聲";
    }
    const std::string cut = mediaNameFromPath(fs::path(u8"/x") / fs::path(longName + u8".wav"));
    CHECK(cut.size() == 255);
    CHECK(cut == pathText(fs::path(longName.substr(0, 255))));
    // A four-byte code point straddling byte 255 is dropped whole.
    std::u8string straddle(253, u8'a');
    straddle += u8"\U0001F3B5";
    CHECK(mediaNameFromPath(fs::path(straddle)) == std::string(253, 'a'));
}
