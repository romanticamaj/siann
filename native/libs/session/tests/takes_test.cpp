#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <random>
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
