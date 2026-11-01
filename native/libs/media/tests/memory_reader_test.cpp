#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <vector>

#include "siann/media/audio.hpp"
#include "siann/media/memory_reader.hpp"

using siann::host::AudioBufferView;
using siann::media::AudioBuffer;
using siann::media::AudioInfo;
using siann::media::MemoryMediaReader;

namespace {

// Interleaved, every sample distinct.
AudioBuffer distinct(int channels, std::int64_t frames) {
    AudioBuffer b;
    b.info = AudioInfo{channels, 44'100, frames};
    for (std::int64_t i = 0; i < frames; ++i) {
        for (int c = 0; c < channels; ++c) {
            b.samples.push_back(static_cast<float>(i) / 1'000.0f + static_cast<float>(c) * 0.25f + 0.001f);
        }
    }
    return b;
}

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

float sample(const AudioBuffer& b, std::int64_t frame, int channel) {
    return b.samples[static_cast<std::size_t>(frame * b.info.channels + channel)];
}

}  // namespace

TEST_CASE("MemoryMediaReader reads planar frames at a position and zero-fills past the end and for extra channels",
          "[media][memory]") {
    const AudioBuffer source = distinct(2, 100);
    MemoryMediaReader reader(source);
    CHECK(reader.info().channels == 2);
    CHECK(reader.info().sampleRate == 44'100);
    CHECK(reader.info().frames == 100);

    SECTION("inside the media") {
        Planar out(2, 30);
        CHECK(reader.read(10, out.view()) == 30);
        for (int i = 0; i < 30; ++i) {
            CHECK(out.data[0][static_cast<std::size_t>(i)] == sample(source, 10 + i, 0));
            CHECK(out.data[1][static_cast<std::size_t>(i)] == sample(source, 10 + i, 1));
        }
    }
    SECTION("past the end") {
        Planar out(2, 30);
        CHECK(reader.read(90, out.view()) == 10);
        for (int i = 0; i < 10; ++i) {
            CHECK(out.data[0][static_cast<std::size_t>(i)] == sample(source, 90 + i, 0));
            CHECK(out.data[1][static_cast<std::size_t>(i)] == sample(source, 90 + i, 1));
        }
        for (int i = 10; i < 30; ++i) {
            CHECK(out.data[0][static_cast<std::size_t>(i)] == 0.0f);
            CHECK(out.data[1][static_cast<std::size_t>(i)] == 0.0f);
        }
        Planar beyond(2, 8);
        CHECK(reader.read(200, beyond.view()) == 0);
        CHECK(beyond.data[0] == std::vector<float>(8, 0.0f));
        CHECK(beyond.data[1] == std::vector<float>(8, 0.0f));
    }
    SECTION("more channels than the media") {
        Planar out(3, 5);
        CHECK(reader.read(0, out.view()) == 5);
        for (int i = 0; i < 5; ++i) {
            CHECK(out.data[0][static_cast<std::size_t>(i)] == sample(source, i, 0));
            CHECK(out.data[1][static_cast<std::size_t>(i)] == sample(source, i, 1));
            CHECK(out.data[2][static_cast<std::size_t>(i)] == 0.0f);
        }
    }
    SECTION("fewer channels than the media") {
        Planar out(1, 5);
        CHECK(reader.read(3, out.view()) == 5);
        for (int i = 0; i < 5; ++i) {
            CHECK(out.data[0][static_cast<std::size_t>(i)] == sample(source, 3 + i, 0));
        }
    }
    SECTION("before the start") {
        Planar out(2, 6);
        CHECK(reader.read(-2, out.view()) == 4);
        CHECK(out.data[0][0] == 0.0f);
        CHECK(out.data[0][1] == 0.0f);
        CHECK(out.data[0][2] == sample(source, 0, 0));
        CHECK(out.data[1][5] == sample(source, 3, 1));
    }
}
