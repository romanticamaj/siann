#include "siann/midi/midi.hpp"

#include <algorithm>
#include <utility>

namespace siann::midi {

MidiError::MidiError(std::string code, const std::string& message)
    : std::runtime_error(message), code_(std::move(code)) {}

namespace {

constexpr int kTicksPerQuarter = 1920;
constexpr std::int32_t kMinMilliBpm = 1'000;
constexpr std::int32_t kMaxMilliBpm = 999'999;
constexpr std::uint64_t kMicrosPerMinuteMilli = 60'000'000'000ull;  // 60 s in microseconds, times 1000

std::uint8_t checked(int value, int limit, const char* what) {
    if (value < 0 || value >= limit) {
        throw MidiError("invalid_message", std::string(what) + " is out of range");
    }
    return static_cast<std::uint8_t>(value);
}

std::uint8_t statusByteFor(MessageType type, int channel) {
    return static_cast<std::uint8_t>(static_cast<int>(type) | checked(channel, 16, "channel"));
}

// a * b / c, nearest, ties to even, for non-negative values that fit.
std::uint64_t mulDivRoundHalfEven(std::uint64_t a, std::uint64_t b, std::uint64_t c) {
    const std::uint64_t product = a * b;
    std::uint64_t q = product / c;
    const std::uint64_t r = product % c;
    if (2 * r > c || (2 * r == c && (q & 1u) != 0)) {
        ++q;
    }
    return q;
}

class Reader {
public:
    explicit Reader(std::string_view data) : data_(data) {}

    bool atEnd() const noexcept { return pos_ >= data_.size(); }
    std::size_t position() const noexcept { return pos_; }

    std::uint8_t u8() {
        need(1);
        return static_cast<std::uint8_t>(data_[pos_++]);
    }
    std::uint32_t be(int bytes) {
        need(static_cast<std::size_t>(bytes));
        std::uint32_t v = 0;
        for (int i = 0; i < bytes; ++i) {
            v = (v << 8) | static_cast<std::uint8_t>(data_[pos_++]);
        }
        return v;
    }
    std::string_view take(std::size_t n) {
        need(n);
        const auto out = data_.substr(pos_, n);
        pos_ += n;
        return out;
    }
    std::uint32_t vlq() { return decodeVlq(data_, pos_); }

private:
    void need(std::size_t n) const {
        if (data_.size() - pos_ < n) {
            throw MidiError("truncated", "the MIDI data ends early");
        }
    }

