// Jobs v0 (spec, "Commands and jobs", Jobs v0): render.start and job.status.
// The expected audio comes from engine::renderOffline of the same document,
// not from the job. Completion is awaited by runJobs() on the test thread
// (no worker) or on the job's condition (worker), never by sleeping.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <filesystem>
#include <string>
#include <vector>

#include "live_rig.hpp"
#include "siann/engine/offline.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using protocol::ConnectionId;
using protocol::ServerOptions;
using protocol::testing::at;
using protocol::testing::canonical;
using protocol::testing::errorCode;
using protocol::testing::Harness;
using protocol::testing::manualOptions;
using json::Array;
using json::Object;
using json::Value;

namespace {

ServerOptions withoutWorker() {
    ServerOptions options = manualOptions();
    options.jobs.workerThread = false;
    return options;
}

Value job(const std::string& id) {
    return Value(Object{{"jobId", Value(id)}});
}

Value render(const std::string& name) {
    return Value(Object{{"name", Value(name)}});
}

// The session with media of the playback rig (two tracks, two WAV files).
struct Rig {
    explicit Rig(ServerOptions options = withoutWorker()) : harness(media.session, std::move(options)) {}
    live_rig::Fixture media;
    Harness harness;
};

}  // namespace

TEST_CASE("render.start writes renders/<name>.wav equal to the offline render, job.status walks to done",
          "[protocol][jobs]") {
    Rig rig;
    const ConnectionId c = rig.harness.authed();
    const model::Document document = rig.media.doc();
    const media::AudioBuffer expected = engine::renderOffline(document, engine::loadMedia(document, rig.media.bundle()));

    const Value started = rig.harness.ok(c, "render.start", render("mix"));
    CHECK(at(started, "kind").asString() == "render");
    CHECK(at(started, "state").asString() == "queued");
    const std::string jobId = at(started, "jobId").asString();
    CHECK(jobId == "job_1");
    // A commit after the start does not change what the job renders.
    rig.harness.commit(c, Array{protocol::testing::trackAdd("trk_late")});

    CHECK(at(rig.harness.ok(c, "job.status", job(jobId)), "state").asString() == "queued");
    CHECK(rig.harness.server.runJobs() == 1);

    const Value status = rig.harness.ok(c, "job.status", job(jobId));
    INFO(canonical(status));
    CHECK(at(status, "jobId").asString() == jobId);
    CHECK(at(status, "kind").asString() == "render");
    CHECK(at(status, "state").asString() == "done");
    const Value& result = at(status, "result");
    const std::filesystem::path file = rig.media.bundle() / "renders" / "mix.wav";
    CHECK(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(at(result, "path").asString().c_str()))) ==
          file);
    const std::string bytes = io::readFile(file);
    const media::AudioBuffer decoded = media::decodeWav(bytes);
    CHECK(decoded.info.channels == expected.info.channels);
    CHECK(decoded.info.sampleRate == expected.info.sampleRate);
    CHECK(decoded.samples == expected.samples);
    CHECK(at(result, "frames").asString() == std::to_string(expected.info.frames));
    CHECK(at(result, "sampleRate").asNumber() == 48'000);
    CHECK(at(result, "channels").asNumber() == 2);
    CHECK(at(result, "contentHash").asString() == hash::formatHash(hash::sha256(bytes)));
    CHECK(status.find("error") == nullptr);
    // Nothing in the document changed and no command was journaled for the render.
    CHECK(rig.media.session.history().revisions().back().envelope.cause == command::Cause::command);
}

TEST_CASE("render.start honours start and frames", "[protocol][jobs]") {
    Rig rig;
    const ConnectionId c = rig.harness.authed();
    const model::Document document = rig.media.doc();
    const media::AudioBuffer expected = engine::renderOffline(
        document, engine::loadMedia(document, rig.media.bundle()), engine::RenderOptions{1'000, 4'800, 512});

    const std::string jobId = at(rig.harness.ok(c, "render.start",
                                                Value(Object{{"name", Value("part")},
                                                             {"start", Value("1000")},
                                                             {"frames", Value("4800")}})),
                                 "jobId")
                                  .asString();
    rig.harness.server.runJobs();
    const Value status = rig.harness.ok(c, "job.status", job(jobId));
    CHECK(at(at(status, "result"), "frames").asString() == "4800");
    const media::AudioBuffer decoded = media::decodeWav(io::readFile(rig.media.bundle() / "renders" / "part.wav"));
    CHECK(decoded.samples == expected.samples);

    CHECK(errorCode(rig.harness.call(c, "render.start",
                                     Value(Object{{"name", Value("x")}, {"frames", Value(12)}}))) == "invalid_params");
}

TEST_CASE("the job worker runs a render and the job's condition reports it", "[protocol][jobs]") {
    ServerOptions options = manualOptions();
    options.jobs.workerThread = true;
    Rig rig(options);
    const ConnectionId c = rig.harness.authed();
    const std::string jobId = at(rig.harness.ok(c, "render.start", render("mix")), "jobId").asString();
    REQUIRE(rig.harness.server.waitJob(jobId, std::chrono::seconds(30)));
    CHECK(at(rig.harness.ok(c, "job.status", job(jobId)), "state").asString() == "done");
    CHECK(std::filesystem::exists(rig.media.bundle() / "renders" / "mix.wav"));
    CHECK_FALSE(rig.harness.server.waitJob("job_99", std::chrono::milliseconds(1)));
}

TEST_CASE("a render whose media is missing ends failed with the EngineError code", "[protocol][jobs]") {
    protocol::testing::Fixture f(withoutWorker());
    const ConnectionId c = f.authed();
    // media.add with a content hash no file in the bundle has.
    f.commit(c, Array{protocol::testing::trackAdd("trk_a"), protocol::testing::mediaAdd("med_x"),
                      protocol::testing::clipPlace("clp_a", "trk_a", "med_x", 0)});
    const std::string jobId = at(f.ok(c, "render.start", render("mix")), "jobId").asString();
    f.server.runJobs();
    const Value status = f.ok(c, "job.status", job(jobId));
    CHECK(at(status, "state").asString() == "failed");
    CHECK(at(at(status, "error"), "code").asString() == "media_missing");
    CHECK(status.find("result") == nullptr);
    CHECK_FALSE(std::filesystem::exists(f.dir.bundle() / "renders" / "mix.wav"));
}

TEST_CASE("render names cannot be paths and unknown jobs are not_found", "[protocol][jobs]") {
    protocol::testing::Fixture f(withoutWorker());
    const ConnectionId c = f.authed();
    const std::vector<std::string> names = {"a/b", "..\\x", "..", ".", "", std::string(65, 'a'), "caf\xc3\xa9",
                                            "C:mix"};
    for (const std::string& name : names) {
        INFO(name);
        CHECK(errorCode(f.call(c, "render.start", render(name))) == "invalid_params");
    }
    CHECK(errorCode(f.call(c, "render.start", Value(Object{}))) == "invalid_params");
    CHECK(errorCode(f.call(c, "job.status", job("job_1"))) == "not_found");
    CHECK(errorCode(f.call(c, "job.status", Value(Object{}))) == "invalid_params");
    CHECK(f.server.runJobs() == 0);
}
