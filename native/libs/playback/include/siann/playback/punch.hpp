#pragma once

// Pre-roll and count-in arithmetic on the tempo map (m5b-engine-punch-count-in;
// architecture spec, "Recording" (f) and "Click"). A bar is four quarter notes
// (1920 ticks each) until a signature map exists (E-10). Control side only.

#include <cstdint>
#include <vector>

#include "siann/time/tempo_map.hpp"

namespace siann::playback {

// Quarter notes in a bar until a signature map exists.
inline constexpr std::int32_t kBeatsPerBar = 4;

// The frame pre-roll starts playback at: tick(position) - bars x 4 x 1920 on the
// tempo map, clamped at 0. Throws time::TimeError for a map TempoMap rejects.
std::int64_t prerollStart(const std::vector<time::TempoPoint>& tempo, std::int64_t sampleRate,
                          std::int64_t position, std::int32_t bars);

// Session frames in one quarter note at the tempo in effect at `frame` (a
// fraction): the count-in's beat spacing.
double beatFramesAt(const std::vector<time::TempoPoint>& tempo, std::int64_t sampleRate, std::int64_t frame);

}  // namespace siann::playback
