#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <filesystem>
#include <random>
#include <sstream>
#include <string>
#include <vector>

#include "siann/cli/cli.hpp"
#include "siann/hash/json.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"

namespace fs = std::filesystem;
using siann::json::Value;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-cli-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    std::string str(const std::string& name) const {
        const auto u8 = (path_ / fs::path(std::u8string(name.begin(), name.end()))).u8string();
        return std::string(u8.begin(), u8.end());
    }

private:
    fs::path path_;
};

struct Result {
    int exitCode;
    Value json;
};

Result cli(std::vector<std::string> args) {
    args.push_back("--time");
    args.push_back("2026-10-21T00:00:00Z");
    std::ostringstream out;
    const int code = siann::cli::runCli(args, out);
    return Result{code, siann::json::parse(out.str())};
}

std::string errorCode(const Result& r) {
    return r.json.find("error")->find("code")->asString();
}

void writeImpulse(const std::string& file, std::int64_t rate, std::int64_t frames, std::int64_t at) {
    siann::media::AudioBuffer buffer;
    buffer.info = siann::media::AudioInfo{2, rate, frames};
    buffer.samples.assign(static_cast<std::size_t>(frames * 2), 0.0f);
    buffer.samples[static_cast<std::size_t>(at * 2)] = 1.0f;
    buffer.samples[static_cast<std::size_t>(at * 2 + 1)] = 1.0f;
    siann::io::writeFileAtomic(fs::path(std::u8string(file.begin(), file.end())), siann::media::encodeWavFloat32(buffer));
}

}  // namespace

TEST_CASE("M1 exit criterion: create, import, place, set gain, render, replay", "[cli][m1]") {
    TempDir dir;
    const std::string bundle = dir.str("è² Song.siann");  // U+8072, a non-ASCII path on purpose
    const std::string source = dir.str("kick.wav");
    const std::string output = dir.str("mix.wav");
    writeImpulse(source, 48'000, 1'000, 0);

    REQUIRE(cli({"create", bundle, "--name", "Demo"}).exitCode == 0);
    const Result imported = cli({"import", bundle, source, "--media-id", "med_kick"});
    REQUIRE(imported.exitCode == 0);
    CHECK_FALSE(imported.json.find("converted")->asBool());

    const Result plan = cli({"plan", bundle, R"([
        {"op":"track.add","trackId":"trk_drums","name":"Drums","channels":2},
        {"op":"clip.place","clipId":"clp_1","trackId":"trk_drums","mediaId":"med_kick",
         "position":{"domain":"audio","value":"4800"},"sourceStart":"0","length":"1000"},
        {"op":"clip.place","clipId":"clp_2","trackId":"trk_drums","mediaId":"med_kick",
         "position":{"domain":"music","value":"1920"},"sourceStart":"0","length":"1000"}])"});
    REQUIRE(plan.exitCode == 0);
    CHECK(plan.json.find("revision")->find("cause")->asString() == "plan");

    REQUIRE(cli({"exec", bundle, R"({"op":"track.set_gain","trackId":"trk_drums","gainMilliDb":-6000})"}).exitCode == 0);

    const Result rendered = cli({"render", bundle, output});
    REQUIRE(rendered.exitCode == 0);
    CHECK(rendered.json.find("frames")->asString() == "25000");  // the music-time clip ends at 24000 + 1000

    const auto mix = siann::media::decodeWav(siann::io::readFile(fs::path(std::u8string(output.begin(), output.end()))));
    CHECK(mix.info.frames == 25'000);
    const float gain = 0.501187f;
    CHECK(std::abs(mix.samples[4'800 * 2] - gain) < 1e-5f);
    CHECK(std::abs(mix.samples[24'000 * 2 + 1] - gain) < 1e-5f);
    std::size_t nonZero = 0;
    for (const float s : mix.samples) {
        nonZero += s != 0.0f ? 1u : 0u;
    }
    CHECK(nonZero == 4);

    // Replay from the journal reproduces the document hash and the render.
    const Result verified = cli({"verify", bundle});
    REQUIRE(verified.exitCode == 0);
    CHECK(verified.json.find("recordsReplayed")->asString() == "4");
    CHECK(verified.json.find("documentHash")->asString() == rendered.json.find("documentHash")->asString());
    const Result again = cli({"render", bundle, dir.str("mix2.wav")});
    CHECK(again.json.find("outputHash")->asString() == rendered.json.find("outputHash")->asString());
}

TEST_CASE("Undo, redo and info through the CLI", "[cli]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    cli({"create", bundle, "--name", "Demo"});
    cli({"exec", bundle, R"({"op":"track.add","trackId":"trk_1","name":"One","channels":1})"});

    Result info = cli({"info", bundle});
    REQUIRE(info.exitCode == 0);
    CHECK(info.json.find("tracks")->asArray().size() == 1);
    CHECK(info.json.find("canUndo")->asBool());

    const Result undone = cli({"undo", bundle});
    REQUIRE(undone.exitCode == 0);
    CHECK(undone.json.find("revision")->find("target")->asString() == "r2");
    info = cli({"info", bundle});
    CHECK(info.json.find("tracks")->asArray().empty());
    CHECK(info.json.find("canRedo")->asBool());

    REQUIRE(cli({"redo", bundle}).exitCode == 0);
    CHECK(cli({"info", bundle}).json.find("tracks")->asArray().size() == 1);
}

TEST_CASE("Commands can be read from a file", "[cli]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    const std::string file = dir.str("command.json");
    siann::io::writeFileAtomic(fs::path(std::u8string(file.begin(), file.end())),
                               R"({"op":"session.rename","name":"From File"})");
    cli({"create", bundle, "--name", "Demo"});
    REQUIRE(cli({"exec", bundle, "@" + file}).exitCode == 0);
}

TEST_CASE("CLI errors are JSON with stable codes and exit codes", "[cli]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");

    Result r = cli({});
    CHECK(r.exitCode == 2);
    CHECK(errorCode(r) == "usage");
    CHECK(cli({"explode"}).exitCode == 2);
    CHECK(errorCode(cli({"create", bundle})) == "usage");  // missing --name

    r = cli({"info", bundle});
    CHECK(r.exitCode == 1);
    CHECK(errorCode(r) == "not_a_bundle");

    cli({"create", bundle, "--name", "Demo"});
    CHECK(errorCode(cli({"create", bundle, "--name", "Again"})) == "bundle_exists");
    CHECK(errorCode(cli({"exec", bundle, R"({"op":"track.set_gain","trackId":"x","gainMilliDb":0})"})) == "not_found");
    CHECK(errorCode(cli({"exec", bundle, "{not json"})) == "invalid_json");
    CHECK(errorCode(cli({"undo", bundle})) == "nothing_to_undo");
    CHECK(errorCode(cli({"import", bundle, dir.str("missing.wav"), "--media-id", "med_x"})) == "io_error");
    CHECK(errorCode(cli({"create", dir.str("Other.siann"), "--name", "X", "--rate", "abc"})) == "usage");
}

TEST_CASE("The command catalog is listed", "[cli]") {
    const Result r = cli({"commands"});
    REQUIRE(r.exitCode == 0);
    CHECK(r.json.find("commands")->asArray().size() == 16);
}
