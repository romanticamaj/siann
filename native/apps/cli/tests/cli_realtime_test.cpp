#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <filesystem>
#include <string>

#include "siann/hash/jcs.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "support/cli_support.hpp"

using namespace siann::cli::test;
using siann::json::Value;

namespace {

// Device frames of a run limited to `seconds`: whole buffers until the limit
// is reached (counted in device frames, never by the wall clock).
std::int64_t framesFor(std::int64_t seconds, std::int64_t rate, std::int64_t buffer) {
    const std::int64_t wanted = seconds * rate;
    return (wanted + buffer - 1) / buffer * buffer;
}

bool isDecimalString(const Value* value) {
    if (value == nullptr || value->kind() != Value::Kind::string || value->asString().empty()) {
        return false;
    }
    for (const char c : value->asString()) {
        if (c < '0' || c > '9') {
            return false;
        }
    }
    return true;
}

}  // namespace

TEST_CASE("play runs a bundle on the fake device for a number of device frames", "[cli][realtime][play]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);

    const CliResult played = runJson({"play", bundle, "--device", "fake", "--seconds", "1"});
    INFO(siann::jcs::canonicalize(played.json));
    REQUIRE(played.exitCode == 0);
    CHECK(played.json.find("framesPlayed")->asString() == std::to_string(framesFor(1, 48'000, 256)));
    CHECK(played.json.find("underruns")->asString() == "0");
    CHECK(isDecimalString(played.json.find("srcUnderruns")));
    const Value* resampling = played.json.find("resampling");
    REQUIRE(resampling != nullptr);
    REQUIRE(resampling->kind() == Value::Kind::object);
    CHECK_FALSE(resampling->find("active")->asBool());
    CHECK(resampling->find("deviceRate")->asNumber() == 48'000);
    REQUIRE(played.json.find("latency") != nullptr);
    REQUIRE(played.json.find("deviceStatus") != nullptr);
    CHECK(played.json.find("deviceStatus")->find("bufferFrames")->asNumber() == 256);
}

TEST_CASE("play honours --buffer", "[cli][realtime][play]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);
    const CliResult played = runJson({"play", bundle, "--device", "fake", "--seconds", "1", "--buffer", "480"});
    REQUIRE(played.exitCode == 0);
    CHECK(played.json.find("framesPlayed")->asString() == "48000");
}

TEST_CASE("record commits a take on a track", "[cli][realtime][record]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);
    const std::size_t clipsBefore = clipsOn(runJson({"info", bundle}).json, "t1");

    const CliResult recorded = runJson({"record", bundle, "--track", "t1", "--device", "fake", "--seconds", "1"});
    INFO(siann::jcs::canonicalize(recorded.json));
    REQUIRE(recorded.exitCode == 0);
    REQUIRE(recorded.json.find("revision") != nullptr);
    CHECK(recorded.json.find("revision")->kind() == Value::Kind::object);
    const std::string takeId = recorded.json.find("takeId")->asString();
    CHECK(takeId.rfind("take_", 0) == 0);
    REQUIRE(isDecimalString(recorded.json.find("frames")));
    CHECK(std::stoll(recorded.json.find("frames")->asString()) > 0);
    CHECK(recorded.json.find("overflows")->asString() == "0");

    const CliResult info = runJson({"info", bundle});
    REQUIRE(info.exitCode == 0);
    CHECK(clipsOn(info.json, "t1") == clipsBefore + 1);
    REQUIRE(info.json.find("pendingTakes") != nullptr);
    CHECK(info.json.find("pendingTakes")->asArray().empty());
    CHECK(runJson({"verify", bundle}).exitCode == 0);
}

TEST_CASE("record and recover reject unknown tracks and takes", "[cli][realtime][record]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);
    const CliResult noTrack = runJson({"record", bundle, "--track", "nope", "--device", "fake", "--seconds", "1"});
    CHECK(noTrack.exitCode == 1);
    CHECK(errorCode(noTrack) == "track_not_found");

    const CliResult noTake = runJson({"recover", bundle, "take_missing"});
    CHECK(noTake.exitCode == 1);
    CHECK(errorCode(noTake) == "take_not_found");
}

TEST_CASE("bench generates a bundle and reports callbacks, deadline misses and callback time", "[cli][realtime][bench]") {
    TempDir dir;
    const std::string bundle = dir.str("Bench.siann");
    REQUIRE_FALSE(std::filesystem::exists(u8path(bundle)));

    const auto violations = siann::rt::allocationViolations();
    const CliResult bench =
        runJson({"bench", bundle, "--tracks", "2", "--buffer", "256", "--seconds", "1", "--device", "fake"});
    INFO(siann::jcs::canonicalize(bench.json));
    REQUIRE(bench.exitCode == 0);
    CHECK(siann::rt::allocationViolations() == violations);  // the timed callback path stays allocation-free

    const Value& j = bench.json;
    CHECK(j.find("generated")->asBool());
    REQUIRE(isDecimalString(j.find("callbacks")));
    CHECK(j.find("callbacks")->asString() == std::to_string((48'000 + 255) / 256));
    // Whether a deadline is missed depends on the machine, but xruns must agree
    // with the longest callback: at least one miss exactly when it exceeded the
    // 256 / 48000 s period (callback_timer_test forces misses deterministically).
    REQUIRE(isDecimalString(j.find("xruns")));
    REQUIRE(j.find("maxCallbackMicros") != nullptr);
    CHECK(j.find("maxCallbackMicros")->kind() == Value::Kind::number);
    CHECK(j.find("maxCallbackMicros")->asNumber() > 0.0);
    const double periodMicros = 256.0 * 1'000'000.0 / 48'000.0;
    const bool missed = std::stoll(j.find("xruns")->asString()) > 0;
    CHECK(missed == (j.find("maxCallbackMicros")->asNumber() > periodMicros));
    CHECK(j.find("bufferFrames")->asNumber() == 256);
    CHECK(j.find("deviceRate")->asNumber() == 48'000);
    CHECK(j.find("sessionRate")->asNumber() == 48'000);
    CHECK(j.find("tracks")->asNumber() == 2);
    CHECK(j.find("seconds")->asNumber() == 1);
    CHECK(isDecimalString(j.find("underruns")));
    CHECK(isDecimalString(j.find("srcUnderruns")));

    const CliResult info = runJson({"info", bundle});
    REQUIRE(info.exitCode == 0);
    REQUIRE(info.json.find("tracks")->asArray().size() == 2);
    for (const Value& track : info.json.find("tracks")->asArray()) {
        CHECK(track.find("clips")->asNumber() == 1);
    }
    CHECK(info.json.find("media")->asNumber() == 1);  // one shared generated source
    CHECK(runJson({"verify", bundle}).exitCode == 0);

    // The bundle now exists: a second run reuses it.
    const CliResult again =
        runJson({"bench", bundle, "--tracks", "2", "--buffer", "128", "--seconds", "1", "--device", "fake"});
    REQUIRE(again.exitCode == 0);
    CHECK_FALSE(again.json.find("generated")->asBool());
    CHECK(again.json.find("callbacks")->asString() == std::to_string(48'000 / 128));
}

TEST_CASE("bench refuses an existing bundle with another track count", "[cli][realtime][bench]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);  // one track
    const CliResult bench =
        runJson({"bench", bundle, "--tracks", "2", "--buffer", "256", "--seconds", "1", "--device", "fake"});
    CHECK(bench.exitCode == 1);
    CHECK(errorCode(bench) == "bench_track_mismatch");
}

TEST_CASE("Realtime commands report usage errors with exit code 2", "[cli][realtime]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);
    const std::string fresh = dir.str("Fresh.siann");

    // A usage error of the command itself, not "unknown command".
    const auto usage = [](const CliResult& r) {
        return r.exitCode == 2 && errorCode(r) == "usage" &&
               r.json.find("error")->find("message")->asString().find("unknown command") == std::string::npos;
    };
    CHECK(usage(runJson({"record", bundle, "--device", "fake", "--seconds", "1"})));
    CHECK(usage(runJson({"bench", fresh, "--buffer", "256", "--seconds", "1", "--device", "fake"})));
    CHECK(usage(runJson({"bench", fresh, "--tracks", "2", "--seconds", "1", "--device", "fake"})));
    CHECK(usage(runJson({"bench", fresh, "--tracks", "2", "--buffer", "256", "--device", "fake"})));
    CHECK(usage(runJson({"bench", fresh, "--tracks", "2.5", "--buffer", "256", "--seconds", "1", "--device", "fake"})));
    CHECK(usage(runJson({"bench", fresh, "--tracks", "2", "--buffer", "x", "--seconds", "1", "--device", "fake"})));
    CHECK(usage(runJson({"bench", fresh, "--tracks", "0", "--buffer", "256", "--seconds", "1", "--device", "fake"})));
    CHECK(usage(runJson({"play", bundle, "--device", "fake", "--seconds", "one"})));
    CHECK(usage(runJson({"play", bundle, "--device", "fake", "--seconds", "0"})));
    CHECK(usage(runJson({"record", bundle, "--track", "t1", "--device", "fake", "--seconds", "-1"})));
    CHECK(usage(runJson({"play"})));
    CHECK(usage(runJson({"recover", bundle})));
    CHECK_FALSE(std::filesystem::exists(u8path(fresh)));
}

#if !defined(SIANN_CLI_WITH_JUCE)

TEST_CASE("Without JUCE the realtime commands report no_audio_backend", "[cli][realtime][nojuce]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);
    const std::string fresh = dir.str("Fresh.siann");

    const auto noBackend = [](const CliResult& r) { return r.exitCode == 1 && errorCode(r) == "no_audio_backend"; };
    CHECK(noBackend(runJson({"devices"})));
    CHECK(noBackend(runJson({"play", bundle, "--seconds", "1"})));
    CHECK(noBackend(runJson({"record", bundle, "--track", "t1", "--seconds", "1"})));
    CHECK(noBackend(runJson({"bench", fresh, "--tracks", "1", "--buffer", "256", "--seconds", "1"})));
    CHECK(noBackend(runJson({"play", bundle, "--device", "Windows Audio/Speakers", "--seconds", "1"})));
    CHECK_FALSE(std::filesystem::exists(u8path(fresh)));  // nothing is generated without a device
    CHECK(runJson({"info", bundle}).json.find("pendingTakes")->asArray().empty());
}

#else

TEST_CASE("devices lists output devices of the desktop build", "[cli][realtime][juce]") {
    const CliResult listed = runJson({"devices"});
    INFO(siann::jcs::canonicalize(listed.json));
    REQUIRE(listed.exitCode == 0);
    const Value* devices = listed.json.find("devices");
    REQUIRE(devices != nullptr);
    REQUIRE(devices->kind() == Value::Kind::array);  // may be empty on CI runners
    for (const Value& device : devices->asArray()) {
        CHECK(device.find("type")->kind() == Value::Kind::string);
        CHECK(device.find("name")->kind() == Value::Kind::string);
        CHECK(device.find("isDefault")->kind() == Value::Kind::boolean);
        CHECK(device.find("id")->asString() == device.find("type")->asString() + "/" + device.find("name")->asString());
    }
}

TEST_CASE("A nonexistent device reports a device error code", "[cli][realtime][juce]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);
    const CliResult played =
        runJson({"play", bundle, "--device", "No Such Type/No Such Device", "--seconds", "1"});
    INFO(siann::jcs::canonicalize(played.json));
    CHECK(played.exitCode == 1);
    const std::string code = errorCode(played);
    CHECK((code == "no_device" || code == "device_open_failed"));
}

#endif
