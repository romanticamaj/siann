#pragma once

// Disk streaming (architecture spec, revision 3.1, "Locate" and the
// `diskRing[track][2]` and `butlerRequest` queues).
//
// The butler renders each streamed track's clips from media readers into a
// FrameRing; the audio thread's StreamingPlayerNode only reads rings. Every
// track has two slots. Slot ownership is one atomic value:
//   0            the butler owns the slot (free or filling)
//   g (1..)      ready and offered for locate generation g
//   kLive        the audio thread is reading it
// The audio thread claims an offered slot with compare-exchange g -> kLive;
// the butler withdraws an offer with compare-exchange g -> 0. Exactly one of
// them wins, so the butler never resets a slot the audio thread is reading.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/host/interfaces.hpp"
#include "siann/rt/spsc_queue.hpp"

namespace siann::realtime {

// A planar single-producer single-consumer ring of audio frames.
class FrameRing {
public:
    FrameRing(int channels, std::size_t capacityFrames);

    int channels() const noexcept { return static_cast<int>(data_.size()); }
    std::size_t capacity() const noexcept { return mask_ + 1; }

    // Producer.
    std::size_t writable() const noexcept;
    std::size_t write(const host::AudioBufferView& source, std::size_t frames) noexcept;

    // Consumer. Reads into destination starting at `offset`.
    std::size_t readable() const noexcept;
    std::size_t read(const host::AudioBufferView& destination, int offset, std::size_t frames) noexcept;
    std::size_t skip(std::size_t frames) noexcept;

    // Only while neither side is using the ring.
    void reset() noexcept;

private:
    std::vector<std::vector<float>> data_;
    std::size_t mask_;
    alignas(rt::kCacheLine) std::atomic<std::size_t> write_{0};
    alignas(rt::kCacheLine) std::atomic<std::size_t> read_{0};
};

struct StreamClip {
    std::int64_t timelineStart = 0;  // samples
    std::int64_t sourceStart = 0;    // media frames
    std::int64_t length = 0;         // frames
    float gain = 1.0f;
    std::shared_ptr<host::MediaReader> reader;  // used by the butler thread only
};

class Butler;

class DiskStream {
public:
    static constexpr std::uint64_t kLive = std::numeric_limits<std::uint64_t>::max();

    DiskStream(int channels, std::vector<StreamClip> clips, std::size_t ringFrames);

    int channels() const noexcept { return channels_; }
    std::uint64_t underruns() const noexcept { return underruns_.load(std::memory_order_relaxed); }

private:
    friend class Butler;
    friend class StreamingPlayerNode;

    struct Slot {
        Slot(int channels, std::size_t frames) : ring(channels, frames) {}
        FrameRing ring;
        std::atomic<std::uint64_t> state{0};
        std::int64_t start = 0;  // timeline position of the slot's first frame
    };

    int channels_;
    std::vector<StreamClip> clips_;
    std::unique_ptr<Slot> slots_[2];
    std::atomic<std::uint64_t> underruns_{0};
    Butler* butler_ = nullptr;

    // Audio side.
    int liveSlot_ = 0;
    std::uint64_t waitingGeneration_ = 0;  // a locate whose data was not ready yet
    std::size_t framesToSkip_ = 0;         // frames the timeline moved while waiting

    // Butler side.
    int butlerLive_ = 0;
    std::int64_t liveWritePosition_ = 0;
    struct Pending {
        bool active = false;
        std::uint64_t generation = 0;
        int slot = 1;
        std::int64_t writePosition = 0;
        bool offered = false;
    } pending_;
};

// Plays a DiskStream on the audio thread.
class StreamingPlayerNode final : public graph::Node {
public:
    explicit StreamingPlayerNode(DiskStream& stream) : stream_(stream) {}
    int outputChannels() const override { return stream_.channels(); }
    void process(const graph::ProcessContext& context, std::span<const graph::AudioBufferView> inputs,
                 const graph::AudioBufferView& output) noexcept override;
    void onLocate(std::uint64_t generation, std::int64_t position) noexcept override;

private:
    bool tryClaim(std::uint64_t generation) noexcept;
    DiskStream& stream_;
};

class Butler {
public:
    struct Options {
        std::size_t prefillFrames = 12'000;  // 250 ms at 48 kHz
        std::size_t chunkFrames = 1'024;
        std::chrono::microseconds idle{500};
    };

    explicit Butler(Options options);
    ~Butler();
    Butler(const Butler&) = delete;
    Butler& operator=(const Butler&) = delete;

    // Before start(): registers a stream and fills its first slot from 0.
    void addStream(DiskStream& stream);

    void start();
    void stop();

    // Any non-realtime thread: prepare a locate. A newer generation replaces
    // an older one that has not been claimed yet.
    void seek(std::uint64_t generation, std::int64_t target);

    // True when every stream has offered (or already claimed) `generation`.
    bool ready(std::uint64_t generation) const noexcept {
        return generation != 0 && readyGeneration_.load(std::memory_order_acquire) == generation;
    }

    // One pass of the butler loop; tests call it instead of start().
    void runOnce();

private:
    friend class StreamingPlayerNode;
    struct Release {
        DiskStream* stream = nullptr;
        int newLive = 0;
    };

    void render(DiskStream& stream, std::int64_t position, std::size_t frames);
    void topUp(DiskStream& stream, int slot, std::int64_t& writePosition, std::size_t limit);
    bool releaseSlot(const Release& release) noexcept;  // audio thread

    Options options_;
    std::vector<DiskStream*> streams_;
    rt::SpscQueue<Release> releases_{256};
    std::mutex seekMutex_;
    std::optional<std::pair<std::uint64_t, std::int64_t>> seekRequest_;
    std::atomic<std::uint64_t> readyGeneration_{0};
    std::vector<std::vector<float>> scratch_;
    std::vector<float*> scratchPointers_;
    std::vector<std::vector<float>> readBuffer_;
    std::vector<float*> readPointers_;
    std::thread thread_;
    std::atomic<bool> running_{false};
};

}  // namespace siann::realtime
