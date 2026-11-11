#pragma once

// Internal to siann_media: include after dr_wav.h.

#include <cstdint>

namespace siann::media::detail {

// The most frames the data chunk can hold. dr_wav already clamps the data
// chunk to the input, but takes the frame count of an RF64 (ds64), W64 or
// MS-ADPCM (fact) file from a header field it never checks against the data,
// so a lying header could claim far more frames than the input has.
std::uint64_t framesTheDataHolds(const drwav& wav);

}  // namespace siann::media::detail
