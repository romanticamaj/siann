#pragma once

// siann-midi (architecture spec, "MIDI"): MIDI 1.0 channel messages, event
// lists in MusicTime ticks, and Standard MIDI File import and export. Pure C++.
// The internal format is MIDI 1.0; UMP (MIDI 2.0) can be added behind the same
// event shape without changing command schemas.

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace siann::midi {

class MidiError : public std::runtime_error {
public:
    MidiError(std::string code, const std::string& message);

    // One of: not_midi, truncated, invalid_vlq, unsupported_smpte,
    // unsupported_format, invalid_event, tempo_out_of_range, invalid_message.
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

enum class MessageType : std::uint8_t {
    noteOff = 0x80,
    noteOn = 0x90,
    polyPressure = 0xA0,
    controlChange = 0xB0,
    programChange = 0xC0,
    channelPressure = 0xD0,
    pitchBend = 0xE0,
};

// A channel voice message. data2 is unused (0) for program change and
// channel pressure.
struct Message {
    std::uint8_t status = 0x90;
    std::uint8_t data1 = 0;
    std::uint8_t data2 = 0;

    static Message noteOn(int channel, int note, int velocity);
    static Message noteOff(int channel, int note, int velocity = 0);
    static Message controlChange(int channel, int controller, int value);
    static Message programChange(int channel, int program);
    static Message channelPressure(int channel, int pressure);
    static Message polyPressure(int channel, int note, int pressure);
    // value in [0, 16383]; 8192 is center.
    static Message pitchBend(int channel, int value);

    MessageType type() const noexcept { return static_cast<MessageType>(status & 0xF0); }
    int channel() const noexcept { return status & 0x0F; }
    // Note-on with velocity 0 counts as note-off, as in the MIDI 1.0 spec.
    bool isNoteOff() const noexcept {
        return type() == MessageType::noteOff || (type() == MessageType::noteOn && data2 == 0);
    }
    bool isNoteOn() const noexcept { return type() == MessageType::noteOn && data2 != 0; }
    int dataLength() const noexcept;  // 1 or 2

    friend bool operator==(const Message&, const Message&) = default;
};

struct Event {
    std::int64_t ticks = 0;  // SIANN MusicTime ticks (1920 per quarter)
    Message message;

    friend bool operator==(const Event&, const Event&) = default;
};

// Stable sort by ticks; events at the same tick keep their order.
void sortEvents(std::vector<Event>& events);

struct TempoChange {
    std::int64_t ticks = 0;
    std::int32_t milliBpm = 120'000;
    friend bool operator==(const TempoChange&, const TempoChange&) = default;
};

struct TimeSignature {
    std::int64_t ticks = 0;
    int numerator = 4;
    int denominator = 4;
    friend bool operator==(const TimeSignature&, const TimeSignature&) = default;
};

struct Track {
    std::string name;
    std::vector<Event> events;
    friend bool operator==(const Track&, const Track&) = default;
};

struct MidiFile {
    std::vector<Track> tracks;        // tracks with channel events or a name
    std::vector<TempoChange> tempo;   // from all tracks, sorted
    std::vector<TimeSignature> meter; // from all tracks, sorted
    int sourceTicksPerQuarter = 1920; // the file's own resolution
    int skippedSysex = 0;             // system exclusive events are not kept in M1
};

// Reads format 0 or 1 files with a ticks-per-quarter division. Positions are
// converted to 1920 ticks per quarter, rounding to nearest with ties to even.
// Tempo becomes milli-BPM: round(60,000,000,000 / microsecondsPerQuarter).
MidiFile readSmf(std::string_view bytes);

// Writes format 1 at 1920 ticks per quarter: a conductor track with tempo and
// time signatures, then one track per Track.
std::string writeSmf(const MidiFile& file);

// Variable-length quantities, exposed for tests.
std::string encodeVlq(std::uint32_t value);
std::uint32_t decodeVlq(std::string_view bytes, std::size_t& position);

}  // namespace siann::midi
