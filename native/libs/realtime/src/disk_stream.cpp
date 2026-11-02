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
    // Remembered even before the butler took the stream; a graph swapped in
    // after a locate hears it again from the driver, which changes nothing for
    // a stream that already follows it.
    stream_.heard_ = std::max(stream_.heard_, generation);
    if (stream_.ready()) {
        follow();
    }
}

bool StreamingPlayerNode::follow() noexcept {
    if (stream_.heard_ <= stream_.generation_) {
        return true;
    }
    if (!tryClaim(stream_.heard_)) {
        return false;  // the data for that locate is not ready yet
    }
    stream_.generation_ = stream_.heard_;
    return true;
}

void StreamingPlayerNode::process(const graph::ProcessContext& context, std::span<const graph::AudioBufferView>,
                                  const graph::AudioBufferView& output) noexcept {
    const auto frames = static_cast<std::size_t>(context.frames);
    // A graph published on the prefill timeout may reach a stream the butler
    // has not taken yet; its audio-side fields belong to the butler until then.
    if (!stream_.ready()) {
        output.clear();
        stream_.underruns_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    if (!follow()) {
        output.clear();
        stream_.underruns_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    // One rule aligns the stream after a late locate, after a swap to a graph
    // whose stream was prefilled earlier, and after an underrun: the live
    // slot's position is its start plus the frames consumed from it.
    DiskStream::Slot& slot = *stream_.slots_[stream_.liveSlot_];
    FrameRing& ring = slot.ring;
    const std::int64_t position = slot.start + static_cast<std::int64_t>(ring.consumed());
    std::size_t lead = 0;  // frames of this block before the stream's next frame
    if (position < context.blockStart) {
        const auto behind = static_cast<std::size_t>(context.blockStart - position);
        if (ring.skip(behind) < behind) {
            output.clear();  // still catching up; the rest is skipped next block
            stream_.underruns_.fetch_add(1, std::memory_order_relaxed);
            return;
        }
    } else if (position > context.blockStart) {
        lead = std::min(frames, static_cast<std::size_t>(position - context.blockStart));
    }
    const std::size_t got = lead < frames ? ring.read(output, static_cast<int>(lead), frames - lead) : 0;
    for (int c = 0; c < output.channelCount; ++c) {
        std::fill(output.channel(c), output.channel(c) + lead, 0.0f);
        std::fill(output.channel(c) + lead + got, output.channel(c) + frames, 0.0f);
    }
    if (lead > 0 || lead + got < frames) {
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
        throw std::logic_error("use addStream(stream, position, generation) while the butler runs");
    }
    takeStream(stream, 0, 0);
}

void Butler::addStream(DiskStream& stream, std::int64_t startPosition, std::uint64_t generation) {
    stream.ready_.store(false, std::memory_order_relaxed);
    stream.released_.store(false, std::memory_order_relaxed);
    pushControl(Control{&stream, true, startPosition, generation});
}

void Butler::removeStream(DiskStream& stream) {
    pushControl(Control{&stream, false, 0, 0});
}

void Butler::pushControl(const Control& request) {
    std::lock_guard lock(controlMutex_);
    if (control_.size() >= kMaxControl) {
        throw std::length_error("the butler's control queue is full");
    }
    control_.push_back(request);
}

// Butler thread (or the caller before start()).
void Butler::takeStream(DiskStream& stream, std::int64_t startPosition, std::uint64_t generation) {
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

    // The first slot starts live at the start position. No graph plays the
    // stream before ready() is published, so the audio-side fields are free.
    auto& slot = *stream.slots_[0];
    slot.ring.reset();
    slot.start = startPosition;
    stream.liveSlot_ = 0;
    stream.generation_ = generation;
    stream.butlerLive_ = 0;
    stream.liveWritePosition_ = startPosition;
    stream.pending_ = DiskStream::Pending{};
    topUp(stream, 0, stream.liveWritePosition_, slot.ring.capacity());
    slot.state.store(DiskStream::kLive, std::memory_order_release);

    // A locate prepared after the start position was read: the new stream
    // joins it, whether or not the other streams have claimed it already, so
    // a graph that plays it follows that locate too. The player switches only
    // once a graph tells it about the locate, so an unapplied one stays unheard.
    if (lastSeek_ && lastSeek_->first > generation) {
        const std::uint64_t seekGeneration = lastSeek_->first;
        auto& target = *stream.slots_[1];
        target.ring.reset();
        target.start = lastSeek_->second;
        stream.pending_ = DiskStream::Pending{true, seekGeneration, 1, lastSeek_->second, false};
        topUp(stream, 1, stream.pending_.writePosition, target.ring.capacity());
        target.state.store(seekGeneration, std::memory_order_release);
        stream.pending_.offered = true;
    }
    stream.ready_.store(true, std::memory_order_release);
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

std::uint64_t Butler::underruns() const noexcept {
    std::uint64_t total = 0;
    for (const DiskStream* stream : streams_) {
        total += stream->underruns();
    }
    return total;
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
    // 0. Streams added and removed by the command thread. A removed stream's
    //    graph has retired, so every slot release it pushed is visible below.
    std::vector<Control> requests;
    {
        std::lock_guard lock(controlMutex_);
        requests.swap(control_);
    }
    std::vector<DiskStream*> removed;
    for (const Control& request : requests) {
        if (request.add) {
            takeStream(*request.stream, request.start, request.generation);
        } else {
            streams_.erase(std::remove(streams_.begin(), streams_.end(), request.stream), streams_.end());
            request.stream->butler_ = nullptr;
            removed.push_back(request.stream);
        }
    }

    // 1. The audio thread claimed an offered slot: it is the live slot now.
    Release release;
    while (releases_.pop(release)) {
        if (std::find(removed.begin(), removed.end(), release.stream) != removed.end()) {
            continue;
        }
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
            lastSeek_ = request;
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

    // 3. Fill pending slots and offer them once prefilled. Streams without a
    //    pending slot (already claimed, or added after the locate) do not hold
    //    back readiness.
    bool anyPending = false;
    bool allOffered = true;
    std::uint64_t generation = 0;
    for (DiskStream* s : streams_) {
        if (!s->pending_.active) {
            continue;
        }
        anyPending = true;
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
    if (anyPending && allOffered && generation != 0) {
        readyGeneration_.store(generation, std::memory_order_release);
    }

    // 4. Keep live slots topped up.
    for (DiskStream* s : streams_) {
        topUp(*s, s->butlerLive_, s->liveWritePosition_, s->slots_[s->butlerLive_]->ring.capacity());
    }

    // 5. Nothing in this pass touches a removed stream any more.
    for (DiskStream* s : removed) {
        s->released_.store(true, std::memory_order_release);
    }
}

}  // namespace siann::realtime
