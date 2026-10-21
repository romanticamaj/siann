#include "siann/realtime/disk_stream.hpp"

#include <algorithm>
#include <stdexcept>

namespace siann::realtime {

// ---- FrameRing ---------------------------------------------------------------

FrameRing::FrameRing(int channels, std::size_t capacityFrames) {
    if (channels <= 0 || capacityFrames == 0) {
        throw std::invalid_argument("a frame ring needs channels and capacity");
    }
    std::size_t capacity = 1;
    while (capacity < capacityFrames) {
        capacity <<= 1;
    }
    mask_ = capacity - 1;
    data_.assign(static_cast<std::size_t>(channels), std::vector<float>(capacity, 0.0f));
}

std::size_t FrameRing::writable() const noexcept {
    return capacity() - (write_.load(std::memory_order_relaxed) - read_.load(std::memory_order_acquire));
}

std::size_t FrameRing::write(const host::AudioBufferView& source, std::size_t frames) noexcept {
    const std::size_t w = write_.load(std::memory_order_relaxed);
    const std::size_t n = std::min(frames, writable());
    const int shared = std::min(source.channelCount, channels());
    for (int c = 0; c < channels(); ++c) {
        auto& ring = data_[static_cast<std::size_t>(c)];
        for (std::size_t i = 0; i < n; ++i) {
            ring[(w + i) & mask_] = c < shared ? source.channel(c)[i] : 0.0f;
        }
    }
    write_.store(w + n, std::memory_order_release);
    return n;
}

std::size_t FrameRing::readable() const noexcept {
    return write_.load(std::memory_order_acquire) - read_.load(std::memory_order_relaxed);
}

std::size_t FrameRing::read(const host::AudioBufferView& destination, int offset, std::size_t frames) noexcept {
    const std::size_t r = read_.load(std::memory_order_relaxed);
    const std::size_t n = std::min(frames, readable());
    const int shared = std::min(destination.channelCount, channels());
    for (int c = 0; c < shared; ++c) {
        const auto& ring = data_[static_cast<std::size_t>(c)];
        float* out = destination.channel(c) + offset;
        for (std::size_t i = 0; i < n; ++i) {
            out[i] = ring[(r + i) & mask_];
        }
    }
    read_.store(r + n, std::memory_order_release);
    return n;
}

std::size_t FrameRing::skip(std::size_t frames) noexcept {
    const std::size_t r = read_.load(std::memory_order_relaxed);
    const std::size_t n = std::min(frames, readable());
    read_.store(r + n, std::memory_order_release);
    return n;
}

void FrameRing::reset() noexcept {
    write_.store(0, std::memory_order_relaxed);
    read_.store(0, std::memory_order_relaxed);
}

// ---- DiskStream --------------------------------------------------------------

DiskStream::DiskStream(int channels, std::vector<StreamClip> clips, std::size_t ringFrames)
    : channels_(channels), clips_(std::move(clips)) {
    // Same order as ClipPlayerNode, so overlapping clips sum identically.
    std::stable_sort(clips_.begin(), clips_.end(),
                     [](const StreamClip& a, const StreamClip& b) { return a.timelineStart < b.timelineStart; });
    slots_[0] = std::make_unique<Slot>(channels, ringFrames);
    slots_[1] = std::make_unique<Slot>(channels, ringFrames);
}

// ---- StreamingPlayerNode (audio thread) -------------------------------------

bool StreamingPlayerNode::tryClaim(std::uint64_t generation) noexcept {
    const int other = 1 - stream_.liveSlot_;
    std::uint64_t expected = generation;
    if (!stream_.slots_[other]->state.compare_exchange_strong(expected, DiskStream::kLive, std::memory_order_acq_rel)) {
        return false;
    }
    const int old = stream_.liveSlot_;
    stream_.liveSlot_ = other;
    stream_.slots_[old]->state.store(0, std::memory_order_release);
    if (stream_.butler_ != nullptr) {
        stream_.butler_->releaseSlot(Butler::Release{&stream_, other});
    }
    return true;
}

void StreamingPlayerNode::onLocate(std::uint64_t generation, std::int64_t) noexcept {
    if (tryClaim(generation)) {
        stream_.waitingGeneration_ = 0;
        stream_.framesToSkip_ = 0;
    } else {
        stream_.waitingGeneration_ = generation;
        stream_.framesToSkip_ = 0;
    }
}

void StreamingPlayerNode::process(const graph::ProcessContext& context, std::span<const graph::AudioBufferView>,
                                  const graph::AudioBufferView& output) noexcept {
    const auto frames = static_cast<std::size_t>(context.frames);
    if (stream_.waitingGeneration_ != 0) {
        if (tryClaim(stream_.waitingGeneration_)) {
            stream_.waitingGeneration_ = 0;
        } else {
            output.clear();
            stream_.framesToSkip_ += frames;
            stream_.underruns_.fetch_add(1, std::memory_order_relaxed);
            return;
        }
    }
    FrameRing& ring = stream_.slots_[stream_.liveSlot_]->ring;
    if (stream_.framesToSkip_ > 0) {
        stream_.framesToSkip_ -= ring.skip(stream_.framesToSkip_);
        if (stream_.framesToSkip_ > 0) {
            stream_.framesToSkip_ += frames;  // still catching up: this block is lost too
            output.clear();
            stream_.underruns_.fetch_add(1, std::memory_order_relaxed);
            return;
        }
    }
    const std::size_t got = ring.read(output, 0, frames);
    if (got < frames) {
        for (int c = 0; c < output.channelCount; ++c) {
            std::fill(output.channel(c) + got, output.channel(c) + frames, 0.0f);
        }
        stream_.underruns_.fetch_add(1, std::memory_order_relaxed);
    }
}

// ---- Butler ------------------------------------------------------------------

Butler::Butler(Options options) : options_(options) {
    if (options_.chunkFrames == 0) {
        throw std::invalid_argument("chunkFrames must be positive");
    }
}

Butler::~Butler() {
    stop();
}

void Butler::addStream(DiskStream& stream) {
    if (running_.load()) {
        throw std::logic_error("streams must be added before the butler starts");
    }
    stream.butler_ = this;
    int maxChannels = stream.channels();
    for (const auto& clip : stream.clips_) {
        if (clip.reader) {
            maxChannels = std::max(maxChannels, clip.reader->info().channels);
        }
    }
    if (static_cast<int>(scratch_.size()) < maxChannels) {
        scratch_.assign(static_cast<std::size_t>(maxChannels), std::vector<float>(options_.chunkFrames, 0.0f));
        readBuffer_.assign(static_cast<std::size_t>(maxChannels), std::vector<float>(options_.chunkFrames, 0.0f));
        scratchPointers_.clear();
        readPointers_.clear();
        for (auto& c : scratch_) {
            scratchPointers_.push_back(c.data());
        }
        for (auto& c : readBuffer_) {
            readPointers_.push_back(c.data());
        }
    }
    streams_.push_back(&stream);

    // The first slot starts live at timeline position 0.
    auto& slot = *stream.slots_[0];
    slot.ring.reset();
    slot.start = 0;
    stream.liveSlot_ = 0;
    stream.butlerLive_ = 0;
    stream.liveWritePosition_ = 0;
    topUp(stream, 0, stream.liveWritePosition_, slot.ring.capacity());
    slot.state.store(DiskStream::kLive, std::memory_order_release);
}

void Butler::start() {
    if (running_.exchange(true)) {
        return;
    }
    thread_ = std::thread([this] {
        while (running_.load(std::memory_order_acquire)) {
            runOnce();
            std::this_thread::sleep_for(options_.idle);
        }
    });
}

void Butler::stop() {
    running_.store(false, std::memory_order_release);
    if (thread_.joinable()) {
        thread_.join();
    }
}

void Butler::seek(std::uint64_t generation, std::int64_t target) {
    std::lock_guard lock(seekMutex_);
    if (!seekRequest_ || seekRequest_->first < generation) {
        seekRequest_ = std::make_pair(generation, target);
    }
}

bool Butler::releaseSlot(const Release& release) noexcept {
    return releases_.push(release);
}

void Butler::render(DiskStream& stream, std::int64_t position, std::size_t frames) {
    const int channels = stream.channels();
    for (int c = 0; c < channels; ++c) {
        std::fill(scratch_[static_cast<std::size_t>(c)].begin(),
                  scratch_[static_cast<std::size_t>(c)].begin() + static_cast<std::ptrdiff_t>(frames), 0.0f);
    }
    const std::int64_t end = position + static_cast<std::int64_t>(frames);
    for (const auto& clip : stream.clips_) {
        const std::int64_t from = std::max(position, clip.timelineStart);
        const std::int64_t to = std::min(end, clip.timelineStart + clip.length);
        if (from >= to || !clip.reader) {
            continue;
        }
        const int mediaChannels = clip.reader->info().channels;
        const host::AudioBufferView view{readPointers_.data(), mediaChannels, static_cast<int>(to - from)};
        clip.reader->read(clip.sourceStart + (from - clip.timelineStart), view);
        const auto offset = static_cast<std::size_t>(from - position);
        for (std::int64_t i = 0; i < to - from; ++i) {
            const auto f = static_cast<std::size_t>(i);
            const auto o = offset + f;
            if (mediaChannels == channels) {
                for (int c = 0; c < channels; ++c) {
                    scratch_[static_cast<std::size_t>(c)][o] += readBuffer_[static_cast<std::size_t>(c)][f] * clip.gain;
                }
            } else if (mediaChannels == 1) {
                for (int c = 0; c < channels; ++c) {
                    scratch_[static_cast<std::size_t>(c)][o] += readBuffer_[0][f] * clip.gain;
                }
            } else if (channels == 1 && mediaChannels == 2) {
                scratch_[0][o] += 0.5f * (readBuffer_[0][f] + readBuffer_[1][f]) * clip.gain;
            } else {
                for (int c = 0; c < std::min(channels, mediaChannels); ++c) {
                    scratch_[static_cast<std::size_t>(c)][o] += readBuffer_[static_cast<std::size_t>(c)][f] * clip.gain;
                }
            }
        }
    }
}

void Butler::topUp(DiskStream& stream, int slot, std::int64_t& writePosition, std::size_t limit) {
    FrameRing& ring = stream.slots_[slot]->ring;
    std::size_t written = 0;
    while (written < limit) {
        const std::size_t n = std::min({options_.chunkFrames, ring.writable(), limit - written});
        if (n == 0) {
            break;
        }
        render(stream, writePosition, n);
        const host::AudioBufferView view{scratchPointers_.data(), stream.channels(), static_cast<int>(n)};
        ring.write(view, n);
        writePosition += static_cast<std::int64_t>(n);
        written += n;
    }
}

void Butler::runOnce() {
    // 1. The audio thread claimed an offered slot: it is the live slot now.
    Release release;
    while (releases_.pop(release)) {
        DiskStream& s = *release.stream;
        s.butlerLive_ = release.newLive;
        if (s.pending_.active && s.pending_.slot == release.newLive) {
            s.liveWritePosition_ = s.pending_.writePosition;
            s.pending_ = DiskStream::Pending{};
        }
    }

    // 2. A new locate. If any stream's offer was just claimed and its release
    //    has not arrived yet, wait for the next pass.
    std::optional<std::pair<std::uint64_t, std::int64_t>> request;
    {
        std::lock_guard lock(seekMutex_);
        request = seekRequest_;
    }
    if (request) {
        bool deferred = false;
        for (DiskStream* s : streams_) {
            if (s->pending_.active && s->pending_.offered) {
                std::uint64_t expected = s->pending_.generation;
                if (s->slots_[s->pending_.slot]->state.compare_exchange_strong(expected, 0,
                                                                                std::memory_order_acq_rel)) {
                    s->pending_.offered = false;  // withdrawn; the slot is ours again
                } else if (expected == DiskStream::kLive) {
                    deferred = true;  // claimed by the audio thread; its release is on the way
                }
            }
        }
        if (!deferred) {
            {
                std::lock_guard lock(seekMutex_);
                if (seekRequest_ == request) {
                    seekRequest_.reset();
                }
            }
            readyGeneration_.store(0, std::memory_order_release);
            for (DiskStream* s : streams_) {
                const int slot = 1 - s->butlerLive_;
                auto& target = *s->slots_[slot];
                target.ring.reset();
                target.start = request->second;
                s->pending_ = DiskStream::Pending{true, request->first, slot, request->second, false};
            }
            if (streams_.empty()) {
                readyGeneration_.store(request->first, std::memory_order_release);
            }
        }
    }

    // 3. Fill pending slots and offer them once prefilled.
    bool allOffered = !streams_.empty();
    std::uint64_t generation = 0;
    for (DiskStream* s : streams_) {
        if (!s->pending_.active) {
            allOffered = false;
            continue;
        }
        auto& slot = *s->slots_[s->pending_.slot];
        topUp(*s, s->pending_.slot, s->pending_.writePosition, slot.ring.capacity());
        if (!s->pending_.offered &&
            slot.ring.readable() >= std::min(options_.prefillFrames, slot.ring.capacity())) {
            slot.state.store(s->pending_.generation, std::memory_order_release);
            s->pending_.offered = true;
        }
        allOffered = allOffered && s->pending_.offered;
        generation = s->pending_.generation;
    }
    if (allOffered && generation != 0) {
        readyGeneration_.store(generation, std::memory_order_release);
    }

    // 4. Keep live slots topped up.
    for (DiskStream* s : streams_) {
        topUp(*s, s->butlerLive_, s->liveWritePosition_, s->slots_[s->butlerLive_]->ring.capacity());
    }
}

}  // namespace siann::realtime
