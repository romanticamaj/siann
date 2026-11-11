#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <new>
#include <numbers>
#include <string>
#include <utility>
#include <vector>

#include "siann/media/audio.hpp"
#include "support/allocation_fuse.hpp"

using siann::media::AudioBuffer;
using siann::media::AudioInfo;
using siann::media::MediaError;
using siann::media::decodeWav;
using siann::media::encodeWavFloat32;
using siann::media::probeWav;
using siann::media::resample;

namespace {

void putU16(std::string& out, std::uint16_t v) {
    out.push_back(static_cast<char>(v & 0xFF));
    out.push_back(static_cast<char>(v >> 8));
}

void putU32(std::string& out, std::uint32_t v) {
    for (int i = 0; i < 4; ++i) {
        out.push_back(static_cast<char>((v >> (8 * i)) & 0xFF));
    }
}

// A PCM WAV built byte by byte, independent of the code under test.
std::string pcmWav(std::uint16_t channels, std::uint32_t rate, std::uint16_t bits, const std::string& data) {
    std::string out = "RIFF";
    putU32(out, static_cast<std::uint32_t>(4 + 8 + 16 + 8 + data.size()));
    out += "WAVE";
    out += "fmt ";
    putU32(out, 16);
    putU16(out, 1);
    putU16(out, channels);
    putU32(out, rate);
    putU32(out, rate * channels * bits / 8);
    putU16(out, static_cast<std::uint16_t>(channels * bits / 8));
    putU16(out, bits);
    out += "data";
    putU32(out, static_cast<std::uint32_t>(data.size()));
    out += data;
    return out;
}

std::string pcm16(const std::vector<std::int16_t>& samples) {
    std::string out;
    for (const auto s : samples) {
        putU16(out, static_cast<std::uint16_t>(s));
    }
    return out;
}

std::string errorCode(const std::string& bytes) {
    try {
        (void)decodeWav(bytes);
    } catch (const MediaError& error) {
        return error.code();
    }
    return "no error";
}

AudioBuffer sine(std::int64_t rate, std::int64_t frames, double hz, int channels = 1) {
    AudioBuffer buffer;
    buffer.info = AudioInfo{channels, rate, frames};
    for (std::int64_t i = 0; i < frames; ++i) {
        const double v = 0.5 * std::sin(2.0 * std::numbers::pi * hz * static_cast<double>(i) / static_cast<double>(rate));
        for (int c = 0; c < channels; ++c) {
            buffer.samples.push_back(static_cast<float>(c == 0 ? v : -v));
        }
    }
    return buffer;
}

}  // namespace

