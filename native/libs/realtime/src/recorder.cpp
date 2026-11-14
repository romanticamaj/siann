#include "siann/realtime/recorder.hpp"

#include <algorithm>
#include <stdexcept>

namespace siann::realtime {

namespace {

constexpr std::size_t kChunk = 4'096;

// The default take writer: the WAV file of the take.
class WavTakeWriter final : public TakeWriter {
public:
    WavTakeWriter(const std::filesystem::path& file, int channels, std::int64_t sampleRate)
        : writer_(file, channels, sampleRate) {}
    void append(const host::AudioBufferView& source, int frames) override { writer_.append(source, frames); }
    void checkpoint() override { writer_.checkpoint(); }
    void close() override { writer_.close(); }
    std::int64_t frames() const noexcept override { return writer_.frames(); }

private:
    media::WavStreamWriter writer_;
};

}  // namespace

std::string_view endedByName(EndedBy endedBy) noexcept {
    switch (endedBy) {
        case EndedBy::overflow: return "overflow";
        case EndedBy::disk: return "disk";
        case EndedBy::device: return "device";
        case EndedBy::stop: break;
    }
    return "stop";
}

Recorder::Recorder(int channels, Options options)
    : channels_(channels), takeChannels_(channels), options_(std::move(options)), ring_(channels, options_.ringFrames) {
    scratch_.assign(static_cast<std::size_t>(channels), std::vector<float>(kChunk, 0.0f));
    for (auto& c : scratch_) {
        scratchPointers_.push_back(c.data());
    }
}

Recorder::~Recorder() {
    if (writer_) {
        try {
            stop();
        } catch (...) {
        }
    }
}

void Recorder::start(const std::filesystem::path& file, std::int64_t sampleRate,
                     std::function<void(std::int64_t)> onStart, std::function<void(std::int64_t)> onCheckpoint,
                     int takeChannels) {
    if (writer_) {
        throw std::logic_error("the recorder is already recording");
    }
    if (takeChannels < 0 || takeChannels > channels_) {
        throw std::invalid_argument("a take records at most the recorder's channels");
    }
    takeChannels_ = takeChannels == 0 ? channels_ : takeChannels;
    writer_ = options_.writerFactory ? options_.writerFactory(file, takeChannels_, sampleRate)
                                     : std::make_unique<WavTakeWriter>(file, takeChannels_, sampleRate);
    if (!writer_) {
        throw std::logic_error("the take writer factory made no writer");
    }
    file_ = file;
    onStart_ = std::move(onStart);
    onCheckpoint_ = std::move(onCheckpoint);
    startReported_ = false;
    ring_.reset();  // the audio thread is not capturing: armed_ is false
    startPosition_.store(kNoStart, std::memory_order_relaxed);
    overflows_.store(0, std::memory_order_relaxed);
    captured_.store(0, std::memory_order_relaxed);
    durableFrames_.store(0, std::memory_order_relaxed);
    diskFailed_.store(false, std::memory_order_relaxed);
    lastCheckpoint_ = std::chrono::steady_clock::now();
    if (options_.writerThread) {
        writerRunning_.store(true, std::memory_order_release);
        thread_ = std::thread([this] { writerLoop(); });
    }
    armed_.store(true, std::memory_order_release);
}

Recorder::Result Recorder::stop() {
    if (!writer_) {
        throw std::logic_error("the recorder is not recording");
    }
    // Sequentially consistent on both sides (store then load), so either the
    // audio thread sees armed_ false or this loop sees it inside capture().
    armed_.store(false);
    while (inCapture_.load()) {
        std::this_thread::yield();  // bounded by one device block
    }
    writerRunning_.store(false, std::memory_order_release);
    if (thread_.joinable()) {
        thread_.join();
    }
    drain();
    if (!diskFailed()) {
        try {
            writer_->close();
            durableFrames_.store(writer_->frames(), std::memory_order_release);
        } catch (...) {
            fail();
        }
    } else {
        try {
            writer_->close();  // what was written gets a header if it can
        } catch (...) {
        }
    }
    const std::uint64_t lost = overflows_.load(std::memory_order_relaxed);
    Result result{file_, writer_->frames(), startPosition_.load(std::memory_order_acquire), lost,
                  diskFailed() ? EndedBy::disk : lost > 0 ? EndedBy::overflow : EndedBy::stop};
    if (result.startPosition == kNoStart) {
        result.startPosition = 0;
    }
    writer_.reset();
    std::function<void(std::int64_t)> onCheckpoint = std::move(onCheckpoint_);
    onStart_ = nullptr;
    onCheckpoint_ = nullptr;
    if (onCheckpoint && result.endedBy != EndedBy::disk) {
        try {
            onCheckpoint(result.frames);  // close() checkpointed every frame
        } catch (...) {
        }
    }
    return result;
}

void Recorder::fail() noexcept {
    diskFailed_.store(true, std::memory_order_release);
}

void Recorder::drain() noexcept {
    if (!writer_ || diskFailed()) {
        return;  // after a failure nothing more is written; the take has ended
    }
    try {
        drainOrThrow();
    } catch (...) {
        fail();
    }
}

void Recorder::drainOrThrow() {
    for (;;) {
        const std::size_t available = ring_.readable();
        if (available == 0) {
            break;
        }
        if (!startReported_) {
            // Data in the ring means the start is known (stored before the data).
            if (onStart_) {
                onStart_(startPosition_.load(std::memory_order_acquire));
            }
            startReported_ = true;
        }
        const std::size_t n = std::min(available, kChunk);
        const host::AudioBufferView view{scratchPointers_.data(), takeChannels_, static_cast<int>(n)};
        ring_.read(view, 0, n);
        writer_->append(view, static_cast<int>(n));
    }
    const auto now = std::chrono::steady_clock::now();
    if (now - lastCheckpoint_ >= options_.checkpointInterval) {
        writer_->checkpoint();
        lastCheckpoint_ = now;
        const std::int64_t durable = writer_->frames();  // every appended frame is in the flushed header
        durableFrames_.store(durable, std::memory_order_release);
        if (onCheckpoint_) {
            try {
                onCheckpoint_(durable);
            } catch (...) {
                // The owner's report (a ready file, say) is retried at the next
                // checkpoint; it never ends the take.
            }
        }
    }
}

void Recorder::writerLoop() {
    while (writerRunning_.load(std::memory_order_acquire)) {
        drain();
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
}

void Recorder::capture(const host::AudioBufferView& input, std::int64_t timelinePosition, bool playing) noexcept {
    inCapture_.store(true);
    std::int64_t frames = input.frames;
    if (options_.maxFrames >= 0) {
        // Only this thread writes captured_ while armed.
        frames = std::min(frames, options_.maxFrames - captured_.load(std::memory_order_relaxed));
    }
    if (armed_.load() && playing && frames > 0 && !diskFailed_.load(std::memory_order_acquire)) {
        if (startPosition_.load(std::memory_order_relaxed) == kNoStart) {
            startPosition_.store(timelinePosition, std::memory_order_release);
        }
        const auto n = static_cast<std::size_t>(frames);
        // Reported, never a block. After the first block that did not fit the
        // take has ended: writing later blocks would leave a hole in it.
        if (overflows_.load(std::memory_order_relaxed) > 0 || ring_.writable() < n) {
            overflows_.fetch_add(1, std::memory_order_release);
        } else {
            ring_.write(input, n);
            captured_.fetch_add(frames, std::memory_order_release);
        }
    }
    inCapture_.store(false, std::memory_order_release);
}

}  // namespace siann::realtime
