// siann-cli realtime commands (architecture spec, "siann-cli realtime
// commands (M2)"): devices, play, record, recover and bench. They drive the
// realtime engine (siann-playback) on one control thread, ticking it every
// 10 ms; the audio thread runs only the device callback.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include "callback_timer.hpp"
#include "cli_internal.hpp"
#include "siann/command/command.hpp"
#include "siann/engine/offline.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/host/fake_audio_device.hpp"
#include "siann/host/fake_callback_clock.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/playback/playback_engine.hpp"
#include "siann/realtime/recorder.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/session.hpp"
#include "siann/session/takes.hpp"

#if defined(SIANN_CLI_WITH_JUCE)
#include "siann/host/juce_audio_device.hpp"
#endif

namespace siann::cli::detail {

namespace fs = std::filesystem;
using json::Array;
using json::Object;
using json::Value;

namespace {

constexpr int kDefaultBufferFrames = 256;
constexpr int kOutputChannels = 2;
constexpr auto kTickInterval = std::chrono::milliseconds(10);
constexpr const char* kFakeDevice = "fake";

Value number(std::int64_t value) {
    return Value(static_cast<double>(value));
}

Value decimal(std::int64_t value) {
    return Value(std::to_string(value));
}

Value decimal(std::uint64_t value) {
    return Value(std::to_string(value));
}

#if !defined(SIANN_CLI_WITH_JUCE)
CliError noAudioBackend() {
    return CliError("no_audio_backend",
                    "this siann-cli was built without an audio backend (configure with SIANN_WITH_JUCE=ON, desktop "
                    "preset); use --device fake");
}
#endif

// --fake-speed, --fake-input and --fake-callback-nanos shape a run on the fake
// device; without --device fake they are a usage error. --fake-callback-nanos N
// times the driver's callbacks with a clock that advances N ns per reading, so
// every callback "takes" N ns: a known deadline miss (or none) for tests.
// --fake-report-rate none makes the device report no sample rate, so the driver
// has no period to check callbacks against (they are counted as unmeasured).
struct FakeDeviceChoice {
    std::int64_t speed = 1;
    host::FakeAudioDevice::InputSignal input = host::FakeAudioDevice::InputSignal::none;
    std::int64_t callbackNanos = 0;  // 0: the steady clock
    bool reportNoRate = false;
};

FakeDeviceChoice fakeDeviceChoice(const Args& args) {
    const auto id = args.option("device");
    const bool fake = id && *id == kFakeDevice;
    if (!fake && (args.option("fake-speed") || args.option("fake-input") || args.option("fake-callback-nanos") ||
                  args.option("fake-report-rate"))) {
        throw UsageError("--fake-speed, --fake-input, --fake-callback-nanos and --fake-report-rate need --device fake");
    }
    FakeDeviceChoice choice;
    choice.speed = positiveOption(args, "fake-speed", 1);
    if (args.option("fake-callback-nanos")) {
        choice.callbackNanos = positiveOption(args, "fake-callback-nanos", 1);
        if (choice.callbackNanos > host::kMaxFakeCallbackNanos) {
            throw UsageError("--fake-callback-nanos must be at most " + std::to_string(host::kMaxFakeCallbackNanos));
        }
    }
    if (const auto report = args.option("fake-report-rate")) {
        if (*report != "none") {
            throw UsageError("--fake-report-rate takes only none");
        }
        choice.reportNoRate = true;
    }
    if (const auto input = args.option("fake-input")) {
        if (*input == "counter") {
            choice.input = host::FakeAudioDevice::InputSignal::counter;
        } else if (*input != "loopback") {
            throw UsageError("--fake-input must be loopback or counter");
        }
    }
    return choice;
}

// --device fake: a paced software device with loopback (or the counter input),
// so every command runs without hardware. It reports one buffer of input and
// one of output latency, as a real device would, which loopback needs.
// Anything else is a real device of the desktop build.
std::unique_ptr<host::AudioDevice> openDevice(const Args& args, int bufferFrames) {
    const FakeDeviceChoice choice = fakeDeviceChoice(args);
    const auto id = args.option("device");
    if (id && *id == kFakeDevice) {
        host::FakeAudioDevice::Options options;
        options.paced = true;
        options.speed = static_cast<double>(choice.speed);
        options.inputSignal = choice.input;
        options.reportNoSampleRate = choice.reportNoRate;
        options.loopback = choice.input == host::FakeAudioDevice::InputSignal::none;
        options.inputLatencyFrames = bufferFrames;
        options.outputLatencyFrames = bufferFrames;
        return std::make_unique<host::FakeAudioDevice>(options);
    }
#if defined(SIANN_CLI_WITH_JUCE)
    return std::make_unique<host::JuceAudioDevice>();
#else
    throw noAudioBackend();
#endif
}

std::string deviceIdOf(const Args& args) {
    const auto id = args.option("device");
    return id && *id != kFakeDevice ? *id : std::string();
}

// One run of the realtime engine on a timed device. Members are declared so
// that the engine (which stops the device when destroyed) goes first.
// `fakeCallbackNanos` > 0 times the driver's callbacks with host::fakeCallbackClock.
class RealtimeRun {
public:
    RealtimeRun(session::Session& s, std::unique_ptr<host::AudioDevice> device, bool playOnStart,
                std::int64_t fakeCallbackNanos)
        : device_(std::move(device)),
          timed_(*device_, timer_),
          engine_(s, engineOptions(playOnStart, fakeCallbackNanos)) {
        engine_.load();
    }

