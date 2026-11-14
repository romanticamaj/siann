#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <optional>
#include <random>
#include <set>
#include <string>
#include <vector>

#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/media/wav_stream_writer.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/takes.hpp"

namespace fs = std::filesystem;
using siann::command::Command;
using siann::host::AudioBufferView;
using siann::model::Document;
using siann::session::OpenReport;
using siann::session::Session;
using siann::session::SessionError;
using siann::session::TakeManifest;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-takes-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    fs::path bundle() const { return path_ / "Song.siann"; }

private:
    fs::path path_;
};

Session sessionWithTrack(const fs::path& bundle) {
    Session s = Session::create(bundle, Document::create("Song", 48'000), "test", "t0");
    s.commit({Command::fromJson(siann::json::parse(R"({"op":"track.add","trackId":"trk_vox","name":"Vox","channels":1})"))},
             "test", "t1");
    return s;
}

TakeManifest manifest(const std::string& id) {
    TakeManifest m;
    m.takeId = id;
    m.trackId = "trk_vox";
    m.channels = 1;
    m.sampleRate = 48'000;
    m.recordOffset = 128;
    return m;
}

void writeFrames(siann::media::WavStreamWriter& writer, int frames) {
    std::vector<float> data(static_cast<std::size_t>(frames));
    for (int i = 0; i < frames; ++i) {
        data[static_cast<std::size_t>(i)] = static_cast<float>(i) / 10'000.0f;
    }
    float* p[1] = {data.data()};
    writer.append(AudioBufferView{p, 1, frames}, frames);
}

std::string errorCode(const std::function<void()>& fn) {
    try {
        fn();
    } catch (const SessionError& error) {
        return error.code();
    }
    return "no error";
}

}  // namespace

TEST_CASE("A finished take becomes media and a clip at start minus offset", "[takes]") {
    TempDir dir;
    {
        Session session = sessionWithTrack(dir.bundle());
        const fs::path audio = siann::session::beginTake(session, manifest("take_1"));
        siann::session::markTakeStart(dir.bundle(), "take_1", 10'000);
        {
            siann::media::WavStreamWriter writer(audio, 1, 48'000);
            writeFrames(writer, 4'800);
            writer.close();
        }
        // A pointer: GCC's -Wdangling-reference misfires on a reference returned
        // from a free function called with temporary arguments.
        const auto* revision = &siann::session::commitTake(session, "take_1", "test", "t2");
        const auto* clip = revision->document.clip("clp_take_1");
        REQUIRE(clip != nullptr);
        CHECK(clip->trackId == "trk_vox");
        CHECK(clip->position == siann::time::Position::audio(10'000 - 128));
        CHECK(clip->length == 4'800);
        const auto* media = revision->document.media("med_take_1");
        REQUIRE(media != nullptr);
        CHECK(fs::exists(siann::session::mediaPath(dir.bundle(), media->contentHash)));
        CHECK(siann::session::pendingTakes(dir.bundle()).empty());
    }
    OpenReport report;
    const Session reopened = Session::open(dir.bundle(), &report);
    CHECK(report.pendingTakes.empty());
    CHECK(reopened.history().head().document.clip("clp_take_1") != nullptr);
}

TEST_CASE("A take interrupted by a crash is reported and recovered", "[takes][recovery]") {
    TempDir dir;
    {
        Session session = sessionWithTrack(dir.bundle());
        const fs::path audio = siann::session::beginTake(session, manifest("take_2"));
        siann::session::markTakeStart(dir.bundle(), "take_2", 48'000);
        siann::media::WavStreamWriter writer(audio, 1, 48'000);
        writeFrames(writer, 2'000);
        writer.checkpoint();
        writeFrames(writer, 1'000);
        writer.close();
        // The process died after this point: the header lags and a frame is torn.
        std::string bytes = siann::io::readFile(audio);
        bytes.resize(bytes.size() - 2);
        for (int i = 52; i < 56; ++i) {
            bytes[static_cast<std::size_t>(i)] = 0;
        }
        std::ofstream(audio, std::ios::binary | std::ios::trunc).write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    }
    OpenReport report;
    Session session = Session::open(dir.bundle(), &report);
    REQUIRE(report.pendingTakes == std::vector<std::string>{"take_2"});
    // A pointer: GCC's -Wdangling-reference misfires on a reference returned
    // from a free function called with temporary arguments.
    const auto* revision = &siann::session::commitTake(session, "take_2", "user", "t3");
    const auto* clip = revision->document.clip("clp_take_2");
    REQUIRE(clip != nullptr);
    CHECK(clip->length == 2'999);  // every complete frame, the torn one dropped
    CHECK(clip->position == siann::time::Position::audio(48'000 - 128));
    CHECK(siann::session::pendingTakes(dir.bundle()).empty());
}

TEST_CASE("A take that never captured audio can only be discarded", "[takes][recovery]") {
    TempDir dir;
    {
        Session session = sessionWithTrack(dir.bundle());
        siann::session::beginTake(session, manifest("take_3"));  // crashed before the first frame
    }
    OpenReport report;
    Session session = Session::open(dir.bundle(), &report);
    REQUIRE(report.pendingTakes == std::vector<std::string>{"take_3"});
    CHECK(errorCode([&] { siann::session::commitTake(session, "take_3", "user", "t"); }) == "take_has_no_audio");
    siann::session::discardTake(session, "take_3");
    CHECK(siann::session::pendingTakes(dir.bundle()).empty());
    CHECK(fs::exists(dir.bundle() / "trash" / "take_3.json"));
}

TEST_CASE("A rejected commit leaves the take pending and retryable", "[takes]") {
    TempDir dir;
    Session session = sessionWithTrack(dir.bundle());
    const fs::path audio = siann::session::beginTake(session, manifest("take_4"));
    siann::session::markTakeStart(dir.bundle(), "take_4", 0);
    {
        siann::media::WavStreamWriter writer(audio, 1, 48'000);
        writeFrames(writer, 100);
        writer.close();
    }
    // Remove the track so clip.place fails inside the transaction.
    session.commit({Command::fromJson(siann::json::parse(R"({"op":"track.remove","trackId":"trk_vox"})"))}, "test", "t");
    CHECK_THROWS(siann::session::commitTake(session, "take_4", "test", "t"));
    CHECK(fs::exists(audio));
    CHECK(siann::session::pendingTakes(dir.bundle()).size() == 1);
}

namespace {

// A finished take of `frames` frames on `trackId`, started at `start`.
void recordTake(Session& session, const std::string& takeId, const std::string& trackId, std::int64_t start,
                int frames) {
    TakeManifest m = manifest(takeId);
    m.trackId = trackId;
    const fs::path audio = siann::session::beginTake(session, m);
    siann::session::markTakeStart(session.bundlePath(), takeId, start);
    siann::media::WavStreamWriter writer(audio, 1, 48'000);
    writeFrames(writer, frames);
    writer.close();
}

std::set<fs::path> filesUnder(const fs::path& dir) {
    std::set<fs::path> out;
    for (const auto& entry : fs::recursive_directory_iterator(dir)) {
        if (entry.is_regular_file()) {
            out.insert(entry.path());
        }
    }
    return out;
}

void addGuitar(Session& session) {
    session.commit(
        {Command::fromJson(siann::json::parse(R"({"op":"track.add","trackId":"trk_gtr","name":"Gtr","channels":1})"))},
        "test", "t");
}

}  // namespace

// m5b-engine-record: one recording of N armed tracks commits one revision.
TEST_CASE("commitTakes commits every take of a recording as one revision, and undo keeps the files",
          "[takes][commit-takes]") {
    TempDir dir;
    Session session = sessionWithTrack(dir.bundle());
    addGuitar(session);
    recordTake(session, "take_a", "trk_vox", 10'000, 4'800);
    recordTake(session, "take_b", "trk_gtr", 10'000, 4'800 + 7);
    const std::size_t before = session.history().revisions().size();
    const std::string parent = session.history().head().envelope.id;

    const auto* revision = &siann::session::commitTakes(session, {"take_a", "take_b"}, "test", "t2");
    CHECK(session.history().revisions().size() == before + 1);
    CHECK(revision->envelope.parents == std::vector<std::string>{parent});
    const auto& doc = revision->document;
    REQUIRE(doc.clip("clp_take_a") != nullptr);
    REQUIRE(doc.clip("clp_take_b") != nullptr);
    CHECK(doc.clip("clp_take_a")->trackId == "trk_vox");
    CHECK(doc.clip("clp_take_b")->trackId == "trk_gtr");
    CHECK(doc.clip("clp_take_b")->length == 4'807);
    CHECK(doc.clip("clp_take_a")->position == siann::time::Position::audio(10'000 - 128));
    REQUIRE(doc.media("med_take_a") != nullptr);
    REQUIRE(doc.media("med_take_b") != nullptr);
    CHECK(siann::session::pendingTakes(dir.bundle()).empty());

    const std::set<fs::path> files = filesUnder(dir.bundle() / "media");
    session.undo("test", "t3");
    const auto& undone = session.history().head().document;
    CHECK(undone.clip("clp_take_a") == nullptr);
    CHECK(undone.clip("clp_take_b") == nullptr);
    CHECK(undone.media("med_take_a") == nullptr);
    CHECK(undone.media("med_take_b") == nullptr);
    for (const fs::path& file : files) {
        INFO(file.string());
        CHECK(fs::exists(file));  // undo deletes no file
    }
}

TEST_CASE("A failed commitTakes moves every file back and leaves every take pending", "[takes][commit-takes]") {
    TempDir dir;
    Session session = sessionWithTrack(dir.bundle());
    addGuitar(session);
    recordTake(session, "take_c", "trk_vox", 0, 100);
    recordTake(session, "take_d", "trk_gtr", 0, 200);
    session.commit({Command::fromJson(siann::json::parse(R"({"op":"track.remove","trackId":"trk_gtr"})"))}, "test",
                   "t");
    const std::size_t before = session.history().revisions().size();
    CHECK_THROWS(siann::session::commitTakes(session, {"take_c", "take_d"}, "test", "t"));
    CHECK(session.history().revisions().size() == before);
    CHECK(siann::session::pendingTakes(dir.bundle()).size() == 2);
    CHECK(fs::exists(siann::session::takeAudioPath(dir.bundle(), "take_c")));
    CHECK(fs::exists(siann::session::takeAudioPath(dir.bundle(), "take_d")));
    CHECK(errorCode([&] { siann::session::commitTakes(session, {}, "test", "t"); }) == "invalid_take");
}

TEST_CASE("A take manifest keeps endedBy and overflows, and an older one still reads", "[takes][ended-by]") {
    TempDir dir;
    Session session = sessionWithTrack(dir.bundle());
    recordTake(session, "take_e", "trk_vox", 0, 100);
    siann::session::markTakeEnd(dir.bundle(), "take_e", "overflow", 12);
    const TakeManifest read = siann::session::readTakeManifest(siann::session::takeManifestPath(dir.bundle(), "take_e"));
    CHECK(read.endedBy == std::optional<std::string>("overflow"));
    CHECK(read.overflows == std::optional<std::uint64_t>(12));
    CHECK(read.startPosition == std::optional<std::int64_t>(0));

    // A manifest written before M5b (no endedBy, no overflows).
    const std::string old =
        R"({"channels":1,"recordOffset":"128","sampleRate":48000,"schema":"siann.take_manifest.v1",)"
        R"("startPosition":"480","takeId":"take_f","trackId":"trk_vox"})";
    siann::io::writeFileAtomic(siann::session::takeManifestPath(dir.bundle(), "take_f"), old + "\n");
    const TakeManifest older = siann::session::readTakeManifest(siann::session::takeManifestPath(dir.bundle(), "take_f"));
    CHECK_FALSE(older.endedBy.has_value());
    CHECK_FALSE(older.overflows.has_value());
    CHECK(older.startPosition == std::optional<std::int64_t>(480));

    const std::vector<TakeManifest> pending = siann::session::pendingTakes(dir.bundle());
    REQUIRE(pending.size() == 2);
    CHECK(pending[0].takeId == "take_e");
    CHECK(pending[0].endedBy == std::optional<std::string>("overflow"));
    CHECK(pending[0].overflows == std::optional<std::uint64_t>(12));
    CHECK_FALSE(pending[1].endedBy.has_value());
}

TEST_CASE("discardTake and commitTake are idempotent", "[takes][idempotent]") {
    TempDir dir;
    Session session = sessionWithTrack(dir.bundle());
    recordTake(session, "take_g", "trk_vox", 0, 100);
    recordTake(session, "take_h", "trk_vox", 0, 100);

    const std::string first = siann::session::commitTake(session, "take_g", "test", "t").envelope.id;
    const std::size_t revisions = session.history().revisions().size();
    const std::string again = siann::session::commitTake(session, "take_g", "test", "t").envelope.id;
    CHECK(again == first);
    CHECK(session.history().revisions().size() == revisions);

    siann::session::discardTake(session, "take_h");
    CHECK_NOTHROW(siann::session::discardTake(session, "take_h"));
    CHECK(fs::exists(dir.bundle() / "trash" / "take_h.wav"));
    CHECK(fs::exists(dir.bundle() / "trash" / "take_h.json"));
    CHECK(siann::session::pendingTakes(dir.bundle()).empty());
    CHECK(errorCode([&] { siann::session::commitTake(session, "take_h", "t", "t"); }) == "take_not_found");
    CHECK(errorCode([&] { siann::session::discardTake(session, "take_zz"); }) == "take_not_found");
}

// m5b-engine-record: track.set_input through the session is one revision, and
// undo restores the track as it was.
TEST_CASE("track.set_input commits one revision and undo restores the track", "[takes][input]") {
    TempDir dir;
    Session session = sessionWithTrack(dir.bundle());
    const auto hashBefore = session.history().head().envelope.documentHash;
    const std::size_t before = session.history().revisions().size();
    session.commit({Command::fromJson(siann::json::parse(
                       R"({"op":"track.set_input","trackId":"trk_vox","input":{"port":1,"channels":1}})"))},
                   "test", "t");
    CHECK(session.history().revisions().size() == before + 1);
    REQUIRE(session.history().head().document.track("trk_vox")->input.has_value());
    session.undo("test", "t");
    CHECK_FALSE(session.history().head().document.track("trk_vox")->input.has_value());
    CHECK(session.history().head().envelope.documentHash == hashBefore);
}

TEST_CASE("Takes are validated against the session", "[takes]") {
    TempDir dir;
    Session session = sessionWithTrack(dir.bundle());
    TakeManifest bad = manifest("take_5");
    bad.trackId = "trk_missing";
    CHECK(errorCode([&] { siann::session::beginTake(session, bad); }) == "invalid_take");
    bad = manifest("take 5");
    CHECK(errorCode([&] { siann::session::beginTake(session, bad); }) == "invalid_take");
    bad = manifest("take_5");
    bad.sampleRate = 44'100;
    CHECK(errorCode([&] { siann::session::beginTake(session, bad); }) == "invalid_take");
    siann::session::beginTake(session, manifest("take_5"));
    CHECK(errorCode([&] { siann::session::beginTake(session, manifest("take_5")); }) == "invalid_take");
    CHECK(errorCode([&] { siann::session::commitTake(session, "take_9", "t", "t"); }) == "take_not_found");
}

// m5b-engine-record: a take whose track is gone (removed while it was recorded
// on a path that did not refuse it) stays pending; its recovery places it on
// another track or on a new one, or trashes it.
TEST_CASE("An orphan take is recovered onto another track or a new one", "[takes][orphan]") {
    TempDir dir;
    Session session = sessionWithTrack(dir.bundle());
    addGuitar(session);
    recordTake(session, "take_o1", "trk_vox", 1'000, 300);
    recordTake(session, "take_o2", "trk_vox", 2'000, 400);
    recordTake(session, "take_o3", "trk_vox", 3'000, 500);
    session.commit({Command::fromJson(siann::json::parse(R"({"op":"track.remove","trackId":"trk_vox"})"))}, "test",
                   "t");
    // Its own track is gone: a plain commit fails and leaves it pending.
    CHECK_THROWS(siann::session::commitTake(session, "take_o1", "test", "t"));
    CHECK(siann::session::pendingTakes(dir.bundle()).size() == 3);

    // Onto another existing track.
    siann::session::TakePlacement other;
    other.trackId = "trk_gtr";
    const auto* onGuitar = &siann::session::commitTake(session, "take_o1", "test", "t", other);
    REQUIRE(onGuitar->document.clip("clp_take_o1") != nullptr);
    CHECK(onGuitar->document.clip("clp_take_o1")->trackId == "trk_gtr");
    CHECK(onGuitar->document.clip("clp_take_o1")->position == siann::time::Position::audio(1'000 - 128));

    // Onto a new track, added in the same revision with the take's channels.
    siann::session::TakePlacement fresh;
    fresh.newTrack = true;
    const std::size_t before = session.history().revisions().size();
    const auto* onNew = &siann::session::commitTake(session, "take_o2", "test", "t", fresh);
    CHECK(session.history().revisions().size() == before + 1);
    const auto* track = onNew->document.track("trk_take_o2");
    REQUIRE(track != nullptr);
    CHECK(track->channels == 1);
    CHECK(onNew->document.clip("clp_take_o2")->trackId == "trk_take_o2");
    CHECK(onNew->document.root().trackOrder.back() == "trk_take_o2");
    // A repeat answers the revision that committed it, wherever it went.
    CHECK(&siann::session::commitTake(session, "take_o2", "test", "t", fresh) == onNew);
    session.undo("test", "t");  // the take and its new track go together
    CHECK(session.history().head().document.track("trk_take_o2") == nullptr);

    // A named track that does not exist is not_found and leaves it pending.
    siann::session::TakePlacement missing;
    missing.trackId = "trk_none";
    CHECK(errorCode([&] { siann::session::commitTake(session, "take_o3", "test", "t", missing); }) == "not_found");
    siann::session::TakePlacement both;
    both.trackId = "trk_gtr";
    both.newTrack = true;
    CHECK(errorCode([&] { siann::session::commitTake(session, "take_o3", "test", "t", both); }) == "invalid_take");
    CHECK(siann::session::pendingTakes(dir.bundle()).size() == 1);
    siann::session::discardTake(session, "take_o3");
    CHECK(siann::session::pendingTakes(dir.bundle()).empty());
}
