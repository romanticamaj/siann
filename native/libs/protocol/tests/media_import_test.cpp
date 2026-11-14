// media.import as a job (m5b-engine-project-media; architecture spec, "Commands
// and jobs", Jobs v0, import; docs/schemas/protocol-engine-v0.md). The worker
// decodes, converts and writes; the command thread commits media.add and only then
// is the job done.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cmath>
#include <filesystem>
#include <memory>
#include <numbers>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "support/paced_source.hpp"
#include "support/flac_test_encoder.hpp"
#include "support/protocol_fixture.hpp"
#include "support/rate_port.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/session/media_import.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::ServerOptions;

namespace fs = std::filesystem;

namespace {

std::string utf8(const fs::path& path) {
    const std::u8string text = path.u8string();
    return std::string(text.begin(), text.end());
}

fs::path writeSine(const fs::path& file, std::int32_t channels, std::int64_t rate, std::int64_t frames) {
    media::AudioBuffer buffer;
    buffer.info = media::AudioInfo{channels, rate, frames};
    for (std::int64_t i = 0; i < frames; ++i) {
        for (std::int32_t c = 0; c < channels; ++c) {
            buffer.samples.push_back(static_cast<float>(
                0.25 * std::sin(2.0 * std::numbers::pi * 440.0 * static_cast<double>(i) / static_cast<double>(rate))));
        }
    }
    io::writeFileAtomic(file, media::encodeWavFloat32(buffer));
    return file;
}

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

Value importParams(const fs::path& path, const std::string& clientImportId) {
    return Value(Object{{"path", Value(utf8(path))}, {"clientImportId", Value(clientImportId)}});
}

ServerOptions manualJobs() {
    ServerOptions options = manualOptions();
    options.jobs.workerThread = false;
    return options;
}

Value statusOf(Fixture& f, ConnectionId c, const std::string& jobId) {
    return f.ok(c, "job.status", Value(Object{{"jobId", Value(jobId)}}));
}

// Runs the queued jobs on this thread, then lets the command thread commit.
Value finish(Fixture& f, ConnectionId c, const std::string& jobId) {
    f.server.runJobs();
    f.server.pump();
    return statusOf(f, c, jobId);
}

// An import source whose decoder is a paced generator (support/paced_source.hpp).
session::ImportSource pacedSource(media::AudioInfo info, std::int64_t holdAt, std::shared_ptr<test::SourceGate> gate) {
    session::ImportSource source;
    source.name = "generated.wav";
    source.original = "generated " + std::to_string(info.frames);
    source.originalHash = hash::sha256(source.original);
    source.format = model::MediaFormat::wav;
    source.audio = std::make_unique<test::PacedSource>(info, holdAt, std::move(gate));
    return source;
}

}  // namespace

