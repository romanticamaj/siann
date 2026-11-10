// Peak pyramids (architecture spec, Protocol v0 item 23;
// docs/schemas/protocol-peaks-v0.md): the C++ producer against the Node
// generator's fixtures in fixtures/peaks, and the parser's refusals.

#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <filesystem>
#include <random>
#include <string>
#include <utility>
#include <vector>

#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/media/memory_reader.hpp"
#include "siann/media/peaks.hpp"
#include "support/peaks_fixtures.hpp"

namespace fs = std::filesystem;
using siann::media::AudioBuffer;
using siann::media::AudioInfo;
using siann::media::MediaError;
using siann::media::MemoryMediaReader;
using siann::media::PeakPyramid;

namespace {

AudioBuffer mono(std::int64_t rate, const std::vector<float>& samples) {
    AudioBuffer buffer;
    buffer.info = AudioInfo{1, rate, static_cast<std::int64_t>(samples.size())};
    buffer.samples = samples;
    return buffer;
}

PeakPyramid pyramidOf(const AudioBuffer& buffer) {
    MemoryMediaReader reader(buffer);
    return siann::media::computePeaks(reader);
}

// {min, max} of one bin and channel.
std::pair<int, int> bin(const PeakPyramid& pyramid, std::size_t level, std::uint32_t index, int channel = 0) {
    const auto& values = pyramid.levels.at(level).values;
    const std::size_t at = (static_cast<std::size_t>(index) * static_cast<std::size_t>(pyramid.channels) +
                            static_cast<std::size_t>(channel)) *
                           2;
    return {values.at(at), values.at(at + 1)};
}

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-peaks-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    TempDir(const TempDir&) = delete;
    TempDir& operator=(const TempDir&) = delete;
    const fs::path& path() const { return path_; }

private:
    fs::path path_;
};

}  // namespace

TEST_CASE("a pyramid of the fixture signals is byte-identical to fixtures/peaks/*.peaks", "[media][peaks]") {
    const auto names = siann::media::testing::peaksFixtureNames();
    REQUIRE(names.size() >= 6);
    for (const std::string& name : names) {
        INFO(name);
        const auto fixture = siann::media::testing::peaksFixture(name);
        const std::string expected = siann::media::testing::peaksFixtureBytes(name);
        const PeakPyramid pyramid = pyramidOf(siann::media::testing::fixtureSignal(fixture));
        CHECK(siann::media::encodePeaks(pyramid) == expected);
        // And the parser reads the generator's bytes back to the same pyramid.
        CHECK(siann::media::decodePeaks(expected) == pyramid);
    }
}

TEST_CASE("a partial last bin saturates min/max", "[media][peaks]") {
    // 256 frames at 0.25, then a partial bin of 44 frames beyond full scale.
    std::vector<float> samples(256, 0.25f);
    for (int i = 0; i < 44; ++i) {
        samples.push_back(i % 2 == 0 ? 2.0f : -3.0f);
    }
    const PeakPyramid loud = pyramidOf(mono(48'000, samples));
    REQUIRE(loud.levels.size() == 2);
    CHECK(loud.levels[0].binCount == 2);
    CHECK(bin(loud, 0, 0) == std::pair{8192, 8192});
    CHECK(bin(loud, 0, 1) == std::pair{-32768, 32767});
    CHECK(bin(loud, 1, 0) == std::pair{-32768, 32767});

    // A partial last bin holds only the frames the media has: no zero past the end.
    std::vector<float> positive(300, 0.5f);
    const PeakPyramid quiet = pyramidOf(mono(48'000, positive));
    CHECK(bin(quiet, 0, 1) == std::pair{16384, 16384});
    // Full scale is +-32767; NaN is 0.
    CHECK(siann::media::peakSample(1.0f) == 32767);
    CHECK(siann::media::peakSample(-1.0f) == -32767);
    CHECK(siann::media::peakSample(-1.5f) == -32768);
    CHECK(siann::media::peakSample(std::nanf("")) == 0);
}

TEST_CASE("levels stop at the first bin count of 1", "[media][peaks]") {
    CHECK(pyramidOf(mono(48'000, std::vector<float>(1, 0.1f))).levels.size() == 1);
    CHECK(pyramidOf(mono(48'000, std::vector<float>(256, 0.1f))).levels.size() == 1);
    const PeakPyramid two = pyramidOf(mono(48'000, std::vector<float>(257, 0.1f)));
    REQUIRE(two.levels.size() == 2);
    CHECK(two.levels[0].binFrames == 256);
    CHECK(two.levels[0].binCount == 2);
    CHECK(two.levels[1].binFrames == 1024);
    CHECK(two.levels[1].binCount == 1);
    // 4096 + 1 frames: 17, 5, 2, 1 bins.
    const PeakPyramid four = pyramidOf(mono(48'000, std::vector<float>(4'097, 0.1f)));
    REQUIRE(four.levels.size() == 4);
    CHECK(four.levels[0].binCount == 17);
    CHECK(four.levels[1].binCount == 5);
    CHECK(four.levels[2].binCount == 2);
    CHECK(four.levels[3].binCount == 1);
    CHECK(four.levels[3].binFrames == 16'384);
}

TEST_CASE("a bad magic, version or truncated file fails to parse", "[media][peaks]") {
    const std::string good = siann::media::testing::peaksFixtureBytes("ramp-stereo");
    REQUIRE_NOTHROW(siann::media::decodePeaks(good));
    const auto refuses = [](const std::string& bytes) {
        try {
            siann::media::decodePeaks(bytes);
        } catch (const MediaError& e) {
            return e.code() == "decode_failed";
        }
        return false;
    };
    std::string magic = good;
    magic[0] = 'X';
    CHECK(refuses(magic));
    std::string version = good;
    version[4] = 2;
    CHECK(refuses(version));
    std::string reserved = good;
    reserved[7] = 1;
    CHECK(refuses(reserved));
    for (const std::size_t size : {std::size_t{0}, std::size_t{3}, std::size_t{19}, std::size_t{20}, std::size_t{27},
                                   good.size() - 1}) {
        INFO(size);
        CHECK(refuses(good.substr(0, size)));
    }
    CHECK(refuses(good + std::string(1, '\0')));
    // A level whose binFrames or binCount is not what frames implies.
    std::string binFrames = good;
    binFrames[20] = 1;
    CHECK(refuses(binFrames));
    std::string levels = good;
    levels[6] = 1;
    CHECK(refuses(levels));
}

TEST_CASE("writePeaks writes <bundle>/peaks/<hex>.peaks atomically, and it reads back", "[media][peaks]") {
    TempDir dir;
    const std::string hex(64, 'a');
    const PeakPyramid pyramid =
        pyramidOf(siann::media::testing::fixtureSignal(siann::media::testing::peaksFixture("square-mono")));
    const fs::path written = siann::media::writePeaks(dir.path(), hex, pyramid);
    CHECK(written == dir.path() / "peaks" / (hex + ".peaks"));
    CHECK(written == siann::media::peaksPath(dir.path(), hex));
    CHECK(siann::io::readFile(written) == siann::media::testing::peaksFixtureBytes("square-mono"));
    CHECK_FALSE(fs::exists(dir.path() / "peaks" / (hex + ".peaks.tmp")));
    CHECK(siann::media::decodePeaks(siann::io::readFile(written)) == pyramid);
}
