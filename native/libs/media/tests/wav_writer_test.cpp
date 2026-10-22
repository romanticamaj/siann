#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <vector>

#include "siann/media/audio.hpp"
#include "siann/media/wav_stream_writer.hpp"

namespace fs = std::filesystem;
using siann::host::AudioBufferView;
using siann::media::MediaError;
using siann::media::WavStreamWriter;
using siann::media::repairWav;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-wavwriter-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

std::string readAll(const fs::path& file) {
    std::ifstream in(file, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(in), {});
}

// Writes `frames` stereo frames whose values encode their position.
void writeFrames(WavStreamWriter& writer, int first, int frames) {
    std::vector<float> l(static_cast<std::size_t>(frames)), r(static_cast<std::size_t>(frames));
    for (int i = 0; i < frames; ++i) {
        l[static_cast<std::size_t>(i)] = static_cast<float>(first + i) / 100'000.0f;
        r[static_cast<std::size_t>(i)] = -static_cast<float>(first + i) / 100'000.0f;
    }
    float* p[2] = {l.data(), r.data()};
    writer.append(AudioBufferView{p, 2, frames}, frames);
}

}  // namespace

TEST_CASE("Streamed recording round-trips through the WAV decoder", "[media][record]") {
    TempDir dir;
    const fs::path file = dir.path() / "take.wav";
    {
        WavStreamWriter writer(file, 2, 48'000);
        writeFrames(writer, 0, 1'000);
        writer.checkpoint();
        writeFrames(writer, 1'000, 500);
        writer.close();
        CHECK(writer.frames() == 1'500);
    }
    const auto decoded = siann::media::decodeWav(readAll(file));
    REQUIRE(decoded.info.frames == 1'500);
    CHECK(decoded.info.channels == 2);
    CHECK(decoded.info.sampleRate == 48'000);
    for (int i = 0; i < 1'500; ++i) {
        REQUIRE(decoded.samples[static_cast<std::size_t>(i * 2)] == static_cast<float>(i) / 100'000.0f);
    }
}

TEST_CASE("A checkpoint leaves a readable file even if nothing else is written", "[media][record]") {
    TempDir dir;
    const fs::path file = dir.path() / "take.wav";
    WavStreamWriter writer(file, 2, 48'000);
    writeFrames(writer, 0, 300);
    writer.checkpoint();
    // Read while the writer is still open, as recovery would after a crash.
    const auto decoded = siann::media::decodeWav(readAll(file));
    CHECK(decoded.info.frames == 300);
    writer.close();
}

TEST_CASE("Repair keeps every complete frame and drops a torn one", "[media][record]") {
    TempDir dir;
    const fs::path file = dir.path() / "take.wav";
    {
        WavStreamWriter writer(file, 2, 48'000);
        writeFrames(writer, 0, 1'000);
        writer.close();
    }
    // Simulate a crash: the header still says 0 frames and the last frame is torn.
    std::string bytes = readAll(file);
    bytes.resize(bytes.size() - 5);
    for (int i = 4; i < 8; ++i) {
        bytes[static_cast<std::size_t>(i)] = 0;
    }
    for (int i = 52; i < 56; ++i) {
        bytes[static_cast<std::size_t>(i)] = 0;
    }
    std::ofstream(file, std::ios::binary | std::ios::trunc).write(bytes.data(), static_cast<std::streamsize>(bytes.size()));

    const auto result = repairWav(file);
    CHECK(result.frames == 999);
    CHECK(result.droppedBytes == 3);
    const auto decoded = siann::media::decodeWav(readAll(file));
    REQUIRE(decoded.info.frames == 999);
    CHECK(decoded.samples[998 * 2] == 998.0f / 100'000.0f);
}

TEST_CASE("Repair rejects files it did not write", "[media][record]") {
    TempDir dir;
    const fs::path file = dir.path() / "other.wav";
    std::ofstream(file, std::ios::binary) << "RIFF0000WAVEnot ours at all, sorry, nothing to see here......";
    CHECK_THROWS_AS(repairWav(file), MediaError);
}
