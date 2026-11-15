// The BS.1770-4 loudness meter (m5b-engine-load-loudness, architecture spec
// "siann-dsp"). The signals are synthesized here from their published
// definitions, EBU Tech 3341 v3 table 1 (1 kHz stereo sine, in phase, levels in
// dBFS peak per channel), and the expectations are that document's, never the
// meter's own output. The 48 kHz K-weighting coefficients are compared with the
// table of ITU-R BS.1770-4 Annex 1. This binary links the realtime allocation
// guard: process() under ScopedRealtimeThread must not allocate.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <numbers>
#include <vector>

#include "siann/dsp/loudness.hpp"
#include "siann/rt/realtime_thread.hpp"

using siann::dsp::LoudnessMeter;

namespace {

constexpr double kTolerance = 0.1;  // EBU Tech 3341: +/- 0.1 LU
constexpr double kRates[] = {44'100.0, 48'000.0, 96'000.0};

bool isMinusInfinity(double value) {
    return std::isinf(value) && value < 0.0;
}

// A 1 kHz sine on both channels, in phase, phase-continuous across segments,
// fed to the meter in calls of `chunk` frames.
class Tone {
public:
    Tone(LoudnessMeter& meter, double rate, int chunk = 4'096)
        : meter_(meter), rate_(rate), chunk_(chunk), left_(static_cast<std::size_t>(chunk)),
          right_(static_cast<std::size_t>(chunk)) {}

    // `seconds` of the tone at `dbfs` peak per channel.
    void play(double dbfs, double seconds) {
        const double amplitude = std::pow(10.0, dbfs / 20.0);
        auto remaining = static_cast<std::int64_t>(std::llround(seconds * rate_));
        while (remaining > 0) {
            const int n = static_cast<int>(std::min<std::int64_t>(remaining, chunk_));
            for (int i = 0; i < n; ++i) {
                const double phase = 2.0 * std::numbers::pi * 1'000.0 * static_cast<double>(frame_ + i) / rate_;
                const auto v = static_cast<float>(amplitude * std::sin(phase));
                left_[static_cast<std::size_t>(i)] = v;
                right_[static_cast<std::size_t>(i)] = v;
            }
            const float* channels[] = {left_.data(), right_.data()};
            meter_.process(channels, 2, n);
            frame_ += n;
            remaining -= n;
        }
    }

    // `seconds` of digital silence, through process() like any other signal.
    void silence(double seconds) {
        auto remaining = static_cast<std::int64_t>(std::llround(seconds * rate_));
        std::fill(left_.begin(), left_.end(), 0.0f);
        std::fill(right_.begin(), right_.end(), 0.0f);
        while (remaining > 0) {
            const int n = static_cast<int>(std::min<std::int64_t>(remaining, chunk_));
            const float* channels[] = {left_.data(), right_.data()};
            meter_.process(channels, 2, n);
            frame_ += n;
            remaining -= n;
        }
    }

private:
    LoudnessMeter& meter_;
    double rate_;
    int chunk_;
    std::vector<float> left_;
    std::vector<float> right_;
    std::int64_t frame_ = 0;
};

struct Segment {
    double dbfs;
    double seconds;
};

double integratedOf(double rate, const std::vector<Segment>& segments) {
    LoudnessMeter meter(rate, 2);
    Tone tone(meter, rate);
    for (const Segment& s : segments) {
        tone.play(s.dbfs, s.seconds);
    }
    return meter.integrated();
}

}  // namespace

TEST_CASE("EBU Tech 3341 case 1: a -23 dBFS 1 kHz stereo sine reads -23.0 LUFS on all three values",
          "[dsp][loudness][conformance]") {
    for (const double rate : kRates) {
        INFO("rate " << rate);
        LoudnessMeter meter(rate, 2);
        Tone tone(meter, rate);
        tone.play(-23.0, 20.0);
        CHECK(std::abs(meter.momentary() - -23.0) <= kTolerance);
        CHECK(std::abs(meter.shortTerm() - -23.0) <= kTolerance);
        CHECK(std::abs(meter.integrated() - -23.0) <= kTolerance);
    }
}

TEST_CASE("EBU Tech 3341 case 2: a -33 dBFS sine reads -33.0 LUFS", "[dsp][loudness][conformance]") {
    for (const double rate : kRates) {
        INFO("rate " << rate);
        LoudnessMeter meter(rate, 2);
        Tone tone(meter, rate);
        tone.play(-33.0, 20.0);
        CHECK(std::abs(meter.momentary() - -33.0) <= kTolerance);
        CHECK(std::abs(meter.shortTerm() - -33.0) <= kTolerance);
        CHECK(std::abs(meter.integrated() - -33.0) <= kTolerance);
    }
}

TEST_CASE("EBU Tech 3341 gating cases 3 to 5 read -23.0 LUFS integrated", "[dsp][loudness][conformance]") {
    for (const double rate : kRates) {
        INFO("rate " << rate);
        // Case 3: the relative gate drops the quiet ends.
        CHECK(std::abs(integratedOf(rate, {{-36.0, 10.0}, {-23.0, 60.0}, {-36.0, 10.0}}) - -23.0) <= kTolerance);
        // Case 4: the absolute gate drops -72, the relative gate -36.
        CHECK(std::abs(integratedOf(rate, {{-72.0, 10.0}, {-36.0, 10.0}, {-23.0, 60.0}, {-36.0, 10.0}, {-72.0, 10.0}}) -
                       -23.0) <= kTolerance);
        // Case 5: -26, -20, -26 dBFS for 20, 20.1 and 20 s.
        CHECK(std::abs(integratedOf(rate, {{-26.0, 20.0}, {-20.0, 20.1}, {-26.0, 20.0}}) - -23.0) <= kTolerance);
    }
}

TEST_CASE("the 48 kHz K-weighting equals the table of BS.1770-4 Annex 1", "[dsp][loudness][conformance]") {
    const siann::dsp::KWeighting k = siann::dsp::kWeighting(48'000.0);
    constexpr double eps = 1e-9;
    // Stage 1, the pre-filter (high shelf).
    CHECK(std::abs(k.shelf.b0 - 1.53512485958697) <= eps);
    CHECK(std::abs(k.shelf.b1 - -2.69169618940638) <= eps);
    CHECK(std::abs(k.shelf.b2 - 1.19839281085285) <= eps);
    CHECK(std::abs(k.shelf.a1 - -1.69065929318241) <= eps);
    CHECK(std::abs(k.shelf.a2 - 0.73248077421585) <= eps);
    // Stage 2, the RLB high-pass.
    CHECK(std::abs(k.highPass.b0 - 1.0) <= eps);
    CHECK(std::abs(k.highPass.b1 - -2.0) <= eps);
    CHECK(std::abs(k.highPass.b2 - 1.0) <= eps);
    CHECK(std::abs(k.highPass.a1 - -1.99004745483398) <= eps);
    CHECK(std::abs(k.highPass.a2 - 0.99007225036621) <= eps);
}

TEST_CASE("silence reads minus infinity on all three values", "[dsp][loudness]") {
    for (const double rate : kRates) {
        INFO("rate " << rate);
        LoudnessMeter fresh(rate, 2);
        CHECK(isMinusInfinity(fresh.momentary()));
        CHECK(isMinusInfinity(fresh.shortTerm()));
        CHECK(isMinusInfinity(fresh.integrated()));

        LoudnessMeter meter(rate, 2);
        Tone tone(meter, rate);
        tone.silence(5.0);
        CHECK(isMinusInfinity(meter.momentary()));
        CHECK(isMinusInfinity(meter.shortTerm()));
        CHECK(isMinusInfinity(meter.integrated()));

        LoudnessMeter skipped(rate, 2);
        skipped.processSilence(static_cast<int>(rate) * 5);
        CHECK(isMinusInfinity(skipped.momentary()));
        CHECK(isMinusInfinity(skipped.integrated()));
    }
}

TEST_CASE("silence after a signal: momentary and short-term return to minus infinity, integrated holds",
          "[dsp][loudness]") {
    for (const double rate : kRates) {
        INFO("rate " << rate);
        SECTION("silence through process()") {
            LoudnessMeter meter(rate, 2);
            Tone tone(meter, rate);
            tone.play(-23.0, 5.0);
            const double integrated = meter.integrated();
            REQUIRE(std::abs(integrated - -23.0) <= kTolerance);
            tone.silence(4.0);
            CHECK(isMinusInfinity(meter.momentary()));
            CHECK(isMinusInfinity(meter.shortTerm()));
            CHECK(meter.integrated() == integrated);
        }
        SECTION("silence as processSilence()") {
            LoudnessMeter meter(rate, 2);
            Tone tone(meter, rate);
            tone.play(-23.0, 5.0);
            const double integrated = meter.integrated();
            meter.processSilence(static_cast<int>(rate) * 4);
            CHECK(isMinusInfinity(meter.momentary()));
            CHECK(isMinusInfinity(meter.shortTerm()));
            CHECK(meter.integrated() == integrated);
            // The tone again: the integrated value goes on from where it was.
            tone.play(-23.0, 5.0);
            CHECK(std::abs(meter.integrated() - -23.0) <= kTolerance);
        }
    }
}

TEST_CASE("reset restarts the integrated value and leaves momentary and short-term", "[dsp][loudness]") {
    const double rate = 48'000.0;
    LoudnessMeter meter(rate, 2);
    Tone tone(meter, rate);
    tone.play(-23.0, 10.0);
    const double momentary = meter.momentary();
    const double shortTerm = meter.shortTerm();
    meter.reset();
    CHECK(isMinusInfinity(meter.integrated()));
    CHECK(meter.momentary() == momentary);
    CHECK(meter.shortTerm() == shortTerm);
    // Only what follows the reset counts: a -33 dBFS tone reads -33, not a mix.
    tone.play(-33.0, 10.0);
    CHECK(std::abs(meter.integrated() - -33.0) <= kTolerance);
}

TEST_CASE("the readings do not depend on the size of the process() calls", "[dsp][loudness]") {
    const double rate = 48'000.0;
    const auto run = [&](int chunk) {
        LoudnessMeter meter(rate, 2);
        Tone tone(meter, rate, chunk);
        tone.play(-36.0, 3.3);
        tone.play(-23.0, 4.1);
        tone.silence(0.7);
        tone.play(-30.0, 2.05);
        return std::vector<double>{meter.momentary(), meter.shortTerm(), meter.integrated()};
    };
    const std::vector<double> reference = run(4'096);
    for (const int chunk : {64, 480, 1, 7, 333, 4'799, 4'801}) {
        INFO("chunk " << chunk);
        CHECK(run(chunk) == reference);
    }
}

TEST_CASE("a mono feed into a stereo meter counts one channel", "[dsp][loudness]") {
    // BS.1770: the sum over channels of their mean squares. One channel of a
    // -23 dBFS sine carries half the energy of two: 3.01 LU less.
    const double rate = 48'000.0;
    LoudnessMeter meter(rate, 2);
    std::vector<float> left(4'800);
    std::int64_t frame = 0;
    const double amplitude = std::pow(10.0, -23.0 / 20.0);
    for (int block = 0; block < 100; ++block) {
        for (std::size_t i = 0; i < left.size(); ++i) {
            left[i] = static_cast<float>(amplitude * std::sin(2.0 * std::numbers::pi * 1'000.0 *
                                                              static_cast<double>(frame++) / rate));
        }
        const float* channels[] = {left.data()};
        meter.process(channels, 1, static_cast<int>(left.size()));
    }
    CHECK(std::abs(meter.integrated() - (-23.0 - 10.0 * std::log10(2.0))) <= kTolerance);
}

TEST_CASE("process, processSilence and reset do not allocate on a realtime thread", "[dsp][loudness][alloc]") {
    const double rate = 48'000.0;
    LoudnessMeter meter(rate, 2);
    std::vector<float> left(480, 0.25f);
    std::vector<float> right(480, -0.25f);
    const float* channels[] = {left.data(), right.data()};
    const std::uint64_t before = siann::rt::allocationViolations();
    {
        siann::rt::ScopedRealtimeThread realtime;
        for (int i = 0; i < 2'000; ++i) {  // 20 s: thousands of gating blocks
            meter.process(channels, 2, 480);
        }
        meter.processSilence(48'000);
        meter.reset();
        meter.process(channels, 2, 480);
        (void)meter.momentary();
        (void)meter.shortTerm();
        (void)meter.integrated();
    }
    CHECK(siann::rt::allocationViolations() == before);
}
