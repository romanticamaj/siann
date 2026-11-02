#pragma once

// Shared fixtures for the disk streaming and transport tests: a temporary
// directory, a stereo media file whose samples are all distinct, three
// overlapping clips (offline and streamed), the offline reference render, and
// a graph with one streaming player.

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <random>
#include <string>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/host/interfaces.hpp"
#include "siann/media/audio.hpp"
#include "siann/media/wav_file_reader.hpp"
#include "siann/realtime/disk_stream.hpp"

namespace siann::realtime_test {

namespace fs = std::filesystem;

inline constexpr int kBlock = 64;

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-stream-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

// A stereo file whose every sample is distinct, so misalignment shows.
inline fs::path writeMedia(const fs::path& file, std::int64_t frames) {
    media::AudioBuffer b;
    b.info = media::AudioInfo{2, 48'000, frames};
    for (std::int64_t i = 0; i < frames; ++i) {
        b.samples.push_back(static_cast<float>(i % 9'973) / 10'000.0f);
        b.samples.push_back(-static_cast<float>(i % 7'919) / 10'000.0f);
    }
    const std::string bytes = media::encodeWavFloat32(b);
    std::ofstream(file, std::ios::binary).write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    return file;
}

struct Clips {
    std::vector<graph::ClipPlayerNode::Clip> reference;
    std::vector<realtime::StreamClip> streamed;
};

inline Clips makeClips(const fs::path& file) {
    const auto decoded = media::decodeWav([&] {
        std::ifstream in(file, std::ios::binary);
        return std::string(std::istreambuf_iterator<char>(in), {});
    }());
    auto planar = std::make_shared<graph::PlanarAudio>();
    planar->channels = 2;
    planar->frames = decoded.info.frames;
    planar->data.assign(2, std::vector<float>(static_cast<std::size_t>(planar->frames)));
    for (std::size_t i = 0; i < static_cast<std::size_t>(planar->frames); ++i) {
        planar->data[0][i] = decoded.samples[i * 2];
        planar->data[1][i] = decoded.samples[i * 2 + 1];
    }
    auto reader = std::make_shared<media::WavFileReader>(file);
    // Three clips, two of them overlapping, with gains and trims.
    const struct {
        std::int64_t at, from, length;
        float gain;
    } layout[] = {{1'000, 0, 20'000, 1.0f}, {15'000, 5'000, 30'000, 0.5f}, {60'000, 100, 10'000, 0.25f}};
    Clips clips;
    for (const auto& l : layout) {
        clips.reference.push_back({l.at, l.from, l.length, l.gain, planar});
        clips.streamed.push_back({l.at, l.from, l.length, l.gain, reader});
    }
    return clips;
}

// The reference: the offline clip player rendered at the given position.
class Reference {
public:
    explicit Reference(std::vector<graph::ClipPlayerNode::Clip> clips) {
        graph::GraphBuilder b;
        b.setOutput(b.add(std::make_unique<graph::ClipPlayerNode>(2, std::move(clips)), "clips"));
        graph_ = std::move(b).compile(kBlock);
    }
    std::vector<float> left(std::int64_t position, int frames) {
        std::vector<float> out;
        for (int done = 0; done < frames; done += kBlock) {
            graph_->process(graph::ProcessContext{position + done, kBlock});
            out.insert(out.end(), graph_->output().channel(0), graph_->output().channel(0) + kBlock);
        }
        return out;
    }

private:
    std::unique_ptr<graph::PreparedGraph> graph_;
};

inline std::unique_ptr<graph::PreparedGraph> streamingGraph(realtime::DiskStream& stream) {
    graph::GraphBuilder b;
    b.setOutput(b.add(std::make_unique<realtime::StreamingPlayerNode>(stream), "stream"));
    return std::move(b).compile(kBlock);
}

inline host::AudioDeviceConfig config() {
    host::AudioDeviceConfig c;
    c.sampleRate = 48'000;
    c.bufferFrames = kBlock;
    c.outputChannels = 2;
    return c;
}

inline std::vector<float> slice(const std::vector<float>& v, std::size_t from, std::size_t count) {
    return std::vector<float>(v.begin() + static_cast<std::ptrdiff_t>(from),
                              v.begin() + static_cast<std::ptrdiff_t>(from + count));
}

inline bool silent(const std::vector<float>& v) {
    for (const float s : v) {
        if (s != 0.0f) {
            return false;
        }
    }
    return true;
}

}  // namespace siann::realtime_test
