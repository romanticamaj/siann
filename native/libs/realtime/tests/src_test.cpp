// Device-side sample-rate conversion (architecture spec, "Device-side SRC
// (M2)"). The limits come from the spec's Tests bullet: +/-0.1 dB at 1, 10 and
// 18 kHz, residual below -96 dB, impulses on the expected sample +/-1.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <numbers>
#include <random>
#include <span>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/media/audio.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/realtime/recorder.hpp"
#include "siann/realtime/stream_resampler.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "support/signal_metrics.hpp"

namespace fs = std::filesystem;
using namespace siann;
using realtime::GraphDriver;
using realtime::Recorder;
using realtime::StreamResampler;

namespace {

constexpr int kBlock = 64;
constexpr float kAmplitude = 0.5f;

struct RatePair {
    std::int64_t session;
    std::int64_t device;
};
constexpr RatePair kUp{44'100, 48'000};    // session 44.1 kHz on a 48 kHz device
constexpr RatePair kDown{48'000, 44'100};  // session 48 kHz on a 44.1 kHz device

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-src-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    const fs::path& path() const { return path_; }

private:
    fs::path path_;
};

std::shared_ptr<graph::PlanarAudio> sineMedia(double frequency, std::int64_t rate, std::int64_t frames) {
    auto audio = std::make_shared<graph::PlanarAudio>();
    audio->channels = 2;
    audio->frames = frames;
    audio->data.assign(2, std::vector<float>(static_cast<std::size_t>(frames)));
    for (std::int64_t i = 0; i < frames; ++i) {
        const double phase = 2.0 * std::numbers::pi * frequency * static_cast<double>(i) / static_cast<double>(rate);
        const auto v = static_cast<float>(kAmplitude * std::sin(phase));
        audio->data[0][static_cast<std::size_t>(i)] = v;
        audio->data[1][static_cast<std::size_t>(i)] = v;
    }
    return audio;
}

std::unique_ptr<graph::PreparedGraph> clipGraph(std::vector<graph::ClipPlayerNode::Clip> clips) {
    graph::GraphBuilder b;
    b.setOutput(b.add(std::make_unique<graph::ClipPlayerNode>(2, std::move(clips)), "clips"));
    return std::move(b).compile(kBlock);
}

std::unique_ptr<graph::PreparedGraph> sineGraph(double frequency, std::int64_t rate, std::int64_t frames) {
    return clipGraph({{0, 0, frames, 1.0f, sineMedia(frequency, rate, frames)}});
}

std::unique_ptr<graph::PreparedGraph> impulseGraph(std::int64_t position) {
    auto impulse = std::make_shared<graph::PlanarAudio>();
    impulse->channels = 1;
    impulse->frames = 1;
    impulse->data = {{1.0f}};
    return clipGraph({{position, 0, 1, 1.0f, impulse}});
}

host::AudioDeviceConfig config(std::int64_t sessionRate, int bufferFrames, int inputs = 0) {
    host::AudioDeviceConfig c;
    c.sampleRate = sessionRate;
    c.bufferFrames = bufferFrames;
    c.inputChannels = inputs;
    c.outputChannels = 2;
    return c;
}

host::ManualAudioDevice::Options fixedRate(std::int64_t rate) {
    host::ManualAudioDevice::Options options;
    options.fixedSampleRate = rate;
    return options;
}

struct Played {
    std::vector<float> output;  // channel 0 at the device rate
    realtime::LatencyReport latency;
    std::uint64_t xruns = 0;
    std::uint64_t allocations = 0;  // allocation-guard violations while pumping
};

// Plays `graph` from timeline 0 on a manual device fixed at `rates.device`
// with the session at `rates.session`, for at least `deviceFrames`.
Played play(std::unique_ptr<graph::PreparedGraph> graph, RatePair rates, int deviceBlock, std::int64_t deviceFrames) {
    GraphDriver driver({});
    driver.publish(std::move(graph));
    host::ManualAudioDevice device(fixedRate(rates.device));
    driver.play();
    driver.start(device, config(rates.session, deviceBlock));
    Played played;
    played.latency = driver.latency();
    const auto before = rt::allocationViolations();
    device.pump(static_cast<int>((deviceFrames + deviceBlock - 1) / deviceBlock), &played.output);
    played.allocations = rt::allocationViolations() - before;
    played.xruns = driver.xruns();
    driver.stop();
    return played;
}

media::AudioBuffer readWav(const fs::path& file) {
    std::ifstream in(file, std::ios::binary);
    return media::decodeWav(std::string(std::istreambuf_iterator<char>(in), {}));
}

// Channel 0 of an interleaved take.
std::vector<float> channel0(const media::AudioBuffer& take) {
    std::vector<float> out(static_cast<std::size_t>(take.info.frames));
    for (std::size_t i = 0; i < out.size(); ++i) {
        out[i] = take.samples[i * static_cast<std::size_t>(take.info.channels)];
    }
    return out;
}

