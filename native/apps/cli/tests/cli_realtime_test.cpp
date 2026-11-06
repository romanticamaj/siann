#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>

#include "siann/hash/jcs.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "siann/session/session.hpp"
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
    // The driver's deadline misses (spec: an xrun, separate from the underruns
    // above) and its longest callback: where a hosted plugin's wait will show
    // once the M4 plugin node runs inside a driver callback.
    REQUIRE(isDecimalString(played.json.find("xruns")));
    REQUIRE(played.json.find("maxCallbackMicros") != nullptr);
    CHECK(played.json.find("maxCallbackMicros")->kind() == Value::Kind::number);
    // The callbacks were timed by a running clock: the longest took time.
    CHECK(played.json.find("maxCallbackMicros")->asNumber() > 0.0);
    // Every callback had the device rate to be checked against.
    REQUIRE(isDecimalString(played.json.find("unmeasuredCallbacks")));
    CHECK(played.json.find("unmeasuredCallbacks")->asString() == "0");
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
    REQUIRE(isDecimalString(recorded.json.find("xruns")));
    REQUIRE(recorded.json.find("maxCallbackMicros") != nullptr);
    CHECK(recorded.json.find("maxCallbackMicros")->kind() == Value::Kind::number);

    const CliResult info = runJson({"info", bundle});
    REQUIRE(info.exitCode == 0);
    CHECK(clipsOn(info.json, "t1") == clipsBefore + 1);
    REQUIRE(info.json.find("pendingTakes") != nullptr);
    CHECK(info.json.find("pendingTakes")->asArray().empty());
    CHECK(runJson({"verify", bundle}).exitCode == 0);
}

