#pragma once

// Shared helpers for the realtime CLI tests: a temporary directory, an
// in-process runCli() that parses its JSON, a generated test tone, and the
// readers for `record --ready-file` and takes recorded from the fake device's
// counter input.

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <optional>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "siann/cli/cli.hpp"
#include "siann/hash/json.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/session.hpp"

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

// The state `record --ready-file` publishes.
struct ReadyState {
    std::string takeId;
    std::optional<std::int64_t> startPosition;
    std::int64_t durableFrames = 0;
};

// Reads the ready file while the recording child may be replacing it.
// nullopt when it does not exist yet, cannot be opened right now or is not a
// complete ready object; the caller asks again. On Windows it is opened with
// FILE_SHARE_DELETE, so the child's atomic replace never fails because of it.
inline std::optional<ReadyState> readReadyFile(const std::filesystem::path& file) {
    std::string bytes;
#if defined(_WIN32)
    const HANDLE h = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                 nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        return std::nullopt;
    }
    char chunk[4096];
    DWORD got = 0;
    while (ReadFile(h, chunk, sizeof(chunk), &got, nullptr) && got > 0) {
        bytes.append(chunk, got);
    }
    CloseHandle(h);
#else
    std::ifstream in(file, std::ios::binary);
    if (!in) {
        return std::nullopt;
    }
    bytes.assign(std::istreambuf_iterator<char>(in), {});
#endif
    try {
        const json::Value v = json::parse(bytes);
        const json::Value* takeId = v.find("takeId");
        const json::Value* start = v.find("startPosition");
        const json::Value* durable = v.find("durableFrames");
        if (takeId == nullptr || start == nullptr || durable == nullptr) {
            return std::nullopt;
        }
        ReadyState state;
        state.takeId = takeId->asString();
        if (!start->isNull()) {
            state.startPosition = std::stoll(start->asString());
        }
        state.durableFrames = std::stoll(durable->asString());
        return state;
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

// Polls the ready file until `done` holds for its state, the child stops
// running, or `guard` passes (a hung child). The ready file is the
// synchronization; the guard is not. Returns the last state that satisfied
// `done`, or nullopt.
inline std::optional<ReadyState> waitForReady(const std::filesystem::path& file,
                                              const std::function<bool()>& childRunning,
                                              const std::function<bool(const ReadyState&)>& done,
                                              std::chrono::seconds guard) {
    const auto deadline = std::chrono::steady_clock::now() + guard;
    while (childRunning() && std::chrono::steady_clock::now() < deadline) {
        const std::optional<ReadyState> state = readReadyFile(file);
        if (state && done(*state)) {
            return state;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));  // poll interval
    }
    return std::nullopt;
}

// The committed media file of a recorded take (clip "clp_<takeId>"), from a
// session the caller holds open (a second open of the bundle is session_locked).
inline std::filesystem::path takeMediaFile(const session::Session& s, const std::string& takeId) {
    const std::filesystem::path& bundle = s.bundlePath();
    const model::Document& doc = s.history().head().document;
    const model::Clip* clip = doc.clip("clp_" + takeId);
    if (clip == nullptr) {
        throw std::runtime_error("no clip for take " + takeId);
    }
    const model::Media* media = doc.media(clip->mediaId);
    if (media == nullptr) {
        throw std::runtime_error("no media for take " + takeId);
    }
    return session::mediaPath(bundle, media->contentHash, media->format);
}

inline std::filesystem::path takeMediaFile(const std::filesystem::path& bundle, const std::string& takeId) {
    const session::Session s = session::Session::open(bundle);
    return takeMediaFile(s, takeId);
}

// What checkCounterWav found in a float WAV recorded from the counter input.
struct CounterCheck {
    bool readable = false;          // a float32 WAV with a data chunk
    std::int64_t frames = 0;        // data frames per the header
    std::int64_t firstCounter = -1; // counter value of frame 0
    std::int64_t mismatchAt = -1;   // first frame off the counter, -1 if none
    std::string problem;
};