    // `runLength` (device frames for the device rate, optional) bounds the run
    // from the device's first callback: it is set before the device starts,
    // so callbacks that race ahead of the control thread are not added to it.
    void start(const std::string& deviceId, int bufferFrames, int inputChannels,
               std::function<std::int64_t(std::int64_t deviceRate)> runLength = nullptr) {
        timed_.setRunLength(std::move(runLength));
        host::AudioDeviceConfig config;
        config.deviceId = deviceId;
        config.bufferFrames = bufferFrames;
        config.inputChannels = inputChannels;
        config.outputChannels = kOutputChannels;
        engine_.start(timed_, config);  // asks the device for the session rate
    }

    std::int64_t deviceRate() const noexcept { return timed_.status().sampleRate; }

    // Stops after `frames` more device frames (whole buffers), counted from
    // now: for a run whose length counts from a later event (record counts
    // from the transport start), not from the device start.
    void runFor(std::int64_t frames) { timed_.setFrameLimit(timed_.frames() + frames); }

    // Ticks the engine until the frame limit is reached, the device stops on
    // its own, `interrupt` is set or `done` (optional) returns true.
    void wait(const std::atomic<bool>* interrupt, const std::function<bool()>& done = nullptr) {
        while (!timed_.limitReached() && engine_.driver().state() == realtime::DriverState::realtime &&
               !(interrupt != nullptr && interrupt->load()) && !(done && done())) {
            engine_.tick();
            std::this_thread::sleep_for(kTickInterval);
        }
        deviceLost_ = engine_.driver().state() != realtime::DriverState::realtime;
    }