TEST_CASE("record --seconds records exactly that many session frames from the transport start",
          "[cli][realtime][record]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);
    // 48,000 is not a whole number of 256-frame buffers: the take ends mid-block.
    const CliResult recorded = runJson({"record", bundle, "--track", "t1", "--device", "fake", "--seconds", "1"});
    INFO(siann::jcs::canonicalize(recorded.json));
    REQUIRE(recorded.exitCode == 0);
    CHECK(recorded.json.find("frames")->asString() == "48000");
    const std::string takeId = recorded.json.find("takeId")->asString();
    const auto session = siann::session::Session::open(u8path(bundle));
    const siann::model::Clip* clip = session.history().head().document.clip("clp_" + takeId);
    REQUIRE(clip != nullptr);
    CHECK(clip->length == 48'000);
}

TEST_CASE("record --fake-input counter records one consecutive run of the counter, and --ready-file reports it",
          "[cli][realtime][record][counter]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);
    const std::string ready = dir.str("ready.json");
    const CliResult recorded =
        runJson({"record", bundle, "--track", "t1", "--device", "fake", "--fake-input", "counter", "--fake-speed", "4",
                 "--seconds", "2", "--take-id", "take_counter", "--ready-file", ready});
    INFO(siann::jcs::canonicalize(recorded.json));
    REQUIRE(recorded.exitCode == 0);
    CHECK(recorded.json.find("frames")->asString() == "96000");
    CHECK(recorded.json.find("overflows")->asString() == "0");

    const CounterCheck content = checkCounterWav(takeMediaFile(u8path(bundle), "take_counter"));
    INFO(content.problem);
    REQUIRE(content.readable);
    CHECK(content.frames == 96'000);
    CHECK(content.mismatchAt == -1);
    CHECK(content.firstCounter >= 0);

    // The ready file holds the final checkpoint: every frame of the take.
    const std::optional<ReadyState> state = readReadyFile(u8path(ready));
    REQUIRE(state);
    CHECK(state->takeId == "take_counter");
    REQUIRE(state->startPosition);
    CHECK(std::to_string(*state->startPosition) == recorded.json.find("startPosition")->asString());
    CHECK(state->durableFrames == 96'000);
    CHECK(runJson({"verify", bundle}).exitCode == 0);
}

TEST_CASE("The fake device options need --device fake", "[cli][realtime][record]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);
    const auto usage = [](const CliResult& r) { return r.exitCode == 2 && errorCode(r) == "usage"; };
    CHECK(usage(runJson({"record", bundle, "--track", "t1", "--fake-speed", "4", "--seconds", "1"})));
    CHECK(usage(runJson({"record", bundle, "--track", "t1", "--fake-input", "counter", "--seconds", "1"})));
    CHECK(usage(runJson({"play", bundle, "--fake-speed", "4", "--seconds", "1"})));
    CHECK(usage(runJson({"play", bundle, "--fake-callback-nanos", "1000", "--seconds", "1"})));
    CHECK(usage(runJson({"play", bundle, "--device", "fake", "--fake-callback-nanos", "0", "--seconds", "1"})));
    // Capped: a step near INT64_MAX would overflow the deadline comparison.
    CHECK(usage(runJson({"play", bundle, "--device", "fake", "--fake-callback-nanos", "9223372036854775807", "--seconds",
                         "1"})));
    CHECK(usage(runJson({"play", bundle, "--fake-report-rate", "none", "--seconds", "1"})));
    CHECK(usage(runJson({"play", bundle, "--device", "fake", "--fake-report-rate", "half", "--seconds", "1"})));
    // bench measures real callbacks: a fake clock would make its report a lie.
    CHECK(usage(runJson({"bench", dir.str("Bench.siann"), "--tracks", "1", "--buffer", "256", "--seconds", "1", "--device",
                         "fake", "--fake-callback-nanos", "1000"})));
    CHECK(usage(runJson({"record", bundle, "--track", "t1", "--device", "fake", "--fake-speed", "0", "--seconds", "1"})));
    CHECK(usage(runJson({"record", bundle, "--track", "t1", "--device", "fake", "--fake-input", "noise", "--seconds",
                         "1"})));
    CHECK(runJson({"info", bundle}).json.find("pendingTakes")->asArray().empty());
}

// A known deadline miss driven through to the JSON: with --fake-callback-nanos
// the driver times every callback with a clock that advances by that much per
// reading, so each callback "takes" exactly that long. 20 ms against a 256-frame
// period at 48 kHz (5.33 ms) is a miss every time; the misses are the callbacks,
// 48128 frames played / 256, and the longest callback is the step.
TEST_CASE("play reports a deadline miss on every callback the driver timed over its period",
          "[cli][realtime][play]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);

    const CliResult played = runJson(
        {"play", bundle, "--device", "fake", "--seconds", "1", "--fake-callback-nanos", "20000000"});
    INFO(siann::jcs::canonicalize(played.json));
    REQUIRE(played.exitCode == 0);
    const std::int64_t callbacks = framesFor(1, 48'000, 256) / 256;
    CHECK(played.json.find("xruns")->asString() == std::to_string(callbacks));
    CHECK(played.json.find("maxCallbackMicros")->asNumber() == 20'000.0);
    CHECK(played.json.find("unmeasuredCallbacks")->asString() == "0");
    CHECK(played.json.find("srcUnderruns")->asString() == "0");  // a deadline miss is not SRC underfill

    // On time: a step under the period is never a miss.
    const CliResult onTime =
        runJson({"play", bundle, "--device", "fake", "--seconds", "1", "--fake-callback-nanos", "1000000"});
    REQUIRE(onTime.exitCode == 0);
    CHECK(onTime.json.find("xruns")->asString() == "0");
    CHECK(onTime.json.find("maxCallbackMicros")->asNumber() == 1'000.0);
}

// A device that reports no sample rate gives the driver no period to check
// against: every callback is counted as unmeasured, none as on time, so "0"
// xruns never stands for "not checked". The run still plays for a second of
// session frames (the driver, and the run length, fall back to the session rate).
TEST_CASE("play reports callbacks it could not check against a deadline", "[cli][realtime][play]") {
    TempDir dir;
    const std::string bundle = dir.str("Song.siann");
    createDemoBundle(dir, bundle);

    const CliResult played =
        runJson({"play", bundle, "--device", "fake", "--seconds", "1", "--fake-report-rate", "none"});
    INFO(siann::jcs::canonicalize(played.json));
    REQUIRE(played.exitCode == 0);
    const std::int64_t callbacks = framesFor(1, 48'000, 256) / 256;
    CHECK(played.json.find("framesPlayed")->asString() == std::to_string(framesFor(1, 48'000, 256)));
    CHECK(played.json.find("unmeasuredCallbacks")->asString() == std::to_string(callbacks));
    CHECK(played.json.find("xruns")->asString() == "0");
    CHECK(played.json.find("deviceStatus")->find("sampleRate")->asNumber() == 0);
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
