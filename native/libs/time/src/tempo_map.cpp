#include "siann/time/tempo_map.hpp"

#include <utility>

namespace siann::time {

using detail::U128;

TimeError::TimeError(std::string code, const std::string& message)
    : std::runtime_error(message), code_(std::move(code)) {}

namespace {

// Superclocks per quarter at 1 milli-BPM: kSuperclockRate * 60 s * 1000.
constexpr std::uint64_t kSuperclockMinuteMilli = static_cast<std::uint64_t>(kSuperclockRate) * 60u * 1000u;

// Superclocks times ticks-per-quarter per second of audio. Converting a scaled
// superclock value X to samples is X * sampleRate / kScaledPerSecond.
constexpr std::uint64_t kScaledPerSecond = static_cast<std::uint64_t>(kSuperclockRate) *
                                           static_cast<std::uint64_t>(kTicksPerQuarter);

void checkSampleRate(std::int64_t sampleRate) {
    if (sampleRate < kMinSampleRate || sampleRate > kMaxSampleRate) {
        throw TimeError("invalid_sample_rate", "sample rate " + std::to_string(sampleRate) + " is out of range");
    }
}

void checkPosition(std::int64_t value) {
    if (value > kMaxPositionMagnitude || value < -kMaxPositionMagnitude) {
        throw TimeError("position_out_of_range", "position " + std::to_string(value) + " is out of range");
    }
}

std::uint64_t magnitude(std::int64_t value) noexcept {
    return value < 0 ? static_cast<std::uint64_t>(-(value + 1)) + 1u : static_cast<std::uint64_t>(value);
}

std::int64_t withSign(bool negative, std::uint64_t value) noexcept {
    const auto signedValue = static_cast<std::int64_t>(value);
    return negative ? -signedValue : signedValue;
}

}  // namespace

std::int64_t superclocksPerQuarter(std::int32_t milliBpm) {
    if (milliBpm < kMinMilliBpm || milliBpm > kMaxMilliBpm) {
        throw TimeError("tempo_out_of_range", "tempo " + std::to_string(milliBpm) + " milli-BPM is out of range");
    }
    return static_cast<std::int64_t>(
        detail::divRoundHalfEven(detail::fromU64(kSuperclockMinuteMilli), static_cast<std::uint64_t>(milliBpm)));
}

TempoMap::TempoMap(std::vector<TempoPoint> points) : points_(std::move(points)) {
    if (points_.empty()) {
        throw TimeError("empty_tempo_map", "a tempo map needs at least one point");
    }
    if (points_.front().position.ticks != 0) {
        throw TimeError("first_tempo_not_at_zero", "the first tempo point must be at tick 0");
    }
    segments_.reserve(points_.size());
    U128 scaled{};
    for (std::size_t i = 0; i < points_.size(); ++i) {
        const TempoPoint& point = points_[i];
        if (point.shape != TempoShape::step) {
            throw TimeError("unsupported_tempo_ramp", "tempo ramps are not supported yet");
        }
        checkPosition(point.position.ticks);
        const auto scpq = static_cast<std::uint64_t>(superclocksPerQuarter(point.milliBpm));
        if (i > 0) {
            const Segment& previous = segments_.back();
            if (point.position.ticks <= previous.startTick) {
                throw TimeError("unsorted_tempo_points", "tempo points must have strictly increasing ticks");
            }
            const auto span = static_cast<std::uint64_t>(point.position.ticks - previous.startTick);
            scaled = detail::add(scaled, detail::mul64(span, previous.superclocksPerQuarter));
        }
        segments_.push_back(Segment{point.position.ticks, scpq, scaled});
    }
}

TempoMap TempoMap::constant(std::int32_t milliBpm) {
    return TempoMap({TempoPoint{MusicTime{0}, milliBpm, TempoShape::step}});
}

AudioTime TempoMap::toAudio(MusicTime position, std::int64_t sampleRate) const {
    checkSampleRate(sampleRate);
    checkPosition(position.ticks);
    const auto rate = static_cast<std::uint64_t>(sampleRate);

    if (position.ticks < 0) {
        const U128 scaled = detail::mul64(magnitude(position.ticks), segments_.front().superclocksPerQuarter);
        return AudioTime{withSign(true, detail::divRoundHalfEven(detail::mul(scaled, rate), kScaledPerSecond))};
    }
    std::size_t index = segments_.size() - 1;
    while (segments_[index].startTick > position.ticks) {
        --index;
    }
    const Segment& segment = segments_[index];
    const auto offset = static_cast<std::uint64_t>(position.ticks - segment.startTick);
    const U128 scaled = detail::add(segment.startScaled, detail::mul64(offset, segment.superclocksPerQuarter));
    return AudioTime{withSign(false, detail::divRoundHalfEven(detail::mul(scaled, rate), kScaledPerSecond))};
}

MusicTime TempoMap::toMusic(AudioTime position, std::int64_t sampleRate) const {
    checkSampleRate(sampleRate);
    checkPosition(position.samples);
    const auto rate = static_cast<std::uint64_t>(sampleRate);

    // Target in scaled superclocks times the sample rate: samples * kScaledPerSecond.
    const U128 target = detail::mul64(magnitude(position.samples), kScaledPerSecond);
    if (position.samples < 0) {
        const std::uint64_t denominator = rate * segments_.front().superclocksPerQuarter;
        return MusicTime{withSign(true, detail::divRoundHalfEven(target, denominator))};
    }
    std::size_t index = segments_.size() - 1;
    while (index > 0 && detail::less(target, detail::mul(segments_[index].startScaled, rate))) {
        --index;
    }
    const Segment& segment = segments_[index];
    const U128 numerator = detail::sub(target, detail::mul(segment.startScaled, rate));
    const std::uint64_t denominator = rate * segment.superclocksPerQuarter;
    const auto offset = static_cast<std::int64_t>(detail::divRoundHalfEven(numerator, denominator));
    return MusicTime{segment.startTick + offset};
}

}  // namespace siann::time
