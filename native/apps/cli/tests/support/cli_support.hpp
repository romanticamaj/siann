#pragma once

// Shared helpers for the realtime CLI tests: a temporary directory, an
// in-process runCli() that parses its JSON, and a generated test tone.

#include <cmath>
#include <cstdint>
#include <filesystem>
#include <random>
#include <sstream>
#include <string>
#include <vector>

#include "siann/cli/cli.hpp"
#include "siann/hash/json.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"

namespace siann::cli::test {

inline std::filesystem::path u8path(const std::string& text) {
    return std::filesystem::path(std::u8string(text.begin(), text.end()));
}

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = std::filesystem::temp_directory_path() /
                ("siann-cli-rt-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        std::filesystem::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        std::filesystem::remove_all(path_, ec);
    }
    TempDir(const TempDir&) = delete;
    TempDir& operator=(const TempDir&) = delete;

    std::string str(const std::string& name) const {
        const auto u8 = (path_ / u8path(name)).u8string();
        return std::string(u8.begin(), u8.end());
    }

private:
    std::filesystem::path path_;
};

struct CliResult {
    int exitCode = 0;
    json::Value json;
};

inline CliResult runJson(std::vector<std::string> args) {
    args.push_back("--time");
    args.push_back("2026-11-03T00:00:00Z");
    std::ostringstream out;
    const int code = runCli(args, out);
    return CliResult{code, json::parse(out.str())};
}

inline std::string errorCode(const CliResult& r) {
    const json::Value* error = r.json.find("error");
    return error == nullptr ? std::string() : error->find("code")->asString();
}

// A mono sine at 440 Hz, -12 dBFS.
inline void writeTone(const std::string& file, std::int64_t rate, std::int64_t frames) {
    media::AudioBuffer buffer;
    buffer.info = media::AudioInfo{1, rate, frames};
    buffer.samples.resize(static_cast<std::size_t>(frames));
    const double step = 2.0 * 3.14159265358979323846 * 440.0 / static_cast<double>(rate);
    for (std::int64_t i = 0; i < frames; ++i) {
        buffer.samples[static_cast<std::size_t>(i)] = static_cast<float>(0.25 * std::sin(step * static_cast<double>(i)));
    }
    io::writeFileAtomic(u8path(file), media::encodeWavFloat32(buffer));
}

// A 48 kHz bundle with one mono track t1 holding one half-second clip.
inline void createDemoBundle(const TempDir& dir, const std::string& bundle) {
    const std::string tone = dir.str("tone.wav");
    writeTone(tone, 48'000, 24'000);
    runJson({"create", bundle, "--name", "Demo"});
    runJson({"import", bundle, tone, "--media-id", "med_tone"});
    runJson({"plan", bundle, R"([
        {"op":"track.add","trackId":"t1","name":"One","channels":1},
        {"op":"clip.place","clipId":"clp_a","trackId":"t1","mediaId":"med_tone",
         "position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"24000"}])"});
}

inline std::size_t clipsOn(const json::Value& info, const std::string& trackId) {
    for (const json::Value& track : info.find("tracks")->asArray()) {
        if (track.find("id")->asString() == trackId) {
            return static_cast<std::size_t>(track.find("clips")->asNumber());
        }
    }
    return 0;
}

}  // namespace siann::cli::test