TEST_CASE("16-bit PCM decodes to exact floats", "[media]") {
    const std::string wav = pcmWav(2, 44'100, 16, pcm16({0, 16384, -32768, 32767, -16384, 1}));
    const AudioInfo info = probeWav(wav);
    CHECK(info.channels == 2);
    CHECK(info.sampleRate == 44'100);
    CHECK(info.frames == 3);
    const AudioBuffer buffer = decodeWav(wav);
    REQUIRE(buffer.samples.size() == 6);
    CHECK(buffer.samples[0] == 0.0f);
    CHECK(buffer.samples[1] == 0.5f);
    CHECK(buffer.samples[2] == -1.0f);
    CHECK(buffer.samples[3] == 32767.0f / 32768.0f);
    CHECK(buffer.samples[4] == -0.5f);
    CHECK(buffer.samples[5] == 1.0f / 32768.0f);
}

TEST_CASE("24-bit PCM decodes to exact floats", "[media]") {
    std::string data;
    for (const std::int32_t s : {0x400000, -0x800000, 0x000001}) {
        const auto u = static_cast<std::uint32_t>(s);
        data.push_back(static_cast<char>(u & 0xFF));
        data.push_back(static_cast<char>((u >> 8) & 0xFF));
        data.push_back(static_cast<char>((u >> 16) & 0xFF));
    }
    const AudioBuffer buffer = decodeWav(pcmWav(1, 48'000, 24, data));
    REQUIRE(buffer.samples.size() == 3);
    CHECK(buffer.samples[0] == 0.5f);
    CHECK(buffer.samples[1] == -1.0f);
    CHECK(buffer.samples[2] == Catch::Approx(1.0 / 8388608.0).margin(1e-12));
}

TEST_CASE("Float WAV encoding round-trips bit for bit", "[media]") {
    AudioBuffer buffer = sine(48'000, 1'000, 440.0, 2);
    buffer.samples[7] = -0.0f;
    buffer.samples[9] = 1.5f;  // over full scale is kept as is
    const std::string wav = encodeWavFloat32(buffer);
    const AudioBuffer decoded = decodeWav(wav);
    CHECK(decoded.info.channels == 2);
    CHECK(decoded.info.sampleRate == 48'000);
    CHECK(decoded.info.frames == 1'000);
    CHECK(decoded.samples == buffer.samples);
    CHECK(std::signbit(decoded.samples[7]));
}

TEST_CASE("Non-WAV and damaged input are rejected", "[media]") {
    CHECK(errorCode("fLaC0000000000000000") == "unsupported_media");
    CHECK(errorCode("") == "unsupported_media");
    std::string truncated = pcmWav(1, 48'000, 16, pcm16({1, 2, 3}));
    truncated.resize(20);
    CHECK(errorCode(truncated) == "decode_failed");
    AudioBuffer bad;
    bad.info = AudioInfo{2, 48'000, 3};
    bad.samples = {0.0f};
    CHECK_THROWS_AS(encodeWavFloat32(bad), MediaError);
}

TEST_CASE("Resampling keeps length, frequency, level and alignment", "[media]") {
    const AudioBuffer input = sine(44'100, 44'100, 1'000.0);
    const AudioBuffer output = resample(input, 48'000);
    CHECK(output.info.sampleRate == 48'000);
    CHECK(output.info.frames == 48'000);
    REQUIRE(output.samples.size() == 48'000);

    // Compare against the ideal sine at the new rate, away from the edges.
    double maxError = 0.0;
    for (std::size_t i = 2'000; i < 46'000; ++i) {
        const double ideal = 0.5 * std::sin(2.0 * std::numbers::pi * 1'000.0 * static_cast<double>(i) / 48'000.0);
        maxError = std::max(maxError, std::abs(static_cast<double>(output.samples[i]) - ideal));
    }
    CHECK(maxError < 1e-4);
}

TEST_CASE("Downsampling and channel separation", "[media]") {
    const AudioBuffer input = sine(48'000, 48'000, 500.0, 2);
    const AudioBuffer output = resample(input, 44'100);
    CHECK(output.info.frames == 44'100);
    CHECK(output.info.channels == 2);
    double maxSum = 0.0;  // channel 1 is the negation of channel 0
    for (std::size_t i = 0; i < 44'100; ++i) {
        maxSum = std::max(maxSum, std::abs(static_cast<double>(output.samples[2 * i] + output.samples[2 * i + 1])));
    }
    CHECK(maxSum < 1e-6);
}

TEST_CASE("Converted length rounds to nearest, ties to even", "[media]") {
    CHECK(resample(sine(44'100, 10, 100.0), 48'000).info.frames == 11);  // 10.88
    CHECK(resample(sine(48'000, 2, 100.0), 24'000).info.frames == 1);    // 1.0
    CHECK(resample(sine(48'000, 3, 100.0), 32'000).info.frames == 2);    // 2.0
    CHECK(resample(sine(48'000, 3, 100.0), 8'000).info.frames == 0);     // 0.5 -> 0
    CHECK(resample(sine(48'000, 9, 100.0), 8'000).info.frames == 2);     // 1.5 -> 2
}

TEST_CASE("Resampling to the same rate is a copy", "[media]") {
    const AudioBuffer input = sine(48'000, 100, 100.0);
    CHECK(resample(input, 48'000).samples == input.samples);
}

#include "support/flac_test_encoder.hpp"

TEST_CASE("FLAC decodes to exact floats across frames and channels", "[media][flac]") {
    std::vector<std::int16_t> samples;
    for (int i = 0; i < 40; ++i) {  // 40 stereo frames: 3 FLAC frames at block size 16
        samples.push_back(static_cast<std::int16_t>(i * 800 - 16'000));
        samples.push_back(static_cast<std::int16_t>(i == 7 ? -32'768 : 32'767 - i));
    }
    const std::string flac = siann::test::encodeFlac16(2, 44'100, samples);
    CHECK(siann::media::detectFormat(flac) == siann::media::FileFormat::flac);
    const AudioInfo info = siann::media::probe(flac);
    CHECK(info.channels == 2);
    CHECK(info.sampleRate == 44'100);
    CHECK(info.frames == 40);

    const AudioBuffer decoded = siann::media::decode(flac);
    REQUIRE(decoded.samples.size() == samples.size());
    for (std::size_t i = 0; i < samples.size(); ++i) {
        INFO("sample " << i);
        CHECK(decoded.samples[i] == static_cast<float>(samples[i]) / 32768.0f);
    }
}

TEST_CASE("Format detection covers WAV and rejects other files", "[media][flac]") {
    const std::string wav = pcmWav(1, 48'000, 16, pcm16({1, 2}));
    CHECK(siann::media::detectFormat(wav) == siann::media::FileFormat::wav);
    CHECK(siann::media::decode(wav).samples.size() == 2);
    CHECK_THROWS_AS(siann::media::detectFormat("OggS0000"), MediaError);
}

TEST_CASE("A FLAC frame with a bad checksum is rejected", "[media][flac]") {
    std::vector<std::int16_t> samples(32, 1'000);
    std::string flac = siann::test::encodeFlac16(1, 48'000, samples);
    flac[flac.size() - 3] ^= 0x01;  // a sample byte in the last frame
    try {
        (void)siann::media::decode(flac);
        FAIL("expected decode_failed");
    } catch (const MediaError& error) {
        CHECK(error.code() == "decode_failed");
    }
}

namespace {

// An RF64 WAV built byte by byte: 10 stereo 16-bit frames of 8192 (0.25), with
// the ds64 sample count set to claimedFrames. dr_wav takes an RF64 file's
// length from that count, unchecked against the data chunk.
std::string rf64Wav(std::uint64_t claimedFrames) {
    std::string out = "RF64";
    const auto putU64 = [&](std::uint64_t v) {
        for (int b = 0; b < 8; ++b) {
            out.push_back(static_cast<char>((v >> (8 * b)) & 0xFF));
        }
    };
    constexpr std::uint32_t dataBytes = 10 * 4;
    putU32(out, 0xFFFF'FFFFu);
    out += "WAVEds64";
    putU32(out, 28);
    putU64(4 + 36 + 24 + 8 + dataBytes);
    putU64(dataBytes);
    putU64(claimedFrames);
    putU32(out, 0);
    out += "fmt ";
    putU32(out, 16);
    putU16(out, 1);
    putU16(out, 2);
    putU32(out, 48'000);
    putU32(out, 192'000);
    putU16(out, 4);
    putU16(out, 16);
    out += "data";
    putU32(out, 0xFFFF'FFFFu);
    for (int i = 0; i < 10 * 2; ++i) {
        putU16(out, static_cast<std::uint16_t>(8'192));
    }
    return out;
}

// Sets the 36-bit total-samples field of the STREAMINFO block encodeFlac16
// writes first: the low nibble of byte 21 and bytes 22 to 25 of the stream.
std::string withFlacTotal(std::string flac, std::uint64_t frames) {
    flac[21] = static_cast<char>((static_cast<unsigned char>(flac[21]) & 0xF0) | ((frames >> 32) & 0x0F));
    for (std::size_t i = 0; i < 4; ++i) {
        flac[22 + i] = static_cast<char>((frames >> (8 * (3 - i))) & 0xFF);
    }
    return flac;
}

// The MediaError code of decoding bytes, "bad_alloc" if an allocation was
// refused, or "no error" (with the buffer in *decoded).
std::string decodeOutcome(const std::string& bytes, AudioBuffer* decoded = nullptr) {
    try {
        AudioBuffer buffer = siann::media::decode(bytes);
        if (decoded != nullptr) {
            *decoded = std::move(buffer);
        }
    } catch (const MediaError& error) {
        return error.code();
    } catch (const std::bad_alloc&) {
        return "bad_alloc";
    }
    return "no error";
}

}  // namespace

TEST_CASE("An in-memory RF64 sample count beyond the data chunk is clamped, not allocated", "[media]") {
    // 2^40 frames claimed over 10 real ones: taken at its word, the header
    // would size the buffer at 8 TiB before a sample was read.
    const std::string lying = rf64Wav(std::uint64_t{1} << 40);
    AudioBuffer decoded;
    std::string outcome;
    bool blown = true;
    {
        const siann::media::testing::AllocationFuse fuse(1u << 20);
        outcome = decodeOutcome(lying, &decoded);
        blown = fuse.blown();
    }
    CHECK_FALSE(blown);
    REQUIRE(outcome == "no error");
    CHECK(decoded.info.channels == 2);
    CHECK(decoded.info.frames == 10);
    CHECK(probeWav(lying).frames == 10);
    CHECK(decoded.samples == std::vector<float>(20, 0.25f));

    // The honest RF64 file decodes to the same buffer.
    const AudioBuffer honest = decodeWav(rf64Wav(10));
    CHECK(honest.info.frames == 10);
    CHECK(honest.samples == decoded.samples);
}

TEST_CASE("A FLAC STREAMINFO total beyond the stream is refused without allocating for the claim",
          "[media][flac]") {
    std::vector<std::int16_t> samples;
    for (int i = 0; i < 40; ++i) {  // 40 stereo frames: 3 FLAC frames at block size 16
        samples.push_back(static_cast<std::int16_t>(i * 800 - 16'000));
        samples.push_back(static_cast<std::int16_t>(-i * 700));
    }
    const std::string honest = siann::test::encodeFlac16(2, 44'100, samples);
    REQUIRE(withFlacTotal(honest, 40) == honest);
    // The most the 36-bit field holds, about 2^36 stereo frames (512 GiB of
    // floats), over 40 real ones.
    const std::string lying = withFlacTotal(honest, (std::uint64_t{1} << 36) - 1);
    CHECK(siann::media::probe(lying).frames == (std::int64_t{1} << 36) - 1);
    std::string outcome;
    bool blown = true;
    {
        const siann::media::testing::AllocationFuse fuse(1u << 20);
        outcome = decodeOutcome(lying);
        blown = fuse.blown();
    }
    CHECK_FALSE(blown);
    CHECK(outcome == "decode_failed");

    // A small lie, one frame more than the stream holds, is refused the same way.
    CHECK(decodeOutcome(withFlacTotal(honest, 41)) == "decode_failed");

    // The honest stream still decodes exactly.
    AudioBuffer decoded;
    REQUIRE(decodeOutcome(honest, &decoded) == "no error");
    CHECK(decoded.info.frames == 40);
    REQUIRE(decoded.samples.size() == samples.size());
    for (std::size_t i = 0; i < samples.size(); ++i) {
        INFO("sample " << i);
        CHECK(decoded.samples[i] == static_cast<float>(samples[i]) / 32768.0f);
    }
}
