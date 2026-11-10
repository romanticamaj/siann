#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>

#include "siann/hash/jcs.hpp"
#include "siann/session/session.hpp"
#include "siann/session/takes.hpp"
#include "support/child_process.hpp"
#include "support/cli_support.hpp"

#ifndef SIANN_CLI_EXE
#define SIANN_CLI_EXE "siann-cli"  // set by CMake; the fallback keeps a plain syntax check building
#endif

using namespace siann::cli::test;
namespace fs = std::filesystem;

TEST_CASE("A recording siann-cli killed mid-take leaves a pending take that recovers", "[cli][record][recovery]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    const fs::path bundlePath = u8path(bundle);
    createDemoBundle(dir, bundle);
    const std::string takeId = "take_killed";
    const std::string readyFile = dir.str("ready.json");

    std::optional<ReadyState> ready;
    {
        ChildProcess child(SIANN_CLI_EXE, {"record", bundle, "--track", "t1", "--device", "fake", "--fake-input",
                                           "counter", "--seconds", "600", "--take-id", takeId, "--ready-file",
                                           readyFile});
        // The child says when it is ready: the take start is marked and at
        // least one checkpoint is durable. The deadline only guards against a
        // hung child; it is not the synchronization.
        ready = waitForReady(
            u8path(readyFile), [&] { return child.running(); },
            [](const ReadyState& s) { return s.startPosition.has_value() && s.durableFrames > 0; },
            std::chrono::seconds(120));
        REQUIRE(child.running());
        REQUIRE(ready);
        child.kill();
    }
    CHECK(ready->takeId == takeId);
    const std::int64_t durableFrames = ready->durableFrames;
    CHECK(durableFrames > 0);

    // The manifest is read only after the kill: nothing replaces it any more.
    const siann::session::TakeManifest manifest =
        siann::session::readTakeManifest(siann::session::takeManifestPath(bundlePath, takeId));
    CHECK(manifest.trackId == "t1");
    REQUIRE(manifest.startPosition);
    CHECK(*manifest.startPosition == *ready->startPosition);

    // The next open lists the take as pending.
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

    // recover commits it as one revision: media.add and clip.place.
    const CliResult recovered = runJson({"recover", bundle, takeId});
    INFO(siann::jcs::canonicalize(recovered.json));
    REQUIRE(recovered.exitCode == 0);
    const auto& diff = recovered.json.find("revision")->find("diff")->asArray();
    CHECK(diff.size() == 2);
    CHECK(recovered.json.find("revision")->find("id")->asString() == "r4");
    // Before this process opens the bundle, whose lock would refuse the children.
    CHECK(runJson({"verify", bundle}).exitCode == 0);
    CHECK(runJson({"info", bundle}).json.find("pendingTakes")->asArray().empty());

    siann::session::OpenReport report;
    const siann::session::Session s = siann::session::Session::open(bundlePath, &report);
    CHECK(report.pendingTakes.empty());
    const auto& doc = s.history().head().document;
    const siann::model::Clip* clip = doc.clip("clp_" + takeId);
    REQUIRE(clip != nullptr);
    CHECK(clip->trackId == "t1");
    CHECK(clip->position == siann::time::Position::audio(*manifest.startPosition - manifest.recordOffset));
    // Every frame the child reported durable survived the kill.
    CHECK(clip->length >= durableFrames);
    const siann::model::Media* media = doc.media(clip->mediaId);
    REQUIRE(media != nullptr);
    CHECK(media->frames == clip->length);

    // And it is the counter input, with no gap or repeat.
    const CounterCheck content = checkCounterWav(takeMediaFile(s, takeId));
    INFO(content.problem);
    REQUIRE(content.readable);
    CHECK(content.frames == clip->length);
    CHECK(content.mismatchAt == -1);
}
