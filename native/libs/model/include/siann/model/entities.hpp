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
    // Bus ids in mixer order (m5b-engine-buses-sends). Omitted from the JSON
    // when empty, so a root without buses keeps its earlier hash.
    std::vector<std::string> busOrder;

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

// A track's input (m5b-engine-record): an IoPort of "Channels and I/O", the
// first device input channel (0-based) and 1 or 2 channels from it. It indexes
// the input the engine has open; the document never names a device.
struct TrackInput {
    std::int32_t port = 0;
    std::int32_t channels = 1;

    friend bool operator==(const TrackInput&, const TrackInput&) = default;
};

// A track's monitoring mode (m5b-engine-monitoring; spec, "Recording"): off
// never passes the track's input, input always does, automatic ("auto") does
// while the transport is stopped on an armed track and while the track captures.
enum class MonitorMode { off, automatic, input };

// "off", "auto" or "input".
std::string_view monitorModeName(MonitorMode mode) noexcept;
// The mode a name stands for; empty for any other text.
std::optional<MonitorMode> monitorModeFromName(std::string_view name) noexcept;

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
    // Omitted from the JSON while absent, so a track without an input keeps its
    // earlier hash (m5b-engine-record).
    std::optional<TrackInput> input;
    // Omitted from the JSON while off, so a track that never monitored keeps its
    // earlier hash (m5b-engine-monitoring).
    MonitorMode monitor = MonitorMode::off;
    // Send ids in order (m5b-engine-buses-sends). Omitted from the JSON when empty.
    std::vector<std::string> sends;
    // The bus the track outputs to, or none for the master; JSON {busId},
    // omitted while the track feeds the master.
    std::optional<std::string> output;
    // Plain text, 1 to kMaxTrackNotesBytes of UTF-8 stored byte for byte
    // (m5b-engine-track-notes, UI redesign UR-17). Omitted from the JSON while
    // absent, so a track without notes keeps its earlier hash.
    std::optional<std::string> notes;

    friend bool operator==(const Track&, const Track&) = default;
};

// The longest track notes, in UTF-8 bytes.
inline constexpr std::size_t kMaxTrackNotesBytes = 16'384;

// True for well-formed UTF-8 of 1 to kMaxTrackNotesBytes bytes whose only
// control characters are tab, LF and CR and that has no display-unsafe
// character (textFault(notes, "\t\n\r"), the rule of a plan's intent: notes are
// text, not a name).
bool isValidTrackNotes(std::string_view notes) noexcept;

// A bus (m5b-engine-buses-sends, spec "siann-model", M5b bus and send): sums the
// tracks and buses that output to it and the sends that target it, runs its
// inserts and its fader, and outputs to the master or to another bus. Always
// stereo. Ref bus:<id>.
struct Bus {
    std::string id;
    std::string name;
    std::int32_t channels = 2;
    Gain gain;
    std::int32_t pan = 0;
    bool mute = false;
    bool solo = false;
    // Plugin slot ids in signal order; omitted from the JSON when empty.
    std::vector<std::string> inserts;
    // The bus this bus outputs to, or none for the master; omitted while none.
    std::optional<std::string> output;

    friend bool operator==(const Bus&, const Bus&) = default;
};

// A send from a track to a bus (m5b-engine-buses-sends). Pre-fader taps the
// track after its inserts, post-fader after its fader. Ref send:<id>.
struct Send {
    std::string id;
    std::string trackId;
    std::string busId;
    Gain level;
    bool pre = false;
    bool enabled = true;

    friend bool operator==(const Send&, const Send&) = default;
};

// A plugin insert on a track or a bus (M4, spec "siann-model", M4 plugin_slot). The
// document holds the state blob's hash only; the blob lives in <bundle>/blobs.
// A slot belongs to exactly one track or bus (m5b-engine-buses-sends): one of
// trackId and busId is set, the other empty and omitted from the JSON.
struct PluginSlot {
    std::string id;
    std::string trackId;
    std::string busId;
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

// The master gain (m5b-engine-master, UI redesign E-11): a singleton entity with
// id "master" and the track gain's range. Present only while the gain is not
// 0 dB, so a document whose master is at 0 dB hashes as it did before.
struct Master {
    Gain gain;

    friend bool operator==(const Master&, const Master&) = default;
};

// A clip fade's gain curve (m5b-engine-clip-fades): x for linear,
// sin(x * pi / 2) for equal power ("siann-graph and siann-engine").
enum class FadeCurve { linear, equal_power };

// One side of a clip's fades, in media frames. Length 0 is no fade; the
// document normalises its curve to linear (withClip), so operator== and the
// hash agree. Omitted from the JSON at length 0.
struct Fade {
    std::int64_t length = 0;
    FadeCurve curve = FadeCurve::linear;

    friend bool operator==(const Fade&, const Fade&) = default;
};

// "linear" or "equal_power", the JSON names of the curves.
std::string_view fadeCurveName(FadeCurve curve) noexcept;
std::optional<FadeCurve> fadeCurveFromName(std::string_view name) noexcept;

struct Clip {
    std::string id;
    std::string trackId;
    std::string mediaId;
    time::Position position;
    std::int64_t sourceStart = 0;  // media frames
    std::int64_t length = 0;       // media frames
    Gain gain;
    // m5b-engine-clip-fades: fadeIn.length + fadeOut.length <= length.
    Fade fadeIn;
    Fade fadeOut;

    friend bool operator==(const Clip&, const Clip&) = default;
};

}  // namespace siann::model
