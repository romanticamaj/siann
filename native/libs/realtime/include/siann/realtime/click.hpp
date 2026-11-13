#pragma once

// The metronome (m5-ui-engine-loop-click; spec, "Realtime data flow", "Click").
//
// ClickTempo is the tempo map as the audio thread reads it: an immutable
// segment table built on the control side, handed to the graph driver like a
// graph (a pointer inbox and a retire outbox). Beat n, a quarter note of 1920
// ticks, starts at TempoMap::toAudio(n * 1920) for the session rate; the
// lookups use the same exact integer arithmetic, never allocate and never
// throw (positions are clamped to the range conversions cover).
//
// ClickSound holds the two bursts, built off the audio thread: 10 ms decaying
// sines, 1760 Hz on the accent (every fourth beat from tick 0 until a signature
// map exists) and 880 Hz otherwise.

#include <cstdint>
#include <memory>
#include <vector>

#include "siann/time/tempo_map.hpp"
#include "siann/time/wide_int.hpp"

namespace siann::realtime {

// The click state the protocol reports: on or off, and its gain.
struct ClickSettings {
    static constexpr std::int32_t kDefaultGainMilliDb = -12'000;
    static constexpr std::int32_t kMinGainMilliDb = -60'000;
    static constexpr std::int32_t kMaxGainMilliDb = 0;

    bool enabled = false;
    std::int32_t gainMilliDb = kDefaultGainMilliDb;

    friend bool operator==(const ClickSettings&, const ClickSettings&) = default;
};

class ClickTempo {
public:
    // Control side. Throws time::TimeError for a tempo map TempoMap rejects.
    static std::unique_ptr<const ClickTempo> build(const std::vector<time::TempoPoint>& points,
                                                   std::int64_t sampleRate);

    // The frame beat n starts at, n >= 0 (clamped to the convertible range).
    std::int64_t beatFrame(std::int64_t beat) const noexcept;
    // The first beat starting at or after `frame`.
    std::int64_t firstBeatAtOrAfter(std::int64_t frame) const noexcept;

    std::int64_t sampleRate() const noexcept { return sampleRate_; }

private:
    struct Segment {
        std::int64_t startTick = 0;
        std::uint64_t superclocksPerQuarter = 0;
        time::detail::U128 startScaled;  // superclocks times ticks per quarter
        double startFrame = 0.0;         // estimate, for the search only
        double framesPerTick = 0.0;
    };

    ClickTempo() = default;

    std::int64_t sampleRate_ = 48'000;
    std::vector<Segment> segments_;
};

struct ClickSound {
    std::vector<float> accent;
    std::vector<float> normal;

    // Control side: the bursts at the session rate.
    static ClickSound build(std::int64_t sampleRate);
};

// Linear amplitude of a click gain in milli-dB.
float clickGain(std::int32_t gainMilliDb) noexcept;

}  // namespace siann::realtime
