#include "siann/realtime/click.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace siann::realtime {

namespace {

using time::detail::U128;

// Superclocks times ticks-per-quarter per second of audio, as in TempoMap.
constexpr std::uint64_t kScaledPerSecond =
    static_cast<std::uint64_t>(time::kSuperclockRate) * static_cast<std::uint64_t>(time::kTicksPerQuarter);

// The last beat whose tick a conversion covers.
constexpr std::int64_t kMaxBeat = time::kMaxPositionMagnitude / time::kTicksPerQuarter;

}  // namespace

std::unique_ptr<const ClickTempo> ClickTempo::build(const std::vector<time::TempoPoint>& points,
                                                    std::int64_t sampleRate) {
    const time::TempoMap validated(points);  // throws as the document's own check does
    (void)validated.toAudio(time::MusicTime{0}, sampleRate);  // validates the rate
    auto tempo = std::unique_ptr<ClickTempo>(new ClickTempo());
    tempo->sampleRate_ = sampleRate;
    U128 scaled{};
    for (std::size_t i = 0; i < points.size(); ++i) {
        const auto scpq = static_cast<std::uint64_t>(time::superclocksPerQuarter(points[i].milliBpm));
        if (i > 0) {
            const Segment& previous = tempo->segments_.back();
            const auto span = static_cast<std::uint64_t>(points[i].position.ticks - previous.startTick);
            scaled = time::detail::add(scaled, time::detail::mul64(span, previous.superclocksPerQuarter));
        }
        Segment segment;
        segment.startTick = points[i].position.ticks;
        segment.superclocksPerQuarter = scpq;
        segment.startScaled = scaled;
        segment.startFrame =
            static_cast<double>(validated.toAudio(points[i].position, sampleRate).samples);
        segment.framesPerTick = static_cast<double>(scpq) * static_cast<double>(sampleRate) /
                                static_cast<double>(kScaledPerSecond);
        tempo->segments_.push_back(segment);
    }
    return tempo;
}

std::int64_t ClickTempo::beatFrame(std::int64_t beat) const noexcept {
    const std::int64_t ticks = std::clamp<std::int64_t>(beat, 0, kMaxBeat) * time::kTicksPerQuarter;
    std::size_t index = segments_.size() - 1;
    while (index > 0 && segments_[index].startTick > ticks) {
        --index;
    }
    const Segment& segment = segments_[index];
    // In range by construction (as TempoMap::toAudio for these ticks), so none of
    // the 128-bit helpers' overflow checks can fire.
    const auto offset = static_cast<std::uint64_t>(ticks - segment.startTick);
    const U128 scaled = time::detail::add(segment.startScaled, time::detail::mul64(offset, segment.superclocksPerQuarter));
    return static_cast<std::int64_t>(time::detail::divRoundHalfEven(
        time::detail::mul(scaled, static_cast<std::uint64_t>(sampleRate_)), kScaledPerSecond));
}

std::int64_t ClickTempo::firstBeatAtOrAfter(std::int64_t frame) const noexcept {
    if (frame <= 0) {
        return 0;
    }
    std::size_t index = segments_.size() - 1;
    while (index > 0 && segments_[index].startFrame > static_cast<double>(frame)) {
        --index;
    }
    const Segment& segment = segments_[index];
    const double tick = static_cast<double>(segment.startTick) +
                        (static_cast<double>(frame) - segment.startFrame) / segment.framesPerTick;
    std::int64_t beat = std::clamp<std::int64_t>(
        static_cast<std::int64_t>(std::floor(tick / static_cast<double>(time::kTicksPerQuarter))), 0, kMaxBeat);
    // The estimate is within a beat or two; settle it exactly.
    while (beat < kMaxBeat && beatFrame(beat) < frame) {
        ++beat;
    }
    while (beat > 0 && beatFrame(beat - 1) >= frame) {
        --beat;
    }
    return beat;
}

ClickSound ClickSound::build(std::int64_t sampleRate) {
    const auto rate = static_cast<double>(sampleRate);
    const auto length = static_cast<std::size_t>(std::llround(rate * 0.010));  // 10 ms
    const double decay = rate * 0.0025;  // the envelope falls by e every 2.5 ms
    ClickSound sound;
    sound.accent.resize(length);
    sound.normal.resize(length);
    for (std::size_t i = 0; i < length; ++i) {
        const double envelope = std::exp(-static_cast<double>(i) / decay);
        // Phase one sample in, so a burst's first sample is already non-zero.
        const double t = static_cast<double>(i + 1) / rate;
        sound.accent[i] = static_cast<float>(std::sin(2.0 * std::numbers::pi * 1'760.0 * t) * envelope);
        sound.normal[i] = static_cast<float>(std::sin(2.0 * std::numbers::pi * 880.0 * t) * envelope);
    }
    return sound;
}

float clickGain(std::int32_t gainMilliDb) noexcept {
    return static_cast<float>(std::pow(10.0, static_cast<double>(gainMilliDb) / 20'000.0));
}

}  // namespace siann::realtime
