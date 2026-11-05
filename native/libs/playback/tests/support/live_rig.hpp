#pragma once

// The live playback rig shared by the playback tests: a session fixture with
// two tracks of distinct WAV media, an engine on a manual audio device pumped
// block by block (driver ticks and butler passes in between), and the
// offline render it is compared with.

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <random>
#include <string>
#include <vector>

#include "siann/command/command.hpp"
#include "siann/engine/offline.hpp"
#include "siann/hash/json.hpp"
#include "siann/host/manual_audio_device.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/playback/playback_engine.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/session.hpp"

namespace live_rig {

namespace fs = std::filesystem;
using namespace siann;
using command::Command;
using model::Document;
using playback::PlaybackEngine;
using playback::PlaybackOptions;
using session::Session;

inline constexpr int kBlock = 256;

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-live-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

// Every sample distinct, so any misalignment shows.
inline media::AudioBuffer distinct(int channels, std::int64_t frames) {
    media::AudioBuffer b;
    b.info = media::AudioInfo{channels, 48'000, frames};
    for (std::int64_t i = 0; i < frames; ++i) {
        if (channels == 1) {
            b.samples.push_back(static_cast<float>(i % 6'007) / 7'000.0f + 0.0001f);
        } else {
            b.samples.push_back(static_cast<float>(i % 9'973) / 10'000.0f);
            b.samples.push_back(-static_cast<float>(i % 7'919) / 10'000.0f);
        }
    }
    return b;
}

inline Command cmd(const std::string& json) {
    return Command::fromJson(json::parse(json));
}

inline std::string place(const std::string& clipId, const std::string& trackId, const std::string& mediaId,
                  std::int64_t at, std::int64_t from, std::int64_t length) {
    return R"({"op":"clip.place","clipId":")" + clipId + R"(","trackId":")" + trackId + R"(","mediaId":")" +
           mediaId + R"(","position":{"domain":"audio","value":")" + std::to_string(at) +
           R"("},"sourceStart":")" + std::to_string(from) + R"(","length":")" + std::to_string(length) + R"("})";
}

inline std::string addTrack(const std::string& trackId, int channels = 2) {
    return R"({"op":"track.add","trackId":")" + trackId + R"(","name":")" + trackId + R"(","channels":)" +
           std::to_string(channels) + "}";
}

// Two tracks with distinct WAV media, one stereo and one mono.
struct Fixture {
    TempDir dir;
    Session session;

    Fixture() : session(Session::create(dir.path() / "Song.siann", Document::create("Song", 48'000), "test", "t0")) {
        importWav("med_st", 2, 60'000);
        importWav("med_mono", 1, 40'000);
        exec(addTrack("trk_a"));
        exec(addTrack("trk_b"));
        exec(place("clp_a", "trk_a", "med_st", 0, 0, 50'000));
        exec(place("clp_b", "trk_b", "med_mono", 1'000, 200, 35'000));
    }

    void exec(const std::string& json) { session.commit({cmd(json)}, "test", "t"); }
    const Document& doc() const { return session.history().head().document; }
    fs::path bundle() const { return session.bundlePath(); }

    void importWav(const std::string& mediaId, int channels, std::int64_t frames) {
        const fs::path file = dir.path() / (mediaId + ".wav");
        io::writeFileAtomic(file, media::encodeWavFloat32(distinct(channels, frames)));
        session::importMedia(session, file, mediaId, "test", "t");
    }
};

inline PlaybackOptions testOptions() {
    PlaybackOptions o;
    o.maxBlockFrames = kBlock;
    o.fadeFrames = kBlock;  // a duck or a rise is exactly one block
    o.ringFrames = 8'192;
    o.butler = realtime::Butler::Options{2'048, 512, std::chrono::microseconds(200)};
    o.butlerThread = false;  // the test drives the butler
    return o;
}

inline host::AudioDeviceConfig deviceConfig() {
    host::AudioDeviceConfig c;
    c.sampleRate = 48'000;
    c.bufferFrames = kBlock;
    c.outputChannels = 2;
    return c;
}

// A loaded engine playing on a manual device. Each pumped block is followed by
// the engine's tick (retire bookkeeping and compiles), a butler pass and a
// second tick (publishing what the butler prefilled).
struct Live {
    host::ManualAudioDevice device;
    PlaybackEngine engine;
    std::vector<std::vector<float>> out{2};
    std::vector<bool> inFlightBefore;  // per block: a graph waited in the inbox

    explicit Live(Session& session, const PlaybackOptions& options = testOptions()) : engine(session, options) {
        engine.load();
        engine.start(device, deviceConfig());
    }
    ~Live() { engine.stop(); }

    void pump(int blocks) {
        for (int b = 0; b < blocks; ++b) {
            inFlightBefore.push_back(engine.driver().transitionInFlight());
            device.pumpAll(1, out);
            engine.tick();
            engine.butler().runOnce();
            engine.tick();
        }
    }

    int blockCount() const { return static_cast<int>(out[0].size()) / kBlock; }

    // The last block that started with a graph in the inbox: it ducks the old
    // graph, the next one rises with the new graph.
    int lastDuckBlock() const {
        for (int b = static_cast<int>(inFlightBefore.size()) - 1; b >= 0; --b) {
            if (inFlightBefore[static_cast<std::size_t>(b)]) {
                return b;
            }
        }
        return -1;
    }
};

inline std::vector<std::vector<float>> offline(const Document& document, const fs::path& bundle, std::int64_t frames) {
    const media::AudioBuffer rendered =
        engine::renderOffline(document, engine::loadMedia(document, bundle), engine::RenderOptions{0, frames, kBlock});
    std::vector<std::vector<float>> planar(2);
    for (std::int64_t i = 0; i < frames; ++i) {
        planar[0].push_back(rendered.samples[static_cast<std::size_t>(i * 2)]);
        planar[1].push_back(rendered.samples[static_cast<std::size_t>(i * 2 + 1)]);
    }
    return planar;
}

inline std::vector<float> blocks(const std::vector<float>& v, int fromBlock, int toBlock) {
    return std::vector<float>(v.begin() + static_cast<std::ptrdiff_t>(fromBlock) * kBlock,
                              v.begin() + static_cast<std::ptrdiff_t>(toBlock) * kBlock);
}

// Output blocks [from, to) on both channels equal the offline render.
inline bool matches(const Live& live, const std::vector<std::vector<float>>& reference, int from, int to) {
    return blocks(live.out[0], from, to) == blocks(reference[0], from, to) &&
           blocks(live.out[1], from, to) == blocks(reference[1], from, to);
}

inline std::int64_t framesOf(const Live& live) {
    return static_cast<std::int64_t>(live.blockCount()) * kBlock;
}

}  // namespace live_rig
