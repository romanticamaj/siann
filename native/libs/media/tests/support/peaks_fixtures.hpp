#pragma once

// The synthetic signals of fixtures/peaks (scripts/generate-peaks-fixtures.js),
// rebuilt from each fixture's JSON description with the same double
// expressions rounded once to float, so a C++ pyramid of them can be compared
// byte for byte with the Node generator's files. Test-only, header-only.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

#include "siann/hash/json.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"

namespace siann::media::testing {

inline std::filesystem::path peaksFixtureDir() {
    return std::filesystem::path(SIANN_FIXTURES_DIR) / "peaks";
}

// The fixture names (each <name>.json beside its <name>.peaks), sorted.
inline std::vector<std::string> peaksFixtureNames() {
    std::vector<std::string> names;
    for (const auto& entry : std::filesystem::directory_iterator(peaksFixtureDir())) {
        if (entry.path().extension() == ".json") {
            names.push_back(entry.path().stem().string());
        }
    }
    std::sort(names.begin(), names.end());
    return names;
}

inline json::Value peaksFixture(const std::string& name) {
    return json::parse(io::readFile(peaksFixtureDir() / (name + ".json")));
}

inline std::string peaksFixtureBytes(const std::string& name) {
    return io::readFile(peaksFixtureDir() / (name + ".peaks"));
}

inline double fixtureNumber(const json::Value& object, const char* key) {
    const json::Value* member = object.find(key);
    if (member == nullptr) {
        throw std::runtime_error(std::string("fixture signal without ") + key);
    }
    return member->asNumber();
}

// The interleaved float samples a fixture's "signal" describes.
inline AudioBuffer fixtureSignal(const json::Value& fixture) {
    const json::Value& signal = *fixture.find("signal");
    const std::string& kind = signal.find("kind")->asString();
    const int channels = static_cast<int>(fixtureNumber(signal, "channels"));
    const std::int64_t frames = static_cast<std::int64_t>(fixtureNumber(signal, "frames"));
    AudioBuffer buffer;
    buffer.info = AudioInfo{channels, static_cast<std::int64_t>(fixtureNumber(signal, "sampleRate")), frames};
    buffer.samples.reserve(static_cast<std::size_t>(frames * channels));
    for (std::int64_t i = 0; i < frames; ++i) {
        for (int c = 0; c < channels; ++c) {
            float value = 0.0f;
            if (kind == "square") {
                const double period = fixtureNumber(signal, "period");
                const double amplitude = fixtureNumber(signal, "amplitude");
                const double shifted = static_cast<double>(i) + static_cast<double>(c) * period / 4.0;
                const bool high = static_cast<std::int64_t>(std::floor(shifted / (period / 2.0))) % 2 == 0;
                value = static_cast<float>(high ? amplitude : -amplitude);
            } else if (kind == "ramp") {
                const double ramp = 2.0 * static_cast<double>(i) / static_cast<double>(frames - 1) - 1.0;
                value = static_cast<float>(c % 2 == 0 ? ramp : -ramp);
            } else if (kind != "silence") {
                throw std::runtime_error("unknown fixture signal kind " + kind);
            }
            buffer.samples.push_back(value);
        }
    }
    return buffer;
}

}  // namespace siann::media::testing
