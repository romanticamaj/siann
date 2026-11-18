// Pre-roll and count-in arithmetic (m5b-engine-punch-count-in; spec, "Recording"
// (f) and "Click"): the pre-roll starts playback bars x 4 quarter notes before the
// record position on the tempo map, clamped at 0, and the count-in's beats are
// spaced by the tempo at the held position. The expected frames are worked out by
// hand from the tempo (a quarter note at 120 BPM and 48 kHz is 24000 frames).

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <vector>

#include "siann/playback/punch.hpp"

using namespace siann;
using playback::beatFramesAt;
using playback::prerollStart;

namespace {

constexpr std::int64_t kRate = 48'000;

std::vector<time::TempoPoint> constant(std::int32_t milliBpm) {
    return {time::TempoPoint{time::MusicTime{0}, milliBpm}};
}

// 120 BPM for the first bar (96000 frames), then 60 BPM (a quarter is 48000 frames).
std::vector<time::TempoPoint> slowerAfterOneBar() {
    return {time::TempoPoint{time::MusicTime{0}, 120'000}, time::TempoPoint{time::MusicTime{4 * 1'920}, 60'000}};
}

}  // namespace

TEST_CASE("pre-roll start frame from the tempo map, clamped at 0", "[playback][punch][preroll]") {
    // 120 BPM: a bar is 96000 frames.
    CHECK(prerollStart(constant(120'000), kRate, 200'000, 1) == 104'000);
    CHECK(prerollStart(constant(120'000), kRate, 200'000, 2) == 8'000);
    CHECK(prerollStart(constant(120'000), kRate, 96'000, 1) == 0);
    // Clamped at 0.
    CHECK(prerollStart(constant(120'000), kRate, 50'000, 1) == 0);
    CHECK(prerollStart(constant(120'000), kRate, 0, 8) == 0);
    // Across a tempo change: R one quarter into the 60 BPM part (96000 + 48000) is
    // tick 9600; one bar earlier is tick 1920, frame 24000.
    CHECK(prerollStart(slowerAfterOneBar(), kRate, 144'000, 1) == 24'000);
    // R two bars into the 60 BPM part (96000 + 2 x 192000): one bar back is one
    // bar of 60 BPM, 192000 frames.
    CHECK(prerollStart(slowerAfterOneBar(), kRate, 480'000, 1) == 288'000);
}

TEST_CASE("the count-in's beats are spaced by the tempo at the held position", "[playback][punch][countin]") {
    CHECK(beatFramesAt(constant(120'000), kRate, 0) == 24'000.0);
    CHECK(std::fabs(beatFramesAt(constant(97'000), kRate, 123'456) - 48'000.0 * 60.0 / 97.0) < 1e-9);
    CHECK(beatFramesAt(slowerAfterOneBar(), kRate, 95'000) == 24'000.0);
    CHECK(beatFramesAt(slowerAfterOneBar(), kRate, 96'000) == 48'000.0);
    CHECK(beatFramesAt(slowerAfterOneBar(), kRate, 1'000'000) == 48'000.0);
}
