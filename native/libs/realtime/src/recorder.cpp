#include "siann/realtime/recorder.hpp"

#include <algorithm>
#include <stdexcept>

namespace siann::realtime {

namespace {
constexpr std::size_t kChunk = 4'096;
}

Recorder::Recorder(int channels, Options options)
    : channels_(channels), options_(options), ring_(channels, options.ringFrames) {
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
                     std::function<void(std::int64_t)> onStart, std::function<void(std::int64_t)> onCheckpoint) {
    if (writer_) {
        throw std::logic_error("the recorder is already recording");
    }
    writer_ = std::make_unique<media::WavStreamWriter>(file, channels_, sampleRate);
    file_ = file;
    onStart_ = std::move(onStart);
    onCheckpoint_ = std::move(onCheckpoint);
    startReported_ = false;
    ring_.reset();  // the audio thread is not capturing: armed_ is false
    startPosition_.store(kNoStart, std::memory_order_relaxed);
    overflows_.store(0, std::memory_order_relaxed);
    captured_.store(0, std::memory_order_relaxed);
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
    writer_->close();
    Result result{file_, writer_->frames(), startPosition_.load(std::memory_order_acquire),
                  overflows_.load(std::memory_order_relaxed)};
    if (result.startPosition == kNoStart) {
        result.startPosition = 0;
    }
    writer_.reset();
    std::function<void(std::int64_t)> onCheckpoint = std::move(onCheckpoint_);
    onStart_ = nullptr;
    onCheckpoint_ = nullptr;
    if (onCheckpoint) {
        onCheckpoint(result.frames);  // close() checkpointed every frame
    }
    return result;
}

void Recorder::drain() {
    if (!writer_) {
        return;
    }
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
        const host::AudioBufferView view{scratchPointers_.data(), channels_, static_cast<int>(n)};
        ring_.read(view, 0, n);
        writer_->append(view, static_cast<int>(n));
    }
    const auto now = std::chrono::steady_clock::now();
    if (now - lastCheckpoint_ >= options_.checkpointInterval) {
        writer_->checkpoint();
        lastCheckpoint_ = now;
        if (onCheckpoint_) {
            onCheckpoint_(writer_->frames());  // every appended frame is in the flushed header
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
    if (armed_.load() && playing && frames > 0) {
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
