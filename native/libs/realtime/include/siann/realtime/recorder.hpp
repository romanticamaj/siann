#pragma once

// Recording (architecture spec, "Recording" and the `recordOutbox` queue). The
// audio thread copies input blocks into an SPSC frame ring together with the
// timeline position of the first captured frame; a writer thread drains the
// ring into a WavStreamWriter and checkpoints the file every second.
//
// Before the first audio is written, the writer thread calls onStart with the
// timeline position of the first frame, so the session can make the take
// manifest durable: any audio on disk always has a known position.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <limits>
#include <memory>
#include <thread>
#include <vector>

#include "siann/host/buffer.hpp"
#include "siann/media/wav_stream_writer.hpp"
#include "siann/realtime/disk_stream.hpp"

namespace siann::realtime {

class Recorder {
public:
    struct Options {
        std::size_t ringFrames = 1u << 18;  // about 5 s at 48 kHz
        std::chrono::milliseconds checkpointInterval{1'000};
        bool writerThread = true;  // tests may drain by hand with drain()
    };

    struct Result {
        std::filesystem::path file;
        std::int64_t frames = 0;
        std::int64_t startPosition = 0;  // timeline sample of the first frame
        std::uint64_t overflows = 0;     // blocks that did not fit (an error)
    };

    static constexpr std::int64_t kNoStart = std::numeric_limits<std::int64_t>::min();

    Recorder(int channels, Options options);
    ~Recorder();
    Recorder(const Recorder&) = delete;
    Recorder& operator=(const Recorder&) = delete;

    int channels() const noexcept { return channels_; }

    // Control side. onStart runs on the writer thread before the first write.
    void start(const std::filesystem::path& file, std::int64_t sampleRate,
               std::function<void(std::int64_t startPosition)> onStart = {});

    // Control side. Stops capturing, waits until the audio thread has left
    // capture() (at most one block), writes the rest and closes the file.
    Result stop();

    bool recording() const noexcept { return armed_.load(std::memory_order_acquire); }

    // Writer side, for tests that run without the writer thread.
    void drain();

    // Audio thread: called once per device block, before the graph runs.
    void capture(const host::AudioBufferView& input, std::int64_t timelinePosition, bool playing) noexcept;

private:
    void writerLoop();

    int channels_;
    Options options_;
    FrameRing ring_;
    std::unique_ptr<media::WavStreamWriter> writer_;
    std::function<void(std::int64_t)> onStart_;
    bool startReported_ = false;
    std::filesystem::path file_;
    std::chrono::steady_clock::time_point lastCheckpoint_{};
    std::vector<std::vector<float>> scratch_;
    std::vector<float*> scratchPointers_;
    std::thread thread_;

    std::atomic<bool> armed_{false};
    std::atomic<bool> inCapture_{false};
    std::atomic<bool> writerRunning_{false};
    std::atomic<std::int64_t> startPosition_{kNoStart};
    std::atomic<std::uint64_t> overflows_{0};
};

}  // namespace siann::realtime