    std::string_view data_;
    std::size_t pos_ = 0;
};

std::int32_t milliBpmFromMicros(std::uint32_t micros) {
    if (micros == 0) {
        throw MidiError("tempo_out_of_range", "a tempo of 0 microseconds per quarter is invalid");
    }
    const std::uint64_t milliBpm = mulDivRoundHalfEven(kMicrosPerMinuteMilli, 1, micros);
    if (milliBpm < static_cast<std::uint64_t>(kMinMilliBpm) || milliBpm > static_cast<std::uint64_t>(kMaxMilliBpm)) {
        throw MidiError("tempo_out_of_range", "the tempo is outside 1 to 999.999 BPM");
    }
    return static_cast<std::int32_t>(milliBpm);
}

std::uint32_t microsFromMilliBpm(std::int32_t milliBpm) {
    if (milliBpm < kMinMilliBpm || milliBpm > kMaxMilliBpm) {
        throw MidiError("tempo_out_of_range", "the tempo is outside 1 to 999.999 BPM");
    }
    return static_cast<std::uint32_t>(mulDivRoundHalfEven(kMicrosPerMinuteMilli, 1, static_cast<std::uint64_t>(milliBpm)));
}

void putBe(std::string& out, std::uint32_t v, int bytes) {
    for (int i = bytes - 1; i >= 0; --i) {
        out.push_back(static_cast<char>((v >> (8 * i)) & 0xFF));
    }
}

struct TimedBytes {
    std::int64_t ticks;
    std::string bytes;
};

std::string trackChunk(std::vector<TimedBytes> items) {
    std::stable_sort(items.begin(), items.end(), [](const TimedBytes& a, const TimedBytes& b) { return a.ticks < b.ticks; });
    std::string body;
    std::int64_t last = 0;
    for (const auto& item : items) {
        const std::int64_t delta = item.ticks - last;
        if (delta < 0 || delta > 0x0FFFFFFF) {
            throw MidiError("invalid_event", "event positions must be non-negative and within MIDI file limits");
        }
        body += encodeVlq(static_cast<std::uint32_t>(delta));
        body += item.bytes;
        last = item.ticks;
    }
    body += std::string("\x00\xFF\x2F\x00", 4);
    std::string chunk = "MTrk";
    putBe(chunk, static_cast<std::uint32_t>(body.size()), 4);
    return chunk + body;
}

std::string metaEvent(int type, const std::string& payload) {
    std::string out;
    out.push_back(static_cast<char>(0xFF));
    out.push_back(static_cast<char>(type));
    out += encodeVlq(static_cast<std::uint32_t>(payload.size()));
    out += payload;
    return out;
}

}  // namespace

Message Message::noteOn(int channel, int note, int velocity) {
    return {statusByteFor(MessageType::noteOn, channel), checked(note, 128, "note"), checked(velocity, 128, "velocity")};
}
Message Message::noteOff(int channel, int note, int velocity) {
    return {statusByteFor(MessageType::noteOff, channel), checked(note, 128, "note"), checked(velocity, 128, "velocity")};
}
Message Message::controlChange(int channel, int controller, int value) {
    return {statusByteFor(MessageType::controlChange, channel), checked(controller, 128, "controller"),
            checked(value, 128, "value")};
}
Message Message::programChange(int channel, int program) {
    return {statusByteFor(MessageType::programChange, channel), checked(program, 128, "program"), 0};
}
Message Message::channelPressure(int channel, int pressure) {
    return {statusByteFor(MessageType::channelPressure, channel), checked(pressure, 128, "pressure"), 0};
}
Message Message::polyPressure(int channel, int note, int pressure) {
    return {statusByteFor(MessageType::polyPressure, channel), checked(note, 128, "note"), checked(pressure, 128, "pressure")};
}
Message Message::pitchBend(int channel, int value) {
    if (value < 0 || value > 16'383) {
        throw MidiError("invalid_message", "pitch bend is out of range");
    }
    return {statusByteFor(MessageType::pitchBend, channel), static_cast<std::uint8_t>(value & 0x7F),
            static_cast<std::uint8_t>(value >> 7)};
}

int Message::dataLength() const noexcept {
    const MessageType t = type();
    return t == MessageType::programChange || t == MessageType::channelPressure ? 1 : 2;
}

void sortEvents(std::vector<Event>& events) {
    std::stable_sort(events.begin(), events.end(), [](const Event& a, const Event& b) { return a.ticks < b.ticks; });
}

std::string encodeVlq(std::uint32_t value) {
    if (value > 0x0FFFFFFF) {
        throw MidiError("invalid_vlq", "variable-length quantities hold at most 28 bits");
    }
    char groups[4];
    int count = 0;
    do {
        groups[count++] = static_cast<char>(value & 0x7F);
        value >>= 7;
    } while (value != 0);
    std::string out;
    for (int i = count - 1; i >= 0; --i) {
        out.push_back(static_cast<char>(groups[i] | (i > 0 ? 0x80 : 0x00)));
    }
    return out;
}

std::uint32_t decodeVlq(std::string_view bytes, std::size_t& position) {
    std::uint32_t value = 0;
    for (int i = 0; i < 4; ++i) {
        if (position >= bytes.size()) {
            throw MidiError("truncated", "a variable-length quantity ends early");
        }
        const auto b = static_cast<std::uint8_t>(bytes[position++]);
        value = (value << 7) | (b & 0x7Fu);
        if ((b & 0x80u) == 0) {
            return value;
        }
    }
    throw MidiError("invalid_vlq", "a variable-length quantity is longer than 4 bytes");
}

MidiFile readSmf(std::string_view data) {
    Reader r(data);
    if (data.size() < 14 || data.substr(0, 4) != "MThd") {
        throw MidiError("not_midi", "not a Standard MIDI File");
    }
    r.take(4);
    const std::uint32_t headerLength = r.be(4);
    if (headerLength < 6) {
        throw MidiError("not_midi", "the MIDI header is too short");
    }
    const std::uint32_t format = r.be(2);
    const std::uint32_t trackCount = r.be(2);
    const std::uint32_t division = r.be(2);
    r.take(headerLength - 6);
    if (format > 1) {
        throw MidiError("unsupported_format", "only MIDI file formats 0 and 1 are supported");
    }
    if ((division & 0x8000u) != 0) {
        throw MidiError("unsupported_smpte", "SMPTE time division is not supported");
    }
    if (division == 0) {
        throw MidiError("not_midi", "the MIDI file has a zero time division");
    }

    MidiFile file;
    file.sourceTicksPerQuarter = static_cast<int>(division);
    const auto toSiann = [&](std::uint64_t ticks) {
        return static_cast<std::int64_t>(mulDivRoundHalfEven(ticks, kTicksPerQuarter, division));
    };

    for (std::uint32_t t = 0; t < trackCount; ++t) {
        if (r.take(4) != "MTrk") {
            throw MidiError("not_midi", "expected a track chunk");
        }
        const std::uint32_t length = r.be(4);
        Reader tr(r.take(length));
        Track track;
        std::uint64_t ticks = 0;
        std::uint8_t running = 0;
        while (!tr.atEnd()) {
            ticks += tr.vlq();
            std::uint8_t first = tr.u8();
            if (first == 0xFF) {
                const std::uint8_t type = tr.u8();
                const std::string_view payload = tr.take(tr.vlq());
                running = 0;  // meta events cancel running status (SMF 1.0)
                if (type == 0x2F) {
                    break;
                }
                if (type == 0x03 && track.name.empty()) {
                    track.name = std::string(payload);
                } else if (type == 0x51) {
                    if (payload.size() != 3) {
                        throw MidiError("invalid_event", "a tempo event needs 3 bytes");
                    }
                    const std::uint32_t micros = (static_cast<std::uint32_t>(static_cast<std::uint8_t>(payload[0])) << 16) |
                                                 (static_cast<std::uint32_t>(static_cast<std::uint8_t>(payload[1])) << 8) |
                                                 static_cast<std::uint8_t>(payload[2]);
                    file.tempo.push_back(TempoChange{toSiann(ticks), milliBpmFromMicros(micros)});
                } else if (type == 0x58) {
                    if (payload.size() < 2) {
                        throw MidiError("invalid_event", "a time signature event needs at least 2 bytes");
                    }
                    file.meter.push_back(TimeSignature{toSiann(ticks), static_cast<std::uint8_t>(payload[0]),
                                                       1 << static_cast<std::uint8_t>(payload[1])});
                }
                continue;
            }
            if (first == 0xF0 || first == 0xF7) {
                tr.take(tr.vlq());
                ++file.skippedSysex;
                running = 0;
                continue;
            }
            std::uint8_t statusByte = first;
            std::uint8_t data1 = 0;
            if (first < 0x80) {
                if (running == 0) {
                    throw MidiError("invalid_event", "a data byte without a running status");
                }
                statusByte = running;
                data1 = first;
            } else {
                if (first >= 0xF0) {
                    throw MidiError("invalid_event", "system messages are not valid in a MIDI file track");
                }
                running = first;
                data1 = tr.u8();
            }
            Message message{statusByte, data1, 0};
            if (message.dataLength() == 2) {
                message.data2 = tr.u8();
            }
            if (message.data1 > 0x7F || message.data2 > 0x7F) {
                throw MidiError("invalid_event", "a data byte has its high bit set");
            }
            track.events.push_back(Event{toSiann(ticks), message});
        }
        if (!track.events.empty() || !track.name.empty()) {
            file.tracks.push_back(std::move(track));
        }
    }
    std::stable_sort(file.tempo.begin(), file.tempo.end(),
                     [](const TempoChange& a, const TempoChange& b) { return a.ticks < b.ticks; });
    std::stable_sort(file.meter.begin(), file.meter.end(),
                     [](const TimeSignature& a, const TimeSignature& b) { return a.ticks < b.ticks; });
    return file;
}

std::string writeSmf(const MidiFile& file) {
    std::string out = "MThd";
    putBe(out, 6, 4);
    putBe(out, 1, 2);
    putBe(out, static_cast<std::uint32_t>(file.tracks.size() + 1), 2);
    putBe(out, kTicksPerQuarter, 2);

    std::vector<TimedBytes> conductor;
    for (const auto& tempo : file.tempo) {
        std::string payload;
        putBe(payload, microsFromMilliBpm(tempo.milliBpm), 3);
        conductor.push_back({tempo.ticks, metaEvent(0x51, payload)});
    }
    for (const auto& meter : file.meter) {
        int power = 0;
        while ((1 << power) < meter.denominator) {
            ++power;
        }
        if ((1 << power) != meter.denominator || meter.numerator < 1 || meter.numerator > 255) {
            throw MidiError("invalid_event", "a time signature needs a power-of-two denominator");
        }
        std::string payload;
        payload.push_back(static_cast<char>(meter.numerator));
        payload.push_back(static_cast<char>(power));
        payload.push_back(static_cast<char>(24));
        payload.push_back(static_cast<char>(8));
        conductor.push_back({meter.ticks, metaEvent(0x58, payload)});
    }
    out += trackChunk(std::move(conductor));

    for (const auto& track : file.tracks) {
        std::vector<TimedBytes> items;
        if (!track.name.empty()) {
            items.push_back({0, metaEvent(0x03, track.name)});
        }
        for (const auto& event : track.events) {
            std::string bytes;
            bytes.push_back(static_cast<char>(event.message.status));
            bytes.push_back(static_cast<char>(event.message.data1));
            if (event.message.dataLength() == 2) {
                bytes.push_back(static_cast<char>(event.message.data2));
            }
            items.push_back({event.ticks, std::move(bytes)});
        }
        out += trackChunk(std::move(items));
    }
    return out;
}

}  // namespace siann::midi
