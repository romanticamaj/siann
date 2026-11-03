// Long recording tests (architecture spec, "Recording", M2 exit criterion
// "record 10 minutes and recover after a kill"). Tagged [.][long]: hidden, so
// the default ctest run leaves them out; the long-tests workflow runs
// `siann_cli_tests "[long]"`. The fake device runs 4 times faster than real
// time, so each case takes about 2.5 minutes for 10 minutes of device time.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>

#include "siann/hash/jcs.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/session/session.hpp"
#include "siann/session/takes.hpp"
#include "support/child_process.hpp"
#include "support/cli_support.hpp"

#ifndef SIANN_CLI_EXE
#define SIANN_CLI_EXE "siann-cli"  // set by CMake; the fallback keeps a plain syntax check building
#endif

using namespace siann::cli::test;
namespace fs = std::filesystem;

namespace {

constexpr std::int64_t kRate = 48'000;
constexpr std::int64_t kSeconds = 600;
constexpr std::int64_t kTakeFrames = kSeconds * kRate;  // 28,800,000
// A hung child is caught by this guard, not by the test's synchronization:
// 600 s of device time at 4x is 150 s of wall time.
constexpr auto kGuard = std::chrono::seconds(1'800);

std::vector<std::string> recordArgs(const std::string& bundle, const std::string& takeId) {
    return {"record", bundle, "--track", "t1", "--device", "fake", "--fake-speed", "4", "--fake-input", "counter",
            "--seconds", std::to_string(kSeconds), "--take-id", takeId};
}

}  // namespace

TEST_CASE("A 10-minute take records every frame of the counter and commits", "[.][long][cli][record]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    const fs::path bundlePath = u8path(bundle);
    createDemoBundle(dir, bundle);
    const std::string takeId = "take_long";
    const fs::path output = u8path(dir.str("record.json"));

    int exitCode = -1;
    {
        ChildProcess child(SIANN_CLI_EXE, recordArgs(bundle, takeId), output);
        exitCode = child.wait();
    }
    const std::string printed = siann::io::readFile(output);
    INFO(printed);
    REQUIRE(exitCode == 0);
    const siann::json::Value result = siann::json::parse(printed);  // one JSON object
    CHECK(result.find("frames")->asString() == std::to_string(kTakeFrames));
    CHECK(result.find("overflows")->asString() == "0");
    CHECK(result.find("takeId")->asString() == takeId);

    const siann::session::Session s = siann::session::Session::open(bundlePath);
    const auto& doc = s.history().head().document;
    const siann::model::Clip* clip = doc.clip("clp_" + takeId);
    REQUIRE(clip != nullptr);
    CHECK(clip->length == kTakeFrames);
    const siann::model::Media* media = doc.media(clip->mediaId);
    REQUIRE(media != nullptr);
    CHECK(media->frames == kTakeFrames);

    // Sample-exact content, read in chunks: one consecutive run of the counter,
    // so no block was dropped or repeated.
    const CounterCheck content = checkCounterWav(takeMediaFile(bundlePath, takeId));
    INFO(content.problem);
    REQUIRE(content.readable);
    CHECK(content.frames == kTakeFrames);
    CHECK(content.mismatchAt == -1);

    CHECK(runJson({"verify", bundle}).exitCode == 0);
    CHECK(runJson({"info", bundle}).json.find("pendingTakes")->asArray().empty());
}

TEST_CASE("A 10-minute take killed at 9 minutes recovers every flushed block", "[.][long][cli][record]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    const fs::path bundlePath = u8path(bundle);
    createDemoBundle(dir, bundle);
    const std::string takeId = "take_long_killed";
    const std::string readyFile = dir.str("ready.json");
    constexpr std::int64_t kKillAfter = 540 * kRate;

    std::optional<ReadyState> ready;
    {
        auto args = recordArgs(bundle, takeId);
        args.push_back("--ready-file");
        args.push_back(readyFile);
        ChildProcess child(SIANN_CLI_EXE, args);
        ready = waitForReady(
            u8path(readyFile), [&] { return child.running(); },
            [](const ReadyState& state) { return state.startPosition.has_value() && state.durableFrames >= kKillAfter; },
            kGuard);
        REQUIRE(child.running());
        REQUIRE(ready);
        child.kill();
    }
    const std::int64_t durableFrames = ready->durableFrames;
    CHECK(durableFrames >= kKillAfter);
    CHECK(durableFrames < kTakeFrames);

    // Pending on the next open, and listed by info.
    {
        siann::session::OpenReport report;
        const siann::session::Session s = siann::session::Session::open(bundlePath, &report);
        CHECK(std::find(report.pendingTakes.begin(), report.pendingTakes.end(), takeId) != report.pendingTakes.end());
        CHECK(s.history().head().document.clip("clp_" + takeId) == nullptr);
    }
    const CliResult info = runJson({"info", bundle});
    REQUIRE(info.exitCode == 0);
    const auto& pending = info.json.find("pendingTakes")->asArray();
    REQUIRE(pending.size() == 1);
    CHECK(pending[0].asString() == takeId);

    const siann::session::TakeManifest manifest =
        siann::session::readTakeManifest(siann::session::takeManifestPath(bundlePath, takeId));
    REQUIRE(manifest.startPosition);
    CHECK(*manifest.startPosition == *ready->startPosition);

    // recover commits r4: media.add and clip.place.
    const CliResult recovered = runJson({"recover", bundle, takeId});
    INFO(siann::jcs::canonicalize(recovered.json));
    REQUIRE(recovered.exitCode == 0);
    CHECK(recovered.json.find("revision")->find("id")->asString() == "r4");
    const auto& diff = recovered.json.find("revision")->find("diff")->asArray();
    REQUIRE(diff.size() == 2);
    const auto changed = [&](const std::string& prefix) {
        return std::any_of(diff.begin(), diff.end(),
                           [&](const siann::json::Value& entry) { return entry.asString().rfind(prefix, 0) == 0; });
    };
    CHECK(changed("media:"));                // media.add
    CHECK(changed("clip:clp_" + takeId));  // clip.place

    siann::session::OpenReport report;
    const siann::session::Session s = siann::session::Session::open(bundlePath, &report);
    CHECK(report.pendingTakes.empty());
    const auto& doc = s.history().head().document;
    const siann::model::Clip* clip = doc.clip("clp_" + takeId);
    REQUIRE(clip != nullptr);
    CHECK(clip->position == siann::time::Position::audio(*manifest.startPosition - manifest.recordOffset));
    CHECK(clip->length >= durableFrames);  // every flushed block survived

    const CounterCheck content = checkCounterWav(takeMediaFile(bundlePath, takeId));
    INFO(content.problem);
    REQUIRE(content.readable);
    CHECK(content.frames == clip->length);
    CHECK(content.mismatchAt == -1);

    CHECK(runJson({"verify", bundle}).exitCode == 0);
    CHECK(runJson({"info", bundle}).json.find("pendingTakes")->asArray().empty());
}
