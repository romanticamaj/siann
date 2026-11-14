// Chunked decoding and conversion (m5b-engine-project-media): the import job reads
// a file through media::AudioSource and converts it block by block with a cancel
// flag and a progress counter. The output must be the whole-buffer path's, byte
// for byte, so the hashes M1 recorded hold.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <functional>
#include <numbers>
#include <string>
#include <vector>

#include "siann/media/audio.hpp"
#include "siann/media/audio_source.hpp"
#include "support/flac_test_encoder.hpp"

using siann::media::AudioBuffer;
using siann::media::AudioInfo;
using siann::media::AudioSource;
using siann::media::ConvertControl;
using siann::media::MediaError;

namespace {

AudioBuffer sine(std::int32_t channels, std::int64_t rate, std::int64_t frames) {
    AudioBuffer buffer;
    buffer.info = AudioInfo{channels, rate, frames};
    for (std::int64_t i = 0; i < frames; ++i) {
        for (std::int32_t c = 0; c < channels; ++c) {
            buffer.samples.push_back(static_cast<float>(
                0.3 * std::sin(2.0 * std::numbers::pi * (330.0 + 110.0 * c) * static_cast<double>(i) /
                               static_cast<double>(rate))));
        }
    }
    return buffer;
}

std::vector<std::int16_t> ramp16(std::int32_t channels, std::int64_t frames) {
    std::vector<std::int16_t> out;
    for (std::int64_t i = 0; i < frames * channels; ++i) {
        out.push_back(static_cast<std::int16_t>((i * 37) % 30000 - 15000));
    }
    return out;
}

// Reads the whole source in reads of `chunk` frames.
AudioBuffer readInChunks(AudioSource& source, std::int64_t chunk) {
    AudioBuffer out;
    out.info = source.info();
    std::vector<float> block(static_cast<std::size_t>(chunk * out.info.channels));
    for (;;) {
        const std::int64_t got = source.read(block.data(), chunk);
        if (got == 0) {
            break;
        }
        out.samples.insert(out.samples.end(), block.begin(), block.begin() + got * out.info.channels);
    }
    return out;
}

std::string codeOf(const std::function<void()>& run) {
    try {
        run();
    } catch (const MediaError& error) {
        return error.code();
    }
    return "no error";
}

}  // namespace

TEST_CASE("An audio source reads a WAV or FLAC in chunks exactly as decode does", "[media][source]") {
    const std::string wav = siann::media::encodeWavFloat32(sine(2, 44'100, 20'000));
    const std::string flac = siann::test::encodeFlac16(2, 44'100, ramp16(2, 9'000));
    for (const std::string* bytes : {&wav, &flac}) {
        const AudioBuffer whole = siann::media::decode(*bytes);
        const auto source = siann::media::openAudioSource(*bytes);
        CHECK(source->info().channels == whole.info.channels);
        CHECK(source->info().sampleRate == whole.info.sampleRate);
        CHECK(source->info().frames == whole.info.frames);
        const AudioBuffer chunked = readInChunks(*source, 1'000);
        CHECK(chunked.samples == whole.samples);
        CHECK(source->read(nullptr, 0) == 0);
    }
}

TEST_CASE("An audio source refuses what decode refuses", "[media][source]") {
    CHECK(codeOf([] { (void)siann::media::openAudioSource("not audio at all"); }) == "unsupported_media");
    std::string wav = siann::media::encodeWavFloat32(sine(1, 48'000, 100));
    wav.resize(30);  // inside the header
    CHECK(codeOf([&] { (void)siann::media::openAudioSource(wav); }) == "decode_failed");

    // A FLAC cut inside its frames opens (STREAMINFO is whole) and fails while reading.
    std::string flac = siann::test::encodeFlac16(1, 48'000, ramp16(1, 20'000));
    flac.resize(flac.size() * 2 / 3);
    CHECK(codeOf([&] {
              const auto source = siann::media::openAudioSource(flac);
              (void)readInChunks(*source, 4'096);
          }) == "decode_failed");
}

TEST_CASE("Chunked conversion is byte for byte the whole-buffer conversion", "[media][source]") {
    // More than one 16384-frame r8brain block, mono and stereo, up and down.
    struct Case {
        std::int32_t channels;
        std::int64_t from;
        std::int64_t to;
        std::int64_t frames;
    };
    for (const Case& c : {Case{1, 44'100, 48'000, 40'000}, Case{2, 44'100, 48'000, 33'333},
                          Case{2, 96'000, 48'000, 50'001}, Case{1, 48'000, 44'100, 7}}) {
        INFO(c.channels << " ch " << c.from << " -> " << c.to << ", " << c.frames << " frames");
        const std::string bytes = siann::media::encodeWavFloat32(sine(c.channels, c.from, c.frames));
        const AudioBuffer expected = siann::media::resample(siann::media::decode(bytes), c.to);

        const auto source = siann::media::openAudioSource(bytes);
        std::vector<std::int64_t> progress;
        ConvertControl control;
        control.progress = [&](std::int64_t framesDone) { progress.push_back(framesDone); };
        const AudioBuffer converted = siann::media::resampleFrom(*source, c.to, control);
        CHECK(converted.info.channels == expected.info.channels);
        CHECK(converted.info.sampleRate == c.to);
        CHECK(converted.info.frames == expected.info.frames);
        CHECK(siann::media::encodeWavFloat32(converted) == siann::media::encodeWavFloat32(expected));
        REQUIRE_FALSE(progress.empty());
        CHECK(progress.back() == c.frames);
        for (std::size_t i = 1; i < progress.size(); ++i) {
            CHECK(progress[i] >= progress[i - 1]);
        }
    }
}

TEST_CASE("Reading a source at the session rate gives the decoded buffer", "[media][source]") {
    const std::string bytes = siann::media::encodeWavFloat32(sine(2, 48'000, 30'000));
    const auto source = siann::media::openAudioSource(bytes);
    std::int64_t last = 0;
    ConvertControl control;
    control.progress = [&](std::int64_t framesDone) { last = framesDone; };
    const AudioBuffer read = siann::media::readAll(*source, control);
    CHECK(read.samples == siann::media::decode(bytes).samples);
    CHECK(read.info.frames == 30'000);
    CHECK(last == 30'000);
}

TEST_CASE("A conversion stops with cancelled at the next block once asked", "[media][source]") {
    const std::string bytes = siann::media::encodeWavFloat32(sine(2, 44'100, 100'000));
    for (const bool convert : {true, false}) {
        INFO(convert);
        const auto source = siann::media::openAudioSource(bytes);
        std::int64_t seen = 0;
        ConvertControl control;
        control.progress = [&](std::int64_t framesDone) { seen = framesDone; };
        control.cancelled = [&] { return seen > 0; };  // after the first block
        CHECK(codeOf([&] {
                  if (convert) {
                      (void)siann::media::resampleFrom(*source, 48'000, control);
                  } else {
                      (void)siann::media::readAll(*source, control);
                  }
              }) == "cancelled");
        CHECK(seen > 0);
        CHECK(seen < 100'000);
    }
}
