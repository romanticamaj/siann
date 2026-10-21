#include <catch2/catch_test_macros.hpp>

#include <string>

#include "siann/time/tempo_map.hpp"

using siann::time::AudioTime;
using siann::time::MusicTime;
using siann::time::TempoMap;
using siann::time::TempoPoint;
using siann::time::TempoShape;
using siann::time::TimeError;
using siann::time::kMaxPositionMagnitude;
using siann::time::superclocksPerQuarter;

namespace {

std::string errorCode(auto&& fn) {
    try {
        fn();
    } catch (const TimeError& error) {
        return error.code();
    }
    return "no error";
}

std::int64_t samplesAt(const TempoMap& map, std::int64_t ticks, std::int64_t rate) {
    return map.toAudio(MusicTime{ticks}, rate).samples;
}

std::int64_t ticksAt(const TempoMap& map, std::int64_t samples, std::int64_t rate) {
    return map.toMusic(AudioTime{samples}, rate).ticks;
}

}  // namespace

TEST_CASE("Superclocks per quarter are exact for common tempos", "[time]") {
    CHECK(superclocksPerQuarter(120'000) == 141'120'000);  // 0.5 s
    CHECK(superclocksPerQuarter(60'000) == 282'240'000);   // 1 s
    CHECK(superclocksPerQuarter(140'000) == 120'960'000);
}

TEST_CASE("Superclocks per quarter round ties to even", "[time]") {
    // 16,934,400,000,000 / 65,536 = 258,398,437.5 -> 258,398,438 (odd floor rounds up)
    CHECK(superclocksPerQuarter(65'536) == 258'398'438);
    // 16,934,400,000,000 / 196,608 = 86,132,812.5 -> 86,132,812 (even floor stays)
    CHECK(superclocksPerQuarter(196'608) == 86'132'812);
}

TEST_CASE("Constant tempo converts ticks to samples with ties to even", "[time]") {
    const TempoMap map = TempoMap::constant(120'000);  // 12.5 samples per tick at 48 kHz
    CHECK(samplesAt(map, 0, 48'000) == 0);
    CHECK(samplesAt(map, 1'920, 48'000) == 24'000);
    CHECK(samplesAt(map, 1, 48'000) == 12);   // 12.5 -> 12
    CHECK(samplesAt(map, 3, 48'000) == 38);   // 37.5 -> 38
    CHECK(samplesAt(map, -1, 48'000) == -12);
    CHECK(samplesAt(map, -3, 48'000) == -38);
    CHECK(samplesAt(map, 1, 44'100) == 11);   // 11.484375
    CHECK(samplesAt(map, 1'920, 44'100) == 22'050);
    CHECK(samplesAt(TempoMap::constant(140'000), 1'920, 44'100) == 18'900);
}

TEST_CASE("Constant tempo converts samples to ticks", "[time]") {
    const TempoMap map = TempoMap::constant(120'000);
    CHECK(ticksAt(map, 24'000, 48'000) == 1'920);
    CHECK(ticksAt(map, 12, 48'000) == 1);    // 0.96
    CHECK(ticksAt(map, 25, 48'000) == 2);
    CHECK(ticksAt(map, -25, 48'000) == -2);
    CHECK(ticksAt(map, 0, 48'000) == 0);
}

TEST_CASE("Step tempo changes accumulate exactly", "[time]") {
    const TempoMap map({TempoPoint{MusicTime{0}, 120'000}, TempoPoint{MusicTime{3'840}, 60'000}});
    CHECK(samplesAt(map, 3'840, 48'000) == 48'000);
    CHECK(samplesAt(map, 5'760, 48'000) == 96'000);
    CHECK(samplesAt(map, 3'839, 48'000) == 47'988);  // 47,987.5 -> 47,988
    CHECK(ticksAt(map, 48'000, 48'000) == 3'840);
    CHECK(ticksAt(map, 72'000, 48'000) == 4'800);
    CHECK(ticksAt(map, 96'000, 48'000) == 5'760);
}

TEST_CASE("Music to audio to music is the identity when a tick spans at least one sample", "[time]") {
    const TempoMap map({TempoPoint{MusicTime{0}, 120'000}, TempoPoint{MusicTime{7'680}, 97'531},
                        TempoPoint{MusicTime{20'000}, 180'000}});
    for (std::int64_t ticks = -5'000; ticks <= 40'000; ticks += 7) {
        INFO("ticks " << ticks);
        CHECK(ticksAt(map, samplesAt(map, ticks, 48'000), 48'000) == ticks);
    }
}

TEST_CASE("Tempo map validation", "[time]") {
    CHECK(errorCode([] { TempoMap({}); }) == "empty_tempo_map");
    CHECK(errorCode([] { TempoMap({TempoPoint{MusicTime{10}, 120'000}}); }) == "first_tempo_not_at_zero");
    CHECK(errorCode([] {
              TempoMap({TempoPoint{MusicTime{0}, 120'000}, TempoPoint{MusicTime{0}, 90'000}});
          }) == "unsorted_tempo_points");
    CHECK(errorCode([] {
              TempoMap({TempoPoint{MusicTime{0}, 120'000}, TempoPoint{MusicTime{960}, 90'000},
                        TempoPoint{MusicTime{480}, 100'000}});
          }) == "unsorted_tempo_points");
    CHECK(errorCode([] { TempoMap::constant(999); }) == "tempo_out_of_range");
    CHECK(errorCode([] { TempoMap::constant(1'000'000); }) == "tempo_out_of_range");
    CHECK(errorCode([] { TempoMap({TempoPoint{MusicTime{0}, 120'000, TempoShape::ramp}}); }) ==
          "unsupported_tempo_ramp");
}

TEST_CASE("Conversion arguments are range checked", "[time]") {
    const TempoMap map = TempoMap::constant(120'000);
    CHECK(errorCode([&] { (void)map.toAudio(MusicTime{0}, 0); }) == "invalid_sample_rate");
    CHECK(errorCode([&] { (void)map.toAudio(MusicTime{0}, 7'999); }) == "invalid_sample_rate");
    CHECK(errorCode([&] { (void)map.toMusic(AudioTime{0}, 768'001); }) == "invalid_sample_rate");
    CHECK(errorCode([&] { (void)map.toAudio(MusicTime{kMaxPositionMagnitude + 1}, 48'000); }) ==
          "position_out_of_range");
    CHECK(errorCode([&] { (void)map.toMusic(AudioTime{-kMaxPositionMagnitude - 1}, 48'000); }) ==
          "position_out_of_range");
    CHECK_NOTHROW(map.toAudio(MusicTime{kMaxPositionMagnitude}, 768'000));
    CHECK_NOTHROW(map.toMusic(AudioTime{kMaxPositionMagnitude}, 8'000));
}
