#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <thread>

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

namespace {

std::uint32_t le32(const char* p) {
    std::uint32_t v = 0;
    std::memcpy(&v, p, 4);
    return v;
}

// The data chunk size in a WAV header as last checkpointed (0 if unreadable).
std::uint64_t wavDataBytes(const fs::path& file) {
    std::ifstream in(file, std::ios::binary);
    if (!in) {
        return 0;
    }
    char riff[12];
    if (!in.read(riff, 12) || std::memcmp(riff, "RIFF", 4) != 0 || std::memcmp(riff + 8, "WAVE", 4) != 0) {
        return 0;
    }
    char chunk[8];
    while (in.read(chunk, 8)) {
        const std::uint32_t size = le32(chunk + 4);
        if (std::memcmp(chunk, "data", 4) == 0) {
            return size;
        }
        in.seekg(static_cast<std::streamoff>(size + (size & 1u)), std::ios::cur);
    }
    return 0;
}

std::optional<siann::session::TakeManifest> pendingTake(const fs::path& bundle, const std::string& takeId) {
    try {
        for (const auto& take : siann::session::pendingTakes(bundle)) {
            if (take.takeId == takeId) {
                return take;
            }
        }
    } catch (const std::exception&) {
        // The child may be replacing the manifest right now; ask again.
    }
    return std::nullopt;
}

}  // namespace

TEST_CASE("A recording siann-cli killed mid-take leaves a pending take that recovers", "[cli][record][recovery]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    const fs::path bundlePath = u8path(bundle);
    createDemoBundle(dir, bundle);
    const std::string takeId = "take_killed";
    const fs::path takeWav = siann::session::takeAudioPath(bundlePath, takeId);

    std::optional<siann::session::TakeManifest> seen;
    std::uint64_t bytesBeforeKill = 0;
    {
        ChildProcess child(SIANN_CLI_EXE, {"record", bundle, "--track", "t1", "--device", "fake", "--seconds", "600",
                                           "--take-id", takeId});
        // Bounded wait on a condition: the take has a start position and at
        // least one checkpoint (a second of frames) is in the WAV header.
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
        while (std::chrono::steady_clock::now() < deadline && child.running()) {
            seen = pendingTake(bundlePath, takeId);
            bytesBeforeKill = wavDataBytes(takeWav);
            if (seen && seen->startPosition && bytesBeforeKill > 0) {
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        REQUIRE(child.running());
        REQUIRE(seen);
        REQUIRE(seen->startPosition);
        REQUIRE(bytesBeforeKill > 0);
        child.kill();
    }
    const std::int64_t framesBeforeKill =
        static_cast<std::int64_t>(bytesBeforeKill / (static_cast<std::uint64_t>(seen->channels) * 4u));
    CHECK(framesBeforeKill > 0);
    CHECK(seen->trackId == "t1");

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

    siann::session::OpenReport report;
    const siann::session::Session s = siann::session::Session::open(bundlePath, &report);
    CHECK(report.pendingTakes.empty());
    const auto& doc = s.history().head().document;
    const siann::model::Clip* clip = doc.clip("clp_" + takeId);
    REQUIRE(clip != nullptr);
    CHECK(clip->trackId == "t1");
    CHECK(clip->position == siann::time::Position::audio(*seen->startPosition - seen->recordOffset));
    CHECK(clip->length >= framesBeforeKill);
    const siann::model::Media* media = doc.media(clip->mediaId);
    REQUIRE(media != nullptr);
    CHECK(media->frames >= framesBeforeKill);
    CHECK(runJson({"verify", bundle}).exitCode == 0);
    CHECK(runJson({"info", bundle}).json.find("pendingTakes")->asArray().empty());
}
