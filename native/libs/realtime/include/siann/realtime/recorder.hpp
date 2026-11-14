#pragma once

// Recording (architecture spec, "Recording" and the `recordOutbox` queue). The
// audio thread copies input blocks into an SPSC frame ring together with the
// timeline position of the first captured frame; a writer thread drains the
// ring into a take writer (a WavStreamWriter) and checkpoints the file every
// second. A block that does not fit (the writer fell behind) ends the take: it
// is counted as an overflow and nothing later is captured, so a take is always
// one contiguous run of the input.
//
// Before the first audio is written, the writer thread calls onStart with the
// timeline position of the first frame, so the session can make the take
// manifest durable: any audio on disk always has a known position.
//
// m5b-engine-record: every end is named (EndedBy). A failure of the take writer
// or of onStart is caught where it happens (the writer thread, or whoever calls
// drain()), never escapes, ends the take as `disk` and keeps what was written;
// the audio thread captures nothing more. A recorder with room for N channels
// records a take of fewer (start's takeChannels), so each capture bank slot
// records a mono or a stereo take from one preallocated ring.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <limits>
#include <memory>
#include <string_view>
#include <thread>
#include <vector>

#include "siann/host/buffer.hpp"
#include "siann/media/wav_stream_writer.hpp"
#include "siann/realtime/disk_stream.hpp"

namespace siann::realtime {

// Why a take ended (spec, "Recording"): asked for (or maxFrames reached), a
// block that did not fit the ring, a failure of the writer, or the device
// stopping (set by the owner; the recorder never reports it).
enum class EndedBy : std::uint8_t { stop, overflow, disk, device };

// "stop", "overflow", "disk" or "device".
std::string_view endedByName(EndedBy endedBy) noexcept;

// Where a take's frames go: a WavStreamWriter unless Recorder::Options::
// writerFactory says otherwise (tests inject a failing disk). Used on the
// writer side only.
class TakeWriter {
public:
    virtual ~TakeWriter() = default;
    virtual void append(const host::AudioBufferView& source, int frames) = 0;
    virtual void checkpoint() = 0;
    virtual void close() = 0;
    virtual std::int64_t frames() const noexcept = 0;
};

using TakeWriterFactory =
    std::function<std::unique_ptr<TakeWriter>(const std::filesystem::path& file, int channels, std::int64_t sampleRate)>;

class Recorder {
public:
    struct Options {
        std::size_t ringFrames = 1u << 18;  // about 5 s at 48 kHz
        std::chrono::milliseconds checkpointInterval{1'000};
        bool writerThread = true;  // tests may drain by hand with drain()
        // Captures at most this many frames per take (mid-block if needed);
        // negative: no cap.
        std::int64_t maxFrames = -1;
        // Makes each take's writer; empty is a WavStreamWriter.
        TakeWriterFactory writerFactory;
    };

    struct Result {
        std::filesystem::path file;
        std::int64_t frames = 0;
        std::int64_t startPosition = 0;  // timeline sample of the first frame
        // Blocks not captured because of an overflow (an error): the block that
        // did not fit and every later one. The take ends before the first.
        std::uint64_t overflows = 0;
        // disk when the writer failed, else overflow when a block did not fit,
        // else stop.
        EndedBy endedBy = EndedBy::stop;
    };

    static constexpr std::int64_t kNoStart = std::numeric_limits<std::int64_t>::min();

    Recorder(int channels, Options options);
    ~Recorder();
    Recorder(const Recorder&) = delete;
    Recorder& operator=(const Recorder&) = delete;

    int channels() const noexcept { return channels_; }

    // Control side. onStart runs on the writer side before the first write; if
    // it throws, the take ends as disk with nothing written. onCheckpoint runs
    // on the writer side after each checkpoint has been flushed, with the frames
    // the WAV header now makes durable (an exception of its own is ignored);
    // stop() reports its final checkpoint too (on the calling thread, after the
    // writer thread has ended). takeChannels (0: all) records the first that
    // many channels of each captured block.
    void start(const std::filesystem::path& file, std::int64_t sampleRate,
               std::function<void(std::int64_t startPosition)> onStart = {},
               std::function<void(std::int64_t durableFrames)> onCheckpoint = {}, int takeChannels = 0);

    // Control side. Stops capturing, waits until the audio thread has left
    // capture() (at most one block), writes the rest and closes the file. A
    // writer failure on the way is the result's endedBy, never an exception.
    Result stop();

    bool recording() const noexcept { return armed_.load(std::memory_order_acquire); }

    // Any thread: the take has reached Options::maxFrames.
    bool captureComplete() const noexcept {
        return options_.maxFrames >= 0 && captured_.load(std::memory_order_acquire) >= options_.maxFrames;
    }

    // Any thread: a block did not fit in the ring, so the take has ended.
    bool overflowed() const noexcept { return overflows_.load(std::memory_order_acquire) > 0; }

    // Any thread: the writer failed (or onStart threw), so the take has ended.
    bool diskFailed() const noexcept { return diskFailed_.load(std::memory_order_acquire); }

    // Any thread: the audio thread captures nothing more for this take.
    bool captureEnded() const noexcept { return captureComplete() || overflowed() || diskFailed(); }

    // Any thread: the timeline position of the take's first frame (kNoStart
    // until captured), the frames the last checkpoint made durable, and the
    // blocks lost to an overflow.
    std::int64_t startPosition() const noexcept { return startPosition_.load(std::memory_order_acquire); }
    std::int64_t durableFrames() const noexcept { return durableFrames_.load(std::memory_order_acquire); }
    std::uint64_t overflows() const noexcept { return overflows_.load(std::memory_order_acquire); }

    // Writer side, for tests (and owners) that run without the writer thread.
    // Never throws: a writer failure ends the take as disk.
    void drain() noexcept;

    // Audio thread: called once per device block, before the graph runs.
    void capture(const host::AudioBufferView& input, std::int64_t timelinePosition, bool playing) noexcept;

private:
    void writerLoop();
    void drainOrThrow();
    void fail() noexcept;

    int channels_;
    int takeChannels_;
    Options options_;
    FrameRing ring_;
    std::unique_ptr<TakeWriter> writer_;
    std::function<void(std::int64_t)> onStart_;
    std::function<void(std::int64_t)> onCheckpoint_;
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
    std::atomic<std::int64_t> captured_{0};  // frames written to the ring this take
    std::atomic<std::int64_t> durableFrames_{0};
    std::atomic<bool> diskFailed_{false};
};

}  // namespace siann::realtime