    // Ticks the engine until the transport has started on the audio thread
    // (or the device stopped, or `interrupt` is set).
    void waitUntilPlaying(const std::atomic<bool>* interrupt) {
        while (!engine_.driver().playing() && engine_.driver().state() == realtime::DriverState::realtime &&
               !(interrupt != nullptr && interrupt->load())) {
            engine_.tick();
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }

    void stop() { engine_.stop(); }

    playback::PlaybackEngine& engine() noexcept { return engine_; }
    const CallbackTimer& timer() const noexcept { return timer_; }

    // Device frames played, underruns, the driver's callback timing and the
    // device's state. `withTiming` false leaves out `xruns` and
    // `maxCallbackMicros`: bench reports them from its TimedDevice instead,
    // measured around the whole device callback and checked by benchTiming().
    void report(Object& out, bool withTiming = true) {
        const auto& status = engine_.driver().deviceStatus();
        const auto& resampling = engine_.resampling();
        const auto& latency = engine_.driver().latency();
        out.emplace_back("framesPlayed", decimal(timed_.frames()));
        out.emplace_back("underruns", decimal(engine_.underruns()));
        out.emplace_back("srcUnderruns", decimal(engine_.driver().srcUnderruns()));
        if (withTiming) {
            // The driver's own timing of every callback (spec, "Realtime rules
            // and enforcement": deadline misses are counted and reported; this is
            // where a hosted plugin's wait will show once the M4 plugin node runs
            // inside a driver callback).
            // An xrun here is a callback the driver timed over its period, never
            // one the device reported. Callbacks without a device rate could not
            // be checked and are counted apart, so "0" xruns never hides them.
            const auto& timing = engine_.driver().callbackTiming();
            out.emplace_back("xruns", decimal(timing.misses()));
            out.emplace_back("maxCallbackMicros", Value(static_cast<double>(timing.maxCallbackNanos()) / 1'000.0));
            out.emplace_back("unmeasuredCallbacks", decimal(timing.unmeasured()));
        }
        out.emplace_back("deviceLost", Value(deviceLost_));
        out.emplace_back("resampling", Value(Object{{"active", Value(resampling.active)},
                                                    {"deviceRate", number(resampling.deviceRate)},
                                                    {"sessionRate", number(resampling.sessionRate)},
                                                    {"addedLatencyFrames", number(resampling.addedLatencyFrames)}}));
        out.emplace_back("latency",
                         Value(Object{{"sessionRate", number(latency.sessionRate)},
                                      {"deviceRate", number(latency.deviceRate)},
                                      {"inputLatencyFrames", number(latency.inputLatencyFrames)},
                                      {"outputLatencyFrames", number(latency.outputLatencyFrames)},
                                      {"srcOutputLatencyFrames", number(latency.srcOutputLatencyFrames)},
                                      {"srcInputLatencyFrames", number(latency.srcInputLatencyFrames)},
                                      {"recordOffsetFrames", number(latency.recordOffsetFrames)}}));
        out.emplace_back("deviceStatus", Value(Object{{"sampleRate", number(status.sampleRate)},
                                                      {"bufferFrames", number(status.bufferFrames)},
                                                      {"inputLatencyFrames", number(status.inputLatencyFrames)},
                                                      {"outputLatencyFrames", number(status.outputLatencyFrames)}}));
    }

private:
    static playback::PlaybackOptions engineOptions(bool playOnStart, std::int64_t fakeCallbackNanos) {
        playback::PlaybackOptions options;
        options.butlerThread = true;
        options.playOnStart = playOnStart;
        if (fakeCallbackNanos > 0) {
            host::setFakeCallbackNanos(fakeCallbackNanos);
            options.callbackClock = &host::fakeCallbackClock;
        }
        return options;
    }

    std::unique_ptr<host::AudioDevice> device_;
    CallbackTimer timer_;
    TimedDevice timed_;
    playback::PlaybackEngine engine_;
    bool deviceLost_ = false;
};

// record --ready-file: `{takeId, startPosition, durableFrames}`, replaced
// atomically when the take start is marked and after every checkpoint, so a
// test or supervisor can wait for an explicit signal instead of reading files
// the recorder is rewriting. Called from the recorder's writer side only (one
// thread at a time). A failed write is retried at the next checkpoint; it
// never stops the recording.
class ReadyFile {
public:
    ReadyFile(fs::path path, std::string takeId) : path_(std::move(path)), takeId_(std::move(takeId)) {}

    void started(std::int64_t startPosition) {
        startPosition_ = startPosition;
        write();
    }

    void checkpointed(std::int64_t durableFrames) {
        durableFrames_ = durableFrames;
        write();
    }

private:
    void write() noexcept {
        if (path_.empty()) {
            return;
        }
        try {
            const Value state(Object{{"takeId", Value(takeId_)},
                                     {"startPosition", startPosition_ ? decimal(*startPosition_) : Value(nullptr)},
                                     {"durableFrames", decimal(durableFrames_)}});
            io::writeFileAtomic(path_, jcs::canonicalize(state) + "\n");
        } catch (...) {
        }
    }

    fs::path path_;
    std::string takeId_;
    std::optional<std::int64_t> startPosition_;
    std::int64_t durableFrames_ = 0;
};

// Device frames for `frames` session frames, rounded up.
std::int64_t toDeviceFrames(std::int64_t frames, std::int64_t sessionRate, std::int64_t deviceRate) {
    if (sessionRate <= 0 || sessionRate == deviceRate) {
        return frames;
    }
    return (frames * deviceRate + sessionRate - 1) / sessionRate;
}

std::string generatedTakeId() {
    const std::time_t t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char stamp[32];
    std::strftime(stamp, sizeof(stamp), "%Y%m%dT%H%M%SZ", &tm);
    std::random_device rd;
    char suffix[16];
    std::snprintf(suffix, sizeof(suffix), "%08x", static_cast<unsigned>(rd()));
    return std::string("take_") + stamp + "_" + suffix;
}

// A bench bundle: N mono tracks, each with one clip of the same generated
// sine (seconds + 1 s long), committed as one plan revision.
void generateBenchBundle(const fs::path& bundle, std::int64_t tracks, std::int64_t seconds, std::int64_t rate,
                         const std::string& actor, const std::string& time) {
    session::Session s = session::Session::create(bundle, model::Document::create("Bench", rate), actor, time);

    const std::int64_t frames = (seconds + 1) * rate;
    media::AudioBuffer tone;
    tone.info = media::AudioInfo{1, rate, frames};
    tone.samples.resize(static_cast<std::size_t>(frames));
    const double step = 2.0 * 3.14159265358979323846 * 440.0 / static_cast<double>(rate);
    for (std::int64_t i = 0; i < frames; ++i) {
        tone.samples[static_cast<std::size_t>(i)] = static_cast<float>(0.1 * std::sin(step * static_cast<double>(i)));
    }
    std::random_device rd;
    const fs::path scratch = fs::temp_directory_path() / ("siann-bench-" + std::to_string(rd()) + std::to_string(rd()));
    fs::create_directories(scratch);
    try {
        const fs::path file = scratch / "bench-tone.wav";
        io::writeFileAtomic(file, media::encodeWavFloat32(tone));
        session::importMedia(s, file, "med_bench", actor, time);
    } catch (...) {
        std::error_code ec;
        fs::remove_all(scratch, ec);
        throw;
    }
    std::error_code ec;
    fs::remove_all(scratch, ec);

    std::vector<command::Command> commands;
    for (std::int64_t i = 1; i <= tracks; ++i) {
        const std::string n = std::to_string(i);
        commands.push_back(command::Command::fromJson(Value(Object{{"op", Value(std::string("track.add"))},
                                                                   {"trackId", Value("trk_" + n)},
                                                                   {"name", Value("Track " + n)},
                                                                   {"channels", Value(1.0)}})));
        commands.push_back(command::Command::fromJson(Value(Object{
            {"op", Value(std::string("clip.place"))},
            {"clipId", Value("clp_" + n)},
            {"trackId", Value("trk_" + n)},
            {"mediaId", Value(std::string("med_bench"))},
            {"position", Value(Object{{"domain", Value(std::string("audio"))}, {"value", Value(std::string("0"))}})},
            {"sourceStart", Value(std::string("0"))},
            {"length", Value(std::to_string(frames))}})));
    }
    s.commit(std::move(commands), actor, time, command::Cause::plan);
}

}  // namespace

Value cmdDevices() {
#if defined(SIANN_CLI_WITH_JUCE)
    Array devices;
    for (const host::DeviceDescription& d : host::JuceAudioDevice::listOutputDevices()) {
        devices.push_back(Value(Object{{"id", Value(d.type + "/" + d.name)},
                                       {"type", Value(d.type)},
                                       {"name", Value(d.name)},
                                       {"isDefault", Value(d.isDefault)}}));
    }
    return ok({{"devices", Value(std::move(devices))}});
#else
    throw noAudioBackend();
#endif
}

Value cmdPlay(const Args& args, const std::atomic<bool>* interrupt) {
    const fs::path bundle = pathFromUtf8(args.at(1, "bundle"));
    const std::optional<std::int64_t> seconds =
        args.option("seconds") ? std::optional<std::int64_t>(positiveOption(args, "seconds", 0)) : std::nullopt;
    const auto buffer = static_cast<int>(positiveOption(args, "buffer", kDefaultBufferFrames));
    std::unique_ptr<host::AudioDevice> device = openDevice(args, buffer);

    session::Session s = session::Session::open(bundle);
    const model::Document& document = s.history().head().document;
    const std::int64_t sessionRate = document.root().sampleRate;
    const std::int64_t end = engine::documentEnd(document);

    RealtimeRun run(s, std::move(device), true, fakeDeviceChoice(args).callbackNanos);
    run.start(deviceIdOf(args), buffer, 0, [seconds, end, sessionRate](std::int64_t deviceRate) {
        // A device that reports no rate runs at the session rate (as the driver assumes).
        const std::int64_t rate = deviceRate > 0 ? deviceRate : sessionRate;
        return seconds ? *seconds * rate : toDeviceFrames(end, sessionRate, rate);
    });
    run.wait(interrupt);
    run.stop();

    Object out{{"bundle", Value(pathToUtf8(bundle))}};
    run.report(out);
    return ok(std::move(out));
}

Value cmdRecord(const Args& args, const std::atomic<bool>* interrupt) {
    const fs::path bundle = pathFromUtf8(args.at(1, "bundle"));
    const std::string trackId = args.required("track");
    const std::optional<std::int64_t> seconds =
        args.option("seconds") ? std::optional<std::int64_t>(positiveOption(args, "seconds", 0)) : std::nullopt;
    const auto buffer = static_cast<int>(positiveOption(args, "buffer", kDefaultBufferFrames));
    const std::string takeId = args.option("take-id").value_or(generatedTakeId());
    std::unique_ptr<host::AudioDevice> device = openDevice(args, buffer);

    session::Session s = session::Session::open(bundle);
    const model::Document& document = s.history().head().document;
    const model::Track* track = document.track(trackId);
    if (track == nullptr) {
        throw session::SessionError("track_not_found", "no track with id " + trackId);
    }
    const int channels = track->channels;
    const std::int64_t sessionRate = document.root().sampleRate;

    // Declared before the recorder, whose callbacks use them until it stops.
    std::atomic<bool> startNotRecorded{false};
    ReadyFile ready(args.option("ready-file") ? pathFromUtf8(*args.option("ready-file")) : fs::path(), takeId);

    // Declared before the run: the driver refers to it until it stops.
    // --seconds count from the start of the transport: the recorder captures
    // exactly S seconds of session frames, mid-block if needed.
    realtime::Recorder::Options recorderOptions;
    // The ring covers the writer's stalls in wall time: a fake device paced N
    // times faster than real time fills it N times sooner (capped, so a very
    // fast run does not preallocate gigabytes; an overflow still ends the take).
    constexpr std::int64_t kMaxRingScale = 16;
    recorderOptions.ringFrames *= static_cast<std::size_t>(std::min(fakeDeviceChoice(args).speed, kMaxRingScale));
    if (seconds) {
        recorderOptions.maxFrames = *seconds * sessionRate;
    }
    realtime::Recorder recorder(channels, recorderOptions);

    // 1. Recorder attached while the driver is stopped; the device starts
    //    with the transport stopped, so the record offset is known first.
    RealtimeRun run(s, std::move(device), false, fakeDeviceChoice(args).callbackNanos);
    run.engine().driver().attachRecorder(&recorder);
    run.start(deviceIdOf(args), buffer, channels);

    // 2. The manifest is durable before any audio exists.
    session::TakeManifest manifest;
    manifest.takeId = takeId;
    manifest.trackId = trackId;
    manifest.channels = channels;
    manifest.sampleRate = sessionRate;
    manifest.recordOffset = run.engine().driver().latency().recordOffsetFrames;
    const fs::path audio = session::beginTake(s, manifest);

    // 3. The writer thread marks the take's start before writing its first
    //    frame, and reports each checkpoint to the ready file.
    recorder.start(
        audio, sessionRate,
        [bundle, takeId, &startNotRecorded, &ready](std::int64_t startPosition) {
            try {
                session::markTakeStart(bundle, takeId, startPosition);
            } catch (...) {
                startNotRecorded.store(true);  // the commit then reports take_has_no_audio
                return;
            }
            ready.started(startPosition);
        },
        [&ready](std::int64_t durableFrames) { ready.checkpointed(durableFrames); });

    // 4. Play; 5. run until the recorder holds --seconds of session frames, an
    //    overflow has ended the take, or until interrupted. The device run is
    //    only bounded above, a second past the take, in case the device
    //    delivers fewer frames (SRC).
    run.engine().transport().play();
    run.waitUntilPlaying(interrupt);
    if (seconds) {
        // A device that reports no rate runs at the session rate (as the driver assumes).
        const std::int64_t rate = run.deviceRate() > 0 ? run.deviceRate() : sessionRate;
        run.runFor((*seconds + 1) * rate);
    }
    run.wait(interrupt, [&recorder] { return recorder.captureEnded(); });

    // 6. Stop, then commit the take as one revision.
    run.engine().transport().stop();
    const realtime::Recorder::Result result = recorder.stop();
    run.stop();
    run.engine().driver().attachRecorder(nullptr);
    // A pointer, not a reference: GCC flags a reference as dangling (-Wdangling-reference).
    const command::Revision* revision = &session::commitTake(s, takeId, actorOf(args), timeOf(args));

    Object out{{"bundle", Value(pathToUtf8(bundle))},
               {"revision", revisionJson(*revision)},
               {"takeId", Value(takeId)},
               {"trackId", Value(trackId)},
               {"frames", decimal(result.frames)},
               {"startPosition", decimal(result.startPosition)},
               {"recordOffset", decimal(manifest.recordOffset)},
               {"overflows", decimal(result.overflows)}};
    run.report(out);
    return ok(std::move(out));
}

Value cmdRecover(const Args& args) {
    session::Session s = session::Session::open(pathFromUtf8(args.at(1, "bundle")));
    const std::string& takeId = args.at(2, "take id");
    // A pointer, not a reference: GCC flags a reference as dangling (-Wdangling-reference).
    const command::Revision* revision = &session::commitTake(s, takeId, actorOf(args), timeOf(args));
    return ok({{"takeId", Value(takeId)}, {"revision", revisionJson(*revision)}});
}

Object benchTiming(const CallbackTimer& timer) {
    if (timer.callbacks() == 0) {
        throw CliError("bench_no_callbacks", "the device ran no callback");
    }
    if (timer.unmeasured() > 0) {
        throw CliError("bench_rate_unknown",
                       "the device reported no sample rate, so callbacks cannot be checked against a deadline");
    }
    return Object{{"callbacks", decimal(timer.callbacks())},
                  // Deadline misses: callbacks longer than their buffer period.
                  {"xruns", decimal(timer.misses())},
                  {"maxCallbackMicros", Value(static_cast<double>(timer.maxCallbackNanos()) / 1'000.0)}};
}

Value cmdBench(const Args& args, const std::atomic<bool>* interrupt) {
    const fs::path bundle = pathFromUtf8(args.at(1, "bundle"));
    const std::int64_t tracks = requiredPositive(args, "tracks");
    const auto buffer = static_cast<int>(requiredPositive(args, "buffer"));
    const std::int64_t seconds = requiredPositive(args, "seconds");
    const std::int64_t rate = positiveOption(args, "rate", 48'000);
    if (args.option("fake-callback-nanos") || args.option("fake-report-rate")) {
        // bench measures real callbacks against a real device rate.
        throw UsageError("bench does not take --fake-callback-nanos or --fake-report-rate");
    }
    std::unique_ptr<host::AudioDevice> device = openDevice(args, buffer);  // no_audio_backend before anything is written

    const bool generate = !fs::exists(bundle);
    if (generate) {
        generateBenchBundle(bundle, tracks, seconds, rate, actorOf(args), timeOf(args));
    }
    session::Session s = session::Session::open(bundle);
    const model::Document& document = s.history().head().document;
    const auto existing = static_cast<std::int64_t>(document.tracksInOrder().size());
    if (existing != tracks) {
        throw CliError("bench_track_mismatch", "the bundle has " + std::to_string(existing) + " tracks, not " +
                                                   std::to_string(tracks));
    }

    RealtimeRun run(s, std::move(device), true, fakeDeviceChoice(args).callbackNanos);
    // Without a device rate the run length is 0 frames and bench fails below.
    run.start(deviceIdOf(args), buffer, 0, [seconds](std::int64_t deviceRate) { return seconds * deviceRate; });
    if (run.deviceRate() <= 0) {
        throw CliError("bench_rate_unknown", "the device reported no sample rate");
    }
    run.wait(interrupt);
    run.stop();

    Object timing = benchTiming(run.timer());
    Object out{{"bundle", Value(pathToUtf8(bundle))},
               {"generated", Value(generate)},
               {"tracks", number(tracks)},
               {"seconds", number(seconds)},
               {"bufferFrames", number(run.engine().driver().deviceStatus().bufferFrames)},
               {"deviceRate", number(run.deviceRate())},
               {"sessionRate", number(document.root().sampleRate)}};
    for (auto& field : timing) {
        out.push_back(std::move(field));
    }
    run.report(out, /*withTiming=*/false);  // bench's xruns and maxCallbackMicros are above
    return ok(std::move(out));
}

}  // namespace siann::cli::detail