// Records channel 0 of the device input (generated at the device rate) through
// the input SRC; the recorder is armed before the first callback.
Recorder::Result record(RatePair rates, std::function<float(int, std::int64_t)> generator, std::int64_t deviceFrames,
                        const fs::path& file, std::uint64_t* allocations) {
    GraphDriver driver({});
    driver.publish(clipGraph({}));
    Recorder::Options options;
    options.writerThread = false;
    Recorder recorder(1, options);
    driver.attachRecorder(&recorder);
    host::ManualAudioDevice device(fixedRate(rates.device));
    device.setInputGenerator(std::move(generator));
    recorder.start(file, rates.session);
    driver.play();
    constexpr int block = 128;
    driver.start(device, config(rates.session, block, 1));
    const auto before = rt::allocationViolations();
    for (std::int64_t done = 0; done < deviceFrames; done += 16 * block) {
        device.pump(16);
        recorder.drain();
    }
    *allocations = rt::allocationViolations() - before;
    auto result = recorder.stop();
    driver.stop();
    return result;
}

}  // namespace

TEST_CASE("StreamResampler is allocation-free after setup", "[src][rt]") {
    for (const auto rates : {kUp, kDown}) {
        StreamResampler src(static_cast<double>(rates.session), static_cast<double>(rates.device), 2, 64);
        REQUIRE(src.lookaheadFrames() > 0);
        REQUIRE(src.maxOutputFrames() >= 64 * rates.device / rates.session);
        std::vector<std::vector<float>> in(2, std::vector<float>(64));
        std::vector<std::vector<float>> out(2, std::vector<float>(static_cast<std::size_t>(src.maxOutputFrames())));
        const float* inPointers[2] = {in[0].data(), in[1].data()};
        float* outPointers[2] = {out[0].data(), out[1].data()};
        const auto before = rt::allocationViolations();
        std::int64_t produced = 0;
        {
            const rt::ScopedRealtimeThread realtime;
            for (int block = 0; block < 10'000; ++block) {
                for (int i = 0; i < 64; ++i) {
                    in[0][static_cast<std::size_t>(i)] = static_cast<float>((block * 64 + i) % 101) / 101.0f;
                    in[1][static_cast<std::size_t>(i)] = -in[0][static_cast<std::size_t>(i)];
                }
                const int n = src.process(inPointers, 64, outPointers);
                REQUIRE(n >= 0);
                REQUIRE(n <= src.maxOutputFrames());
                produced += n;
            }
        }
        CHECK(rt::allocationViolations() == before);
        // Every input frame past the lookahead comes out at the new rate.
        const std::int64_t expected = (640'000 - src.lookaheadFrames()) * rates.device / rates.session;
        CHECK(std::llabs(produced - expected) <= 2);
    }
}

TEST_CASE("Sine through output SRC keeps amplitude and is clean", "[src]") {
    for (const auto rates : {kUp, kDown}) {
        for (const double frequency : {1'000.0, 10'000.0, 18'000.0}) {
            INFO("session " << rates.session << " Hz, device " << rates.device << " Hz, tone " << frequency << " Hz");
            const auto played = play(sineGraph(frequency, rates.session, 3 * rates.session), rates, 128,
                                     2 * rates.device);
            CHECK(played.allocations == 0);
            CHECK(played.xruns == 0);
            REQUIRE(static_cast<std::int64_t>(played.output.size()) >= 2 * rates.device);
            const std::span<const float> second(played.output.data() + rates.device,
                                                static_cast<std::size_t>(rates.device));
            const auto fit = test::fitSine(second, frequency, static_cast<double>(rates.device));
            INFO("amplitude " << test::toDb(fit.amplitude / kAmplitude) << " dB, residual " << fit.residualDb << " dB");
            CHECK(std::fabs(test::toDb(fit.amplitude / kAmplitude)) <= 0.1);
            CHECK(fit.residualDb <= -96.0);
        }
    }
}

TEST_CASE("Impulse through output SRC lands on the expected device sample", "[src][latency]") {
    // Session positions that are integral at both rates: 14,700 at 44.1 kHz is
    // 16,000 at 48 kHz (both 1/3 s).
    for (const auto& [rates, position] : {std::pair{kUp, std::int64_t{14'700}}, std::pair{kDown, std::int64_t{16'000}}}) {
        INFO("session " << rates.session << " Hz, device " << rates.device << " Hz");
        const auto played = play(impulseGraph(position), rates, 128, rates.device);
        CHECK(played.allocations == 0);
        // The output path delays the session by its reported latency (the
        // resampler's lookahead plus the primed FIFO block).
        const auto lead = played.latency.srcOutputLatencyFrames;
        CHECK(lead > kBlock);
        CHECK(lead < rates.session / 20);  // well under 50 ms
        const double expected =
            static_cast<double>(position + lead) * static_cast<double>(rates.device) / static_cast<double>(rates.session);
        const auto peak = test::peakIndex(played.output);
        INFO("peak at " << peak << ", expected " << expected);
        CHECK(std::fabs(static_cast<double>(peak) - expected) <= 1.0);
    }
}

TEST_CASE("Sine and impulse through input SRC", "[src][record]") {
    TempDir dir;
    for (const auto rates : {kUp, kDown}) {
        for (const double frequency : {1'000.0, 10'000.0, 18'000.0}) {
            INFO("session " << rates.session << " Hz, device " << rates.device << " Hz, tone " << frequency << " Hz");
            const auto rate = static_cast<double>(rates.device);
            std::uint64_t allocations = 0;
            const auto result = record(
                rates,
                [&](int, std::int64_t frame) {
                    return static_cast<float>(kAmplitude *
                                              std::sin(2.0 * std::numbers::pi * frequency * static_cast<double>(frame) / rate));
                },
                3 * rates.device, dir.path() / "sine.wav", &allocations);
            CHECK(allocations == 0);
            CHECK(result.overflows == 0);
            const auto take = readWav(result.file);
            CHECK(take.info.sampleRate == rates.session);
            REQUIRE(take.info.frames >= 2 * rates.session);
            const auto samples = channel0(take);
            const std::span<const float> second(samples.data() + rates.session, static_cast<std::size_t>(rates.session));
            const auto fit = test::fitSine(second, frequency, static_cast<double>(rates.session));
            INFO("amplitude " << test::toDb(fit.amplitude / kAmplitude) << " dB, residual " << fit.residualDb << " dB");
            CHECK(std::fabs(test::toDb(fit.amplitude / kAmplitude)) <= 0.1);
            CHECK(fit.residualDb <= -96.0);
        }
    }
    // An impulse at device input sample 16,000 (48 kHz) is session sample 14,700
    // (44.1 kHz), and the other way round. The take starts with the first
    // device sample: the recorder was armed before the device started.
    for (const auto& [rates, devicePosition, expected] :
         {std::tuple{kUp, std::int64_t{16'000}, std::int64_t{14'700}},
          std::tuple{kDown, std::int64_t{14'700}, std::int64_t{16'000}}}) {
        INFO("session " << rates.session << " Hz, device " << rates.device << " Hz");
        std::uint64_t allocations = 0;
        const std::int64_t at = devicePosition;
        const auto result =
            record(rates, [at](int, std::int64_t frame) { return frame == at ? 1.0f : 0.0f; }, rates.device,
                   dir.path() / "impulse.wav", &allocations);
        CHECK(allocations == 0);
        const auto samples = channel0(readWav(result.file));
        const auto peak = test::peakIndex(samples);
        INFO("peak at " << peak);
        CHECK(std::llabs(peak - expected) <= 1);
    }
}

TEST_CASE("Resampling state", "[src]") {
    GraphDriver driver({});
    driver.publish(clipGraph({}));

    host::ManualAudioDevice same;
    driver.start(same, config(44'100, kBlock));
    CHECK_FALSE(driver.resampling().active);
    CHECK(driver.resampling().deviceRate == 44'100);
    CHECK(driver.resampling().sessionRate == 44'100);
    CHECK(driver.resampling().addedLatencyFrames == 0);
    CHECK(driver.latency().srcOutputLatencyFrames == 0);
    CHECK(driver.latency().srcInputLatencyFrames == 0);
    driver.stop();

    host::ManualAudioDevice fixed(fixedRate(48'000));
    driver.start(fixed, config(44'100, kBlock, 1));
    const auto state = driver.resampling();
    const auto latency = driver.latency();
    CHECK(state.active);
    CHECK(state.deviceRate == 48'000);
    CHECK(state.sessionRate == 44'100);
    CHECK(latency.sessionRate == 44'100);
    CHECK(latency.deviceRate == 48'000);
    CHECK(latency.srcOutputLatencyFrames > 0);
    CHECK(latency.srcInputLatencyFrames > 0);
    CHECK(state.addedLatencyFrames == latency.srcOutputLatencyFrames + latency.srcInputLatencyFrames);
    CHECK(latency.recordOffsetFrames ==
          latency.outputLatencyFrames + latency.inputLatencyFrames + state.addedLatencyFrames);
    driver.stop();

    host::ManualAudioDevice again;
    driver.start(again, config(44'100, kBlock));
    CHECK_FALSE(driver.resampling().active);
    CHECK(driver.resampling().addedLatencyFrames == 0);
    driver.stop();
}

TEST_CASE("Device blocks larger and smaller than the graph block give the same output", "[src]") {
    for (const auto rates : {kUp, kDown}) {
        INFO("session " << rates.session << " Hz, device " << rates.device << " Hz");
        const std::int64_t frames = rates.device / 2;
        const auto reference = play(sineGraph(1'000.0, rates.session, rates.session), rates, kBlock, frames);
        CHECK(reference.xruns == 0);
        for (const int deviceBlock : {32, 256, 100}) {
            INFO("device block " << deviceBlock);
            const auto played = play(sineGraph(1'000.0, rates.session, rates.session), rates, deviceBlock, frames);
            CHECK(played.xruns == 0);
            CHECK(played.allocations == 0);
            CHECK(played.latency.srcOutputLatencyFrames == reference.latency.srcOutputLatencyFrames);
            REQUIRE(played.output.size() >= static_cast<std::size_t>(frames));
            bool same = true;
            for (std::size_t i = 0; i < static_cast<std::size_t>(frames) && same; ++i) {
                same = played.output[i] == reference.output[i];
            }
            CHECK(same);
        }
    }
}
