#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

#include "siann/midi/midi.hpp"

using namespace siann::midi;

namespace {

std::string bytes(std::initializer_list<int> values) {
    std::string out;
    for (const int v : values) {
        out.push_back(static_cast<char>(v));
    }
    return out;
}

std::string be32(std::uint32_t v) {
    return bytes({static_cast<int>(v >> 24), static_cast<int>((v >> 16) & 0xFF), static_cast<int>((v >> 8) & 0xFF),
                  static_cast<int>(v & 0xFF)});
}

std::string header(int format, int tracks, int division) {
    return "MThd" + be32(6) + bytes({0, format, 0, tracks, (division >> 8) & 0xFF, division & 0xFF});
}

std::string track(const std::string& body) {
    return "MTrk" + be32(static_cast<std::uint32_t>(body.size())) + body;
}

std::string errorCode(const std::string& file) {
    try {
        (void)readSmf(file);
    } catch (const MidiError& error) {
        return error.code();
    }
    return "no error";
}

const std::string kEndOfTrack = bytes({0x00, 0xFF, 0x2F, 0x00});

}  // namespace

TEST_CASE("Variable-length quantities", "[midi]") {
    CHECK(encodeVlq(0) == bytes({0x00}));
    CHECK(encodeVlq(0x7F) == bytes({0x7F}));
    CHECK(encodeVlq(0x80) == bytes({0x81, 0x00}));
    CHECK(encodeVlq(0x3FFF) == bytes({0xFF, 0x7F}));
    CHECK(encodeVlq(0x4000) == bytes({0x81, 0x80, 0x00}));
    CHECK(encodeVlq(0x0FFFFFFF) == bytes({0xFF, 0xFF, 0xFF, 0x7F}));
    CHECK_THROWS_AS(encodeVlq(0x10000000), MidiError);

    for (const std::uint32_t v : {0u, 1u, 127u, 128u, 8'192u, 16'383u, 16'384u, 2'097'151u, 0x0FFFFFFFu}) {
        const std::string encoded = encodeVlq(v);
        std::size_t pos = 0;
        CHECK(decodeVlq(encoded, pos) == v);
        CHECK(pos == encoded.size());
    }
    std::size_t pos = 0;
    CHECK_THROWS_AS(decodeVlq(bytes({0x81, 0x81, 0x81, 0x81, 0x00}), pos), MidiError);
    pos = 0;
    CHECK_THROWS_AS(decodeVlq(bytes({0x81}), pos), MidiError);
}

TEST_CASE("Messages are validated and classified", "[midi]") {
    const Message on = Message::noteOn(3, 60, 100);
    CHECK(on.status == 0x93);
    CHECK(on.channel() == 3);
    CHECK(on.isNoteOn());
    CHECK(Message::noteOn(0, 60, 0).isNoteOff());
    CHECK(Message::noteOff(0, 60).isNoteOff());
    const Message bend = Message::pitchBend(1, 8'192);
    CHECK(bend.status == 0xE1);
    CHECK(bend.data1 == 0x00);
    CHECK(bend.data2 == 0x40);
    CHECK(Message::programChange(0, 5).dataLength() == 1);
    CHECK(Message::controlChange(0, 7, 127).dataLength() == 2);
    CHECK_THROWS_AS(Message::noteOn(16, 60, 100), MidiError);
    CHECK_THROWS_AS(Message::noteOn(0, 128, 100), MidiError);
    CHECK_THROWS_AS(Message::pitchBend(0, 16'384), MidiError);
}

TEST_CASE("A format 0 file with running status, meta and sysex events", "[midi]") {
    const std::string body =
        bytes({0x00, 0xFF, 0x03, 0x05}) + "Piano" +
        bytes({0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20}) +   // 500,000 us per quarter
        bytes({0x00, 0xFF, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08}) +  // 3/4
        bytes({0x00, 0x90, 0x3C, 0x64}) +                     // note on C4, velocity 100
        bytes({0x60, 0x3C, 0x00}) +                           // +96, running status, velocity 0
        bytes({0x00, 0xB0, 0x07, 0x7F}) +                     // volume 127
        bytes({0x81, 0x40, 0xE0, 0x00, 0x40}) +               // +192, pitch bend center
        bytes({0x00, 0xF0, 0x03, 0x01, 0x02, 0xF7}) +         // sysex, skipped
        kEndOfTrack;
    const MidiFile file = readSmf(header(0, 1, 96) + track(body));

    CHECK(file.sourceTicksPerQuarter == 96);
    CHECK(file.skippedSysex == 1);
    REQUIRE(file.tempo.size() == 1);
    CHECK(file.tempo[0] == TempoChange{0, 120'000});
    REQUIRE(file.meter.size() == 1);
    CHECK(file.meter[0] == TimeSignature{0, 3, 4});
    REQUIRE(file.tracks.size() == 1);
    CHECK(file.tracks[0].name == "Piano");
    const std::vector<Event> expected = {
        {0, Message::noteOn(0, 60, 100)},
        {1'920, Message::noteOn(0, 60, 0)},
        {1'920, Message::controlChange(0, 7, 127)},
        {5'760, Message::pitchBend(0, 8'192)},
    };
    CHECK(file.tracks[0].events == expected);
}

TEST_CASE("A format 1 file with a conductor track and a tempo change", "[midi]") {
    const std::string conductor = bytes({0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20}) +  // 120 BPM
                                  bytes({0x83, 0x00, 0xFF, 0x51, 0x03, 0x0F, 0x42, 0x40}) +  // +384: 60 BPM
                                  kEndOfTrack;
    const std::string notes = bytes({0x00, 0xFF, 0x03, 0x04}) + "Bass" +
                              bytes({0x00, 0x91, 0x24, 0x50, 0x83, 0x00, 0x81, 0x24, 0x40}) + kEndOfTrack;
    const MidiFile file = readSmf(header(1, 2, 96) + track(conductor) + track(notes));

    REQUIRE(file.tempo.size() == 2);
    CHECK(file.tempo[1] == TempoChange{7'680, 60'000});
    REQUIRE(file.tracks.size() == 1);  // the conductor has no channel events or name
    CHECK(file.tracks[0].name == "Bass");
    CHECK(file.tracks[0].events ==
          std::vector<Event>{{0, Message::noteOn(1, 36, 80)}, {7'680, Message::noteOff(1, 36, 64)}});
}

TEST_CASE("Resolutions that do not divide 1920 round to nearest, ties to even", "[midi]") {
    // At 1000 ticks per quarter, tick 1 is 1.92 SIANN ticks; at 3840, 0.5 and 1.5.
    const std::string body1000 = bytes({0x01, 0x90, 0x3C, 0x64}) + kEndOfTrack;
    CHECK(readSmf(header(0, 1, 1'000) + track(body1000)).tracks[0].events[0].ticks == 2);
    const std::string body3840 = bytes({0x01, 0x90, 0x3C, 0x64, 0x02, 0x80, 0x3C, 0x00}) + kEndOfTrack;
    const auto events = readSmf(header(0, 1, 3'840) + track(body3840)).tracks[0].events;
    CHECK(events[0].ticks == 0);  // 0.5 -> 0
    CHECK(events[1].ticks == 2);  // 1.5 -> 2
}

TEST_CASE("Writing and reading back preserves tracks, tempo and meter", "[midi]") {
    MidiFile file;
    file.tempo = {{0, 120'000}, {3'840, 97'500}};
    file.meter = {{0, 4, 4}, {7'680, 7, 8}};
    file.tracks = {
        Track{"Keys", {{0, Message::noteOn(0, 60, 90)}, {960, Message::noteOff(0, 60)},
                       {960, Message::controlChange(0, 64, 127)}, {123'456, Message::programChange(0, 12)}}},
        Track{"Bend", {{10, Message::pitchBend(2, 0)}, {20, Message::pitchBend(2, 16'383)},
                       {30, Message::channelPressure(2, 33)}, {40, Message::polyPressure(2, 61, 7)}}},
    };
    const MidiFile back = readSmf(writeSmf(file));
    CHECK(back.sourceTicksPerQuarter == 1'920);
    CHECK(back.tempo == file.tempo);
    CHECK(back.meter == file.meter);
    CHECK(back.tracks == file.tracks);
}

TEST_CASE("Events sort stably by position", "[midi]") {
    std::vector<Event> events = {{10, Message::noteOn(0, 1, 1)}, {0, Message::noteOn(0, 2, 1)},
                                 {10, Message::noteOn(0, 3, 1)}, {5, Message::noteOn(0, 4, 1)}};
    sortEvents(events);
    CHECK(events[0].message.data1 == 2);
    CHECK(events[1].message.data1 == 4);
    CHECK(events[2].message.data1 == 1);
    CHECK(events[3].message.data1 == 3);
}

TEST_CASE("Malformed files are rejected with stable codes", "[midi]") {
    CHECK(errorCode("RIFF0000") == "not_midi");
    CHECK(errorCode(header(2, 1, 96) + track(kEndOfTrack)) == "unsupported_format");
    CHECK(errorCode("MThd" + be32(6) + bytes({0, 0, 0, 1, 0xE7, 0x28}) + track(kEndOfTrack)) == "unsupported_smpte");
    CHECK(errorCode(header(0, 1, 96) + "MTrk" + be32(100) + kEndOfTrack) == "truncated");
    CHECK(errorCode(header(0, 1, 96) + track(bytes({0x00, 0x3C, 0x40}) + kEndOfTrack)) == "invalid_event");
    CHECK(errorCode(header(0, 1, 96) + track(bytes({0x00, 0xFF, 0x51, 0x03, 0x00, 0x00, 0x00}) + kEndOfTrack)) ==
          "tempo_out_of_range");
    CHECK(errorCode(header(0, 1, 0) + track(kEndOfTrack)) == "not_midi");
}
