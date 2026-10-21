#pragma once

// Tempo map with constant-tempo segments and step changes (M1). Ramps are part
// of the model but rejected until implemented.
//
// Conversions are exact integer arithmetic through superclocks and round to
// nearest, ties to even, so results are bit-identical on every platform. They
// must match fixtures/time/conversions.json.

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

#include "siann/time/time.hpp"
#include "siann/time/wide_int.hpp"

namespace siann::time {

// Tempo is stored as integer milli-BPM: 120 BPM is 120000.
inline constexpr std::int32_t kMinMilliBpm = 1'000;
inline constexpr std::int32_t kMaxMilliBpm = 999'999;

enum class TempoShape { step, ramp };

struct TempoPoint {
    MusicTime position;
    std::int32_t milliBpm = 120'000;
    TempoShape shape = TempoShape::step;
};

class TimeError : public std::runtime_error {
public:
    TimeError(std::string code, const std::string& message);

    // One of: empty_tempo_map, first_tempo_not_at_zero, unsorted_tempo_points,
    // tempo_out_of_range, unsupported_tempo_ramp, invalid_sample_rate,
    // position_out_of_range.
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

// Superclocks per quarter note for a tempo, rounded to nearest, ties to even.
std::int64_t superclocksPerQuarter(std::int32_t milliBpm);

class TempoMap {
public:
    // Validates: non-empty, first point at tick 0, strictly increasing ticks,
    // tempos in range, step shape only.
    explicit TempoMap(std::vector<TempoPoint> points);

    static TempoMap constant(std::int32_t milliBpm);

    const std::vector<TempoPoint>& points() const noexcept { return points_; }

    // Positions before tick 0 extend the first tempo backwards.
    AudioTime toAudio(MusicTime position, std::int64_t sampleRate) const;
    MusicTime toMusic(AudioTime position, std::int64_t sampleRate) const;

private:
    struct Segment {
        std::int64_t startTick = 0;
        std::uint64_t superclocksPerQuarter = 0;
        // Exact start of the segment in superclocks times kTicksPerQuarter.
        detail::U128 startScaled;
    };

    std::vector<TempoPoint> points_;
    std::vector<Segment> segments_;
};

}  // namespace siann::time
