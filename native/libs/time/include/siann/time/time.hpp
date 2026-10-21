#pragma once

// Time domains (architecture spec, "Time model"). Storage is always integer;
// timecode, bars|beats and seconds are display formats only.

#include <compare>
#include <cstdint>

namespace siann::time {

// Musical resolution: ticks per quarter note.
inline constexpr std::int64_t kTicksPerQuarter = 1920;

// Internal exact time unit: 282,240,000 per second, divisible by every common
// sample rate (44.1k, 48k and their multiples up to 384k).
inline constexpr std::int64_t kSuperclockRate = 282'240'000;

// Sample rates accepted by conversions.
inline constexpr std::int64_t kMinSampleRate = 8'000;
inline constexpr std::int64_t kMaxSampleRate = 768'000;

// Positions handled by conversions, in either domain: about 1,000 days at
// 48 kHz, and far beyond any session at 1920 ticks per quarter.
inline constexpr std::int64_t kMaxPositionMagnitude = std::int64_t{1} << 42;

struct AudioTime {
    std::int64_t samples = 0;
    friend constexpr auto operator<=>(const AudioTime&, const AudioTime&) = default;
};

struct MusicTime {
    std::int64_t ticks = 0;
    friend constexpr auto operator<=>(const MusicTime&, const MusicTime&) = default;
};

enum class Domain { audio, music };

// A domain-tagged position, as stored in the document.
struct Position {
    Domain domain = Domain::audio;
    std::int64_t value = 0;

    static constexpr Position audio(std::int64_t samples) noexcept { return {Domain::audio, samples}; }
    static constexpr Position music(std::int64_t ticks) noexcept { return {Domain::music, ticks}; }

    friend constexpr bool operator==(const Position&, const Position&) = default;
};

}  // namespace siann::time
