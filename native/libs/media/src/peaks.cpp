#include "siann/media/peaks.hpp"

#include "siann/media/audio.hpp"

namespace siann::media {

std::int16_t peakSample(float) noexcept {
    return 0;
}

PeakPyramid computePeaks(host::MediaReader&) {
    throw MediaError("not_implemented", "computePeaks");
}

std::string encodePeaks(const PeakPyramid&) {
    return {};
}

PeakPyramid decodePeaks(std::string_view) {
    return {};
}

std::filesystem::path peaksPath(const std::filesystem::path& bundle, std::string_view) {
    return bundle;
}

std::filesystem::path writePeaks(const std::filesystem::path& bundle, std::string_view, const PeakPyramid&) {
    return bundle;
}

}  // namespace siann::media
