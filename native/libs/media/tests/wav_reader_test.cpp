#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <vector>

#include "siann/media/audio.hpp"
#include "siann/media/wav_file_reader.hpp"

namespace fs = std::filesystem;
using siann::host::AudioBufferView;
using siann::media::AudioBuffer;
using siann::media::AudioInfo;
using siann::media::MediaError;
using siann::media::WavFileReader;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-wavreader-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    const fs::path& path() const { return path_; }

private:
    fs::path path_;
};

void writeBytes(const fs::path& file, const std::string& bytes) {
    std::ofstream out(file, std::ios::binary);
    out.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
}

AudioBuffer ramp(int channels, std::int64_t frames) {
    AudioBuffer b;
    b.info = AudioInfo{channels, 48'000, frames};
    for (std::int64_t i = 0; i < frames; ++i) {
        for (int c = 0; c < channels; ++c) {
            b.samples.push_back(static_cast<float>(i) / 100'000.0f + static_cast<float>(c) * 0.5f);
        }
    }
    return b;
}

// Planar storage plus a view.
struct Planar {
    std::vector<std::vector<float>> data;
    std::vector<float*> pointers;
    Planar(int channels, int frames)
        : data(static_cast<std::size_t>(channels), std::vector<float>(static_cast<std::size_t>(frames), -9.0f)) {
        for (auto& c : data) {
            pointers.push_back(c.data());
        }
    }
    AudioBufferView view() { return AudioBufferView{pointers.data(), static_cast<int>(pointers.size()),
                                                    static_cast<int>(data.front().size())}; }
};

}  // namespace

TEST_CASE("Streaming reads match a full decode at any position", "[media][stream]") {
    TempDir dir;
    const AudioBuffer source = ramp(2, 10'000);
    const fs::path file = dir.path() / "ramp.wav";
    writeBytes(file, siann::media::encodeWavFloat32(source));

    WavFileReader reader(file, 7);  // a tiny chunk exercises the chunk loop
    CHECK(reader.info().channels == 2);
    CHECK(reader.info().sampleRate == 48'000);
    CHECK(reader.info().frames == 10'000);

    std::mt19937 rng(42);
    for (int trial = 0; trial < 200; ++trial) {
        const auto position = static_cast<std::int64_t>(rng() % 10'000);
        const int frames = 1 + static_cast<int>(rng() % 300);
        Planar dest(2, frames);
        const auto got = reader.read(position, dest.view());
        const auto expected = std::min<std::int64_t>(frames, 10'000 - position);
        REQUIRE(got == expected);
        for (int i = 0; i < frames; ++i) {
            for (int c = 0; c < 2; ++c) {
                const float want = i < got ? source.samples[static_cast<std::size_t>((position + i) * 2 + c)] : 0.0f;
                if (dest.data[static_cast<std::size_t>(c)][static_cast<std::size_t>(i)] != want) {
                    FAIL("mismatch at trial " << trial << " frame " << i << " channel " << c);
                }
            }
        }
    }
}

TEST_CASE("Reading past the end and into extra channels zero-fills", "[media][stream]") {
    TempDir dir;
    const fs::path file = dir.path() / "mono.wav";
    writeBytes(file, siann::media::encodeWavFloat32(ramp(1, 100)));
    WavFileReader reader(file);
    Planar dest(2, 50);
    CHECK(reader.read(80, dest.view()) == 20);
    CHECK(dest.data[0][19] == 99.0f / 100'000.0f);
    CHECK(dest.data[0][20] == 0.0f);
    CHECK(dest.data[1][0] == 0.0f);  // the file has one channel
    CHECK(reader.read(100, dest.view()) == 0);
    CHECK(reader.read(-5, dest.view()) == 0);
}

TEST_CASE("16-bit PCM streams to exact floats", "[media][stream]") {
    TempDir dir;
    std::string data;
    for (int i = 0; i < 64; ++i) {
        const auto v = static_cast<std::uint16_t>(static_cast<std::int16_t>(i * 512 - 16'384));
        data.push_back(static_cast<char>(v & 0xFF));
        data.push_back(static_cast<char>(v >> 8));
    }
    std::string wav = "RIFF";
    const auto putU32 = [&](std::uint32_t v) {
        for (int b = 0; b < 4; ++b) {
            wav.push_back(static_cast<char>((v >> (8 * b)) & 0xFF));
        }
    };
    const auto putU16 = [&](std::uint16_t v) {
        wav.push_back(static_cast<char>(v & 0xFF));
        wav.push_back(static_cast<char>(v >> 8));
    };
    putU32(static_cast<std::uint32_t>(36 + data.size()));
    wav += "WAVEfmt ";
    putU32(16);
    putU16(1);
    putU16(1);
    putU32(48'000);
    putU32(96'000);
    putU16(2);
    putU16(16);
    wav += "data";
    putU32(static_cast<std::uint32_t>(data.size()));
    wav += data;
    const fs::path file = dir.path() / "pcm16.wav";
    writeBytes(file, wav);

    WavFileReader reader(file);
    Planar dest(1, 64);
    REQUIRE(reader.read(0, dest.view()) == 64);
    for (int i = 0; i < 64; ++i) {
        CHECK(dest.data[0][static_cast<std::size_t>(i)] == static_cast<float>(i * 512 - 16'384) / 32'768.0f);
    }
}

TEST_CASE("Non-ASCII paths and bad files", "[media][stream]") {
    TempDir dir;
    const fs::path unicode = dir.path() / fs::path(u8"聲.wav");
    writeBytes(unicode, siann::media::encodeWavFloat32(ramp(1, 10)));
    CHECK(WavFileReader(unicode).info().frames == 10);

    const fs::path text = dir.path() / "notes.wav";
    writeBytes(text, "this is not a wav file");
    CHECK_THROWS_AS(WavFileReader(text), MediaError);
    CHECK_THROWS_AS(WavFileReader(dir.path() / "missing.wav"), MediaError);
}
