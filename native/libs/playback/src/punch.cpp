#include "siann/playback/punch.hpp"

#include <algorithm>

namespace siann::playback {

std::int64_t prerollStart(const std::vector<time::TempoPoint>& tempo, std::int64_t sampleRate,
                          std::int64_t position, std::int32_t bars) {
    const time::TempoMap map(tempo);
    const time::MusicTime at = map.toMusic(time::AudioTime{position}, sampleRate);
    const std::int64_t back = static_cast<std::int64_t>(bars) * kBeatsPerBar * time::kTicksPerQuarter;
    if (at.ticks <= back) {
        return 0;
    }
    return std::max<std::int64_t>(map.toAudio(time::MusicTime{at.ticks - back}, sampleRate).samples, 0);
}

double beatFramesAt(const std::vector<time::TempoPoint>& tempo, std::int64_t sampleRate, std::int64_t frame) {
    const time::TempoMap map(tempo);
    const time::MusicTime at = map.toMusic(time::AudioTime{frame}, sampleRate);
    std::int32_t milliBpm = map.points().front().milliBpm;
    for (const time::TempoPoint& point : map.points()) {
        if (point.position.ticks <= at.ticks) {
            milliBpm = point.milliBpm;
        }
    }
    return static_cast<double>(sampleRate) * 60'000.0 / static_cast<double>(milliBpm);
}

}  // namespace siann::playback