// Checks, in chunks (a 10-minute take is 115 MB), that every sample of every
// channel is ((s0 + frame) mod 2^24) * 2^-24 for the s0 of the first frame:
// the take is one consecutive run of the fake device's counter input, with no
// dropped or repeated block.
inline CounterCheck checkCounterWav(const std::filesystem::path& file) {
    CounterCheck out;
    std::ifstream in(file, std::ios::binary);
    const auto le = [](const char* p, int bytes) {
        std::uint32_t v = 0;
        for (int i = bytes - 1; i >= 0; --i) {
            v = (v << 8) | static_cast<unsigned char>(p[i]);
        }
        return v;
    };
    char riff[12];
    if (!in.read(riff, 12) || std::string(riff, 4) != "RIFF" || std::string(riff + 8, 4) != "WAVE") {
        out.problem = "not a RIFF/WAVE file";
        return out;
    }
    int channels = 0;
    bool isFloat = false;
    std::uint32_t dataBytes = 0;
    char chunk[8];
    for (;;) {
        if (!in.read(chunk, 8)) {
            out.problem = "no data chunk";
            return out;
        }
        const std::uint32_t size = le(chunk + 4, 4);
        if (std::string(chunk, 4) == "fmt ") {
            std::string fmt(size, '\0');
            if (size < 16 || !in.read(fmt.data(), static_cast<std::streamsize>(size))) {
                out.problem = "short fmt chunk";
                return out;
            }
            const std::uint32_t tag = le(fmt.data(), 2);
            channels = static_cast<int>(le(fmt.data() + 2, 2));
            const std::uint32_t bits = le(fmt.data() + 14, 2);
            // WAVE_FORMAT_IEEE_FLOAT, or WAVE_FORMAT_EXTENSIBLE with the float subformat.
            isFloat = bits == 32 && (tag == 3 || (tag == 0xFFFE && size >= 26 && le(fmt.data() + 24, 2) == 3));
            if (size & 1u) {
                in.seekg(1, std::ios::cur);
            }
        } else if (std::string(chunk, 4) == "data") {
            dataBytes = size;
            break;
        } else {
            in.seekg(static_cast<std::streamoff>(size + (size & 1u)), std::ios::cur);
        }
    }
    if (!isFloat || channels <= 0) {
        out.problem = "not a 32-bit float WAV";
        return out;
    }
    out.readable = true;
    const auto frameBytes = static_cast<std::uint32_t>(channels) * 4u;
    out.frames = static_cast<std::int64_t>(dataBytes / frameBytes);

    constexpr std::int64_t kWrap = 1 << 24;
    constexpr double kStep = 1.0 / static_cast<double>(kWrap);
    std::vector<float> buffer(static_cast<std::size_t>(channels) * 65'536u);
    std::int64_t frame = 0;
    while (frame < out.frames) {
        const std::int64_t n = std::min<std::int64_t>(out.frames - frame, 65'536);
        if (!in.read(reinterpret_cast<char*>(buffer.data()), static_cast<std::streamsize>(n * frameBytes))) {
            out.problem = "data chunk shorter than its header";
            out.mismatchAt = frame;
            return out;
        }
        for (std::int64_t i = 0; i < n; ++i) {
            const std::int64_t f = frame + i;
            const float first = buffer[static_cast<std::size_t>(i * channels)];
            if (f == 0) {
                const double scaled = static_cast<double>(first) * static_cast<double>(kWrap);
                if (!(scaled >= 0.0 && scaled < static_cast<double>(kWrap)) || scaled != std::floor(scaled)) {
                    out.problem = "frame 0 is not a counter value";
                    out.mismatchAt = 0;
                    return out;
                }
                out.firstCounter = static_cast<std::int64_t>(scaled);
            }
            const auto expected = static_cast<float>(static_cast<double>((out.firstCounter + f) % kWrap) * kStep);
            for (int c = 0; c < channels; ++c) {
                if (buffer[static_cast<std::size_t>(i * channels + c)] != expected) {
                    out.problem = "sample off the counter";
                    out.mismatchAt = f;
                    return out;
                }
            }
        }
        frame += n;
    }
    return out;
}

}  // namespace siann::cli::test