TEST_CASE("media.import queues a job that converts, writes and commits one media.add", "[protocol][media]") {
    Fixture f(manualJobs());
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    const fs::path file = writeSine(f.dir.bundle().parent_path() / "Loop 44.wav", 2, 44'100, 44'100);

    const Value queued = f.ok(c, "media.import", importParams(file, "imp-1"));
    const std::string jobId = at(queued, "jobId").asString();
    CHECK(jobId.rfind("job_", 0) == 0);
    CHECK(at(queued, "kind").asString() == "media.import");
    CHECK(at(queued, "state").asString() == "queued");
    CHECK(at(statusOf(f, c, jobId), "state").asString() == "queued");

    // The worker's part is done; the job is not until the command thread committed.
    REQUIRE(f.server.runJobs() == 1);
    const std::optional<Value> beforeCommit = f.server.jobStatus(jobId);
    REQUIRE(beforeCommit.has_value());
    CHECK(at(*beforeCommit, "state").asString() == "running");
    CHECK(f.head().envelope.id == "r1");
    f.server.pump();

    const Value done = statusOf(f, c, jobId);
    INFO(canonical(done));
    REQUIRE(at(done, "state").asString() == "done");
    const Value& result = at(done, "result");
    const std::string original = io::readFile(file);
    const std::string stored = media::encodeWavFloat32(media::resample(media::decode(original), 48'000));
    CHECK(at(result, "mediaId").asString() == "med_1");
    CHECK(at(result, "revision").asString() == "r2");
    CHECK(at(result, "contentHash").asString() == hash::formatHash(hash::sha256(stored)));
    CHECK(at(result, "originalHash").asString() == hash::formatHash(hash::sha256(original)));
    CHECK(at(result, "converted").asBool());
    CHECK(at(result, "name").asString() == "Loop 44.wav");
    CHECK(at(result, "frames").asString() == "48000");
    CHECK(at(result, "sampleRate").asNumber() == 48'000);
    CHECK(at(result, "channels").asNumber() == 2);
    CHECK(result.find("existing") == nullptr);

    // Exactly one new revision, whose only command is media.add.
    CHECK(f.session.history().revisions().size() == 2);
    REQUIRE(f.head().commands.size() == 1);
    CHECK(f.head().commands[0].op() == "media.add");
    const model::Media* added = f.head().document.media("med_1");
    REQUIRE(added != nullptr);
    CHECK(*added->name == "Loop 44.wav");
    CHECK(fs::exists(session::mediaPath(f.dir.bundle(), added->contentHash)));
    CHECK(fs::exists(f.dir.bundle() / "peaks" / (hash::toHex(added->contentHash) + ".peaks")));

    bool changed = false;
    for (const Value& event : f.events(watcher)) {
        if (at(event, "type").asString() == "session.changed") {
            changed = changed || at(event, "revision").asString() == "r2";
        }
    }
    CHECK(changed);
}

TEST_CASE("A file at the session rate is imported as is, without originalHash", "[protocol][media]") {
    Fixture f(manualJobs());
    const ConnectionId c = f.authed();
    const fs::path file = writeSine(f.dir.bundle().parent_path() / "kick.wav", 1, 48'000, 4'800);
    const std::string jobId = at(f.ok(c, "media.import", importParams(file, "imp-1")), "jobId").asString();
    const Value done = finish(f, c, jobId);
    REQUIRE(at(done, "state").asString() == "done");
    const Value& result = at(done, "result");
    CHECK_FALSE(at(result, "converted").asBool());
    CHECK(result.find("originalHash") == nullptr);
    CHECK(at(result, "contentHash").asString() == hash::formatHash(hash::sha256(io::readFile(file))));
}

TEST_CASE("A failed import ends failed, commits nothing and leaves no file under media/", "[protocol][media]") {
    Fixture f(manualJobs());
    const ConnectionId c = f.authed();
    const fs::path dir = f.dir.bundle().parent_path();
    const fs::path text = dir / "notes.txt";
    io::writeFileAtomic(text, "not audio at all");
    const std::string wav = io::readFile(writeSine(dir / "whole.wav", 2, 44'100, 8'000));
    const fs::path cut = dir / "cut.wav";
    io::writeFileAtomic(cut, wav.substr(0, 30));
    std::vector<std::int16_t> samples(30'000, 1'000);
    const std::string flac = test::encodeFlac16(1, 44'100, samples, 256);
    const fs::path cutFlac = dir / "cut.flac";
    io::writeFileAtomic(cutFlac, flac.substr(0, flac.size() / 2));

    int n = 0;
    for (const auto& [path, code] : std::vector<std::pair<fs::path, std::string>>{{text, "unsupported_media"},
                                                                                 {cut, "decode_failed"},
                                                                                 {cutFlac, "decode_failed"},
                                                                                 {dir / "missing.wav", "not_found"}}) {
        INFO(utf8(path));
        const std::string jobId =
            at(f.ok(c, "media.import", importParams(path, "imp-" + std::to_string(++n))), "jobId").asString();
        const Value status = finish(f, c, jobId);
        CHECK(at(status, "state").asString() == "failed");
        CHECK(at(at(status, "error"), "code").asString() == code);
        CHECK(f.head().envelope.id == "r1");
        CHECK(filesUnder(f.dir.bundle() / "media").empty());
        CHECK(filesUnder(f.dir.bundle() / "peaks").empty());
    }
}

TEST_CASE("media.import refuses a relative or UNC path and a missing clientImportId with no job",
          "[protocol][media]") {
    Fixture f(manualJobs());
    const ConnectionId c = f.authed();
    const fs::path file = writeSine(f.dir.bundle().parent_path() / "ok.wav", 1, 48'000, 480);
    const std::vector<Value> refused = {
        importParams(fs::path("relative") / "ok.wav", "imp-1"),
        Value(Object{{"path", Value("\\\\server\\share\\ok.wav")}, {"clientImportId", Value("imp-2")}}),
        Value(Object{{"path", Value("\\\\?\\UNC\\server\\share\\ok.wav")}, {"clientImportId", Value("imp-3")}}),
        Value(Object{{"path", Value("//server/share/ok.wav")}, {"clientImportId", Value("imp-4")}}),
        Value(Object{{"path", Value(utf8(file))}}),
        Value(Object{{"path", Value(utf8(file))}, {"clientImportId", Value(7)}}),
        Value(Object{{"path", Value(utf8(file))}, {"clientImportId", Value("")}}),
        Value(Object{{"clientImportId", Value("imp-5")}}),
    };
    for (const Value& params : refused) {
        INFO(canonical(params));
        CHECK(errorCode(f.call(c, "media.import", params)) == "invalid_params");
    }
    CHECK(f.server.runJobs() == 0);
    // The first job the server makes is still job_1... after the refusals nothing was queued.
    const std::string jobId = at(f.ok(c, "media.import", importParams(file, "imp-ok")), "jobId").asString();
    CHECK(f.server.runJobs() == 1);
    f.server.pump();
    CHECK(at(statusOf(f, c, jobId), "state").asString() == "done");
}

TEST_CASE("A repeated clientImportId answers the first job; known content answers the existing media",
          "[protocol][media]") {
    Fixture f(manualJobs());
    const ConnectionId c = f.authed();
    const fs::path file = writeSine(f.dir.bundle().parent_path() / "loop.wav", 2, 44'100, 4'410);
    const Value first = f.ok(c, "media.import", importParams(file, "imp-a"));
    const std::string jobId = at(first, "jobId").asString();
    const Value again = f.ok(c, "media.import", importParams(file, "imp-a"));  // a new requestId
    CHECK(at(again, "jobId").asString() == jobId);
    CHECK(at(again, "kind").asString() == "media.import");
    CHECK(f.server.runJobs() == 1);
    f.server.pump();
    CHECK(at(statusOf(f, c, jobId), "state").asString() == "done");
    const Value late = f.ok(c, "media.import", importParams(file, "imp-a"));
    CHECK(at(late, "jobId").asString() == jobId);
    CHECK(at(late, "state").asString() == "done");
    CHECK(f.server.runJobs() == 0);
    REQUIRE(f.head().envelope.id == "r2");

    // The same content under a new clientImportId: the existing media, no revision.
    const std::string second = at(f.ok(c, "media.import", importParams(file, "imp-b")), "jobId").asString();
    CHECK(second != jobId);
    const Value done = finish(f, c, second);
    REQUIRE(at(done, "state").asString() == "done");
    const Value& result = at(done, "result");
    CHECK(at(result, "mediaId").asString() == "med_1");
    CHECK(at(result, "existing").asBool());
    CHECK(at(result, "revision").asString() == "r2");
    CHECK(f.session.history().revisions().size() == 2);
    CHECK(filesUnder(f.dir.bundle() / "media").size() == 1);
}

TEST_CASE("Media ids are above every med_<n> any revision held", "[protocol][media]") {
    Fixture f(manualJobs());
    const ConnectionId c = f.authed();
    f.commit(c, Array{mediaAdd("med_7")});
    f.commit(c, Array{Value(Object{{"op", Value("media.remove")}, {"mediaId", Value("med_7")}})});
    const fs::path file = writeSine(f.dir.bundle().parent_path() / "a.wav", 1, 48'000, 480);
    const std::string jobId = at(f.ok(c, "media.import", importParams(file, "imp-1")), "jobId").asString();
    CHECK(at(at(finish(f, c, jobId), "result"), "mediaId").asString() == "med_8");
}

TEST_CASE("session.open cancels an import during conversion; neither session gets a revision",
          "[protocol][media][cancel]") {
    auto gate = std::make_shared<test::SourceGate>();
    std::optional<session::Session> opened;
    ServerOptions options = manualOptions();  // the jobs worker thread runs the import
    options.openImportSource = [&](const fs::path&) {
        return pacedSource(media::AudioInfo{2, 44'100, 200'000}, 50'000, gate);
    };
    options.openSession = [&](const fs::path& path) -> session::Session& {
        opened.emplace(session::Session::open(path));
        return *opened;
    };
    Fixture f(std::move(options));
    const fs::path other = f.dir.bundle().parent_path() / "Other.siann";
    {
        session::Session created = session::Session::create(other, model::Document::create("Other", 48'000),
                                                            "tester", "2026-11-14T00:00:00Z");
    }
    const ConnectionId c = f.authed();
    const std::string jobId =
        at(f.ok(c, "media.import", importParams(f.dir.bundle().parent_path() / "any.wav", "imp-1")), "jobId")
            .asString();
    REQUIRE(gate->waitReached());
    const Value running = statusOf(f, c, jobId);
    CHECK(at(running, "state").asString() == "running");
    CHECK(at(at(running, "progress"), "framesTotal").asString() == "200000");

    f.ok(c, "session.open", Value(Object{{"path", Value(utf8(other))}}));
    CHECK(gate->wasInterrupted());
    REQUIRE(f.server.waitJob(jobId, std::chrono::milliseconds(60'000)));
    f.server.pump();
    const std::optional<Value> status = f.server.jobStatus(jobId);
    REQUIRE(status.has_value());
    CHECK(at(*status, "state").asString() == "failed");
    CHECK(at(at(*status, "error"), "code").asString() == "cancelled");
    CHECK(f.session.history().revisions().size() == 1);
    REQUIRE(opened.has_value());
    CHECK(opened->history().revisions().size() == 1);
    CHECK(filesUnder(f.dir.bundle() / "media").empty());
    CHECK(filesUnder(other / "media").empty());
}

TEST_CASE("Stopping the server cancels a running import", "[protocol][media][cancel]") {
    auto gate = std::make_shared<test::SourceGate>();
    ServerOptions options = manualOptions();
    options.openImportSource = [&](const fs::path&) {
        return pacedSource(media::AudioInfo{1, 44'100, 100'000}, 20'000, gate);
    };
    Fixture f(std::move(options));
    const ConnectionId c = f.authed();
    const std::string jobId =
        at(f.ok(c, "media.import", importParams(f.dir.bundle().parent_path() / "any.wav", "imp-1")), "jobId")
            .asString();
    REQUIRE(gate->waitReached());
    f.server.stop();  // joins the worker: the interrupted source returns, the job ends
    const std::optional<Value> status = f.server.jobStatus(jobId);
    REQUIRE(status.has_value());
    CHECK(at(*status, "state").asString() == "failed");
    CHECK(at(at(*status, "error"), "code").asString() == "cancelled");
    CHECK(f.session.history().revisions().size() == 1);
    CHECK(filesUnder(f.dir.bundle() / "media").empty());
}

// The import never holds the command thread: transport.play is answered while ten
// minutes of stereo at 44.1 kHz convert (a generator, no large file on disk). The
// pump thread serves the requests; nothing sleeps.
TEST_CASE("transport.play is answered while a ten-minute file converts", "[protocol][media][threads]") {
    auto gate = std::make_shared<test::SourceGate>();
    constexpr std::int64_t kFrames = 44'100LL * 600;
    RatePort port(48'000);
    ServerOptions options = manualOptions();
    options.pumpThread = true;
    options.transportPort = &port;
    options.openImportSource = [&](const fs::path&) {
        return pacedSource(media::AudioInfo{2, 44'100, kFrames}, kFrames / 3, gate);
    };
    Fixture f(std::move(options));
    const ConnectionId c = f.authed();
    int next = 0;
    const auto send = [&](const std::string& method, Value params) {
        const std::string id = "threaded_" + std::to_string(++next);
        const std::size_t before = f.transport.sent(c).size();
        f.transport.deliver(c, f.request(id, method, std::move(params)));
        REQUIRE(f.transport.waitSent(c, before + 1, std::chrono::milliseconds(60'000)));
        const Value response = json::parse(f.transport.sent(c).back());
        INFO(canonical(response));
        REQUIRE(at(response, "requestId").asString() == id);
        REQUIRE(at(response, "ok").asBool());
        return at(response, "result");
    };

    const std::string jobId =
        at(send("media.import", importParams(f.dir.bundle().parent_path() / "ten-minutes.wav", "imp-1")), "jobId")
            .asString();
    REQUIRE(gate->waitReached());
    const Value played = send("transport.play", Value(Object{}));
    CHECK(at(played, "playing").asBool());
    CHECK(port.plays.load() == 1);
    const Value running = send("job.status", Value(Object{{"jobId", Value(jobId)}}));
    CHECK(at(running, "state").asString() == "running");
    CHECK(at(at(running, "progress"), "framesTotal").asString() == std::to_string(kFrames));

    gate->release();
    REQUIRE(f.server.waitJob(jobId, std::chrono::milliseconds(600'000)));
    const Value done = send("job.status", Value(Object{{"jobId", Value(jobId)}}));
    INFO(canonical(done));
    REQUIRE(at(done, "state").asString() == "done");
    CHECK(at(at(done, "result"), "frames").asString() == std::to_string(48'000LL * 600));
    f.server.stop();  // the pump thread is gone: the session can be read here
    CHECK(f.session.history().revisions().size() == 2);
}
