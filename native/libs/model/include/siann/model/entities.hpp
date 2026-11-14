#pragma once

// M1 session entities (architecture spec, "siann-model"). Every entity is an
// immutable value with a stable ID; its JSON form is hashed with RFC 8785.

#include <climits>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "siann/hash/sha256.hpp"
#include "siann/time/tempo_map.hpp"
#include "siann/time/time.hpp"

namespace siann::model {

// Integer milli-dB. kMinusInfinity is the fader minimum; it is special-cased
// before any arithmetic.
struct Gain {
    static constexpr std::int32_t kMinusInfinity = INT32_MIN;
    static constexpr std::int32_t kMinMilliDb = -144'000;
    static constexpr std::int32_t kMaxMilliDb = 24'000;

    std::int32_t milliDb = 0;

    static constexpr Gain minusInfinity() noexcept { return Gain{kMinusInfinity}; }
    constexpr bool isMinusInfinity() const noexcept { return milliDb == kMinusInfinity; }
    constexpr bool isValid() const noexcept {
        return isMinusInfinity() || (milliDb >= kMinMilliDb && milliDb <= kMaxMilliDb);
    }
    friend constexpr bool operator==(const Gain&, const Gain&) = default;
};

// Pan in [-10000, 10000]: hard left to hard right.
inline constexpr std::int32_t kPanMin = -10'000;
inline constexpr std::int32_t kPanMax = 10'000;

struct Root {
    std::string name;
    std::int64_t sampleRate = 48'000;
    std::vector<time::TempoPoint> tempo{time::TempoPoint{}};
    std::vector<std::string> trackOrder;

    friend bool operator==(const Root&, const Root&) = default;
};

enum class MediaFormat { wav, flac };

struct Media {
    std::string id;
    hash::Digest contentHash{};
    std::optional<hash::Digest> originalHash;  // set when imported with conversion
    MediaFormat format = MediaFormat::wav;
    std::int32_t channels = 1;
    std::int64_t sampleRate = 48'000;
    std::int64_t frames = 0;
    // Display name, 1 to 255 UTF-8 bytes (m5b-engine-project-media: the imported
    // file's base name). Omitted from the JSON when absent, so a media entity
    // without a name keeps the hash it had before the field existed.
    std::optional<std::string> name;

    friend bool operator==(const Media&, const Media&) = default;
};

// The longest media name, in UTF-8 bytes.
inline constexpr std::size_t kMaxMediaNameBytes = 255;

// True for well-formed UTF-8 of 1 to kMaxMediaNameBytes bytes.
bool isValidMediaName(std::string_view name) noexcept;

enum class TrackKind { audio };

struct Track {
    std::string id;
    std::string name;
    TrackKind kind = TrackKind::audio;
    std::int32_t channels = 2;
    Gain gain;
    std::int32_t pan = 0;
    bool mute = false;
    bool solo = false;
    // Plugin slot ids in signal order (M4). Omitted from the JSON when empty, so a
    // track without inserts keeps its M1 hash.
    std::vector<std::string> inserts;

    friend bool operator==(const Track&, const Track&) = default;
};

// A plugin insert on a track (M4, spec "siann-model", M4 plugin_slot). The
// document holds the state blob's hash only; the blob lives in <bundle>/blobs.
struct PluginSlot {
    std::string id;
    std::string trackId;
    std::string format;  // clap, vst3, au or lv2
    std::string uid;
    std::string name;
    std::string path;  // an install hint, not part of uid
    std::optional<std::string> stateBlob;  // "sha256:<64 lowercase hex>" or none
    bool bypass = false;

    friend bool operator==(const PluginSlot&, const PluginSlot&) = default;
};

// The left and right locators (m5-ui-engine-loop-click): a singleton entity with
// id "locators", audio-domain frames, 0 <= left < right <= kMaxPositionMagnitude.
// Absent from a document until first set. The M6b punch range reuses it.
struct Locators {
    std::int64_t left = 0;
    std::int64_t right = 0;

    friend bool operator==(const Locators&, const Locators&) = default;
};

struct Clip {
    std::string id;
    std::string trackId;
    std::string mediaId;
    time::Position position;
    std::int64_t sourceStart = 0;  // media frames
    std::int64_t length = 0;       // media frames
    Gain gain;

    friend bool operator==(const Clip&, const Clip&) = default;
};

}  // namespace siann::model
