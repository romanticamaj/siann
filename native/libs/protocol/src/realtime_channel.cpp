#include "siann/protocol/realtime_channel.hpp"

#include <algorithm>
#include <bit>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <utility>

namespace siann::protocol {

namespace {

// Little-endian writes and reads, independent of the host's byte order.
void putUnsigned(std::string& out, std::uint64_t value, int bytes) {
    for (int i = 0; i < bytes; ++i) {
        out.push_back(static_cast<char>((value >> (8 * i)) & 0xFF));
    }
}

void putFloat(std::string& out, float value) {
    putUnsigned(out, std::bit_cast<std::uint32_t>(value), 4);
}

class Reader {
public:
    explicit Reader(std::string_view bytes) : bytes_(bytes) {}

    bool take(int count, std::uint64_t& value) {
        const auto size = static_cast<std::size_t>(count);
        if (bytes_.size() - offset_ < size) {
            return false;
        }
        value = 0;
        for (std::size_t i = 0; i < size; ++i) {
            value |= static_cast<std::uint64_t>(static_cast<unsigned char>(bytes_[offset_ + i])) << (8 * i);
        }
        offset_ += size;
        return true;
    }

    bool takeFloat(float& value) {
        std::uint64_t bits = 0;
        if (!take(4, bits)) {
            return false;
        }
        value = std::bit_cast<float>(static_cast<std::uint32_t>(bits));
        return true;
    }

    bool done() const noexcept { return offset_ == bytes_.size(); }

private:
    std::string_view bytes_;
    std::size_t offset_ = 0;
};

std::int64_t steadyMicros() {
    return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

}  // namespace

std::string encodeMeterFrame(const MeterFrame& frame) {
    if (frame.entries.size() > std::numeric_limits<std::uint16_t>::max()) {
        throw std::invalid_argument("a meter frame holds at most 65535 entries");
    }
    std::size_t size = kMeterFrameHeaderBytes;
    for (const auto& entry : frame.entries) {
        if (entry.peak.size() != entry.channels || entry.rms.size() != entry.channels) {
            throw std::invalid_argument("a meter entry needs one peak and one RMS value per channel");
        }
        size += 3 + 8 * static_cast<std::size_t>(entry.channels);
    }
    std::string out;
    out.reserve(size);
    out.append(kMeterFrameMagic);
    putUnsigned(out, kMeterFrameVersion, 1);
    putUnsigned(out, frame.epoch, 8);
    putUnsigned(out, static_cast<std::uint64_t>(frame.engineTimestampMicros), 8);
    putUnsigned(out, static_cast<std::uint64_t>(frame.playheadSamples), 8);
    putUnsigned(out, frame.playing ? 1 : 0, 1);
    putUnsigned(out, frame.entries.size(), 2);
    for (const auto& entry : frame.entries) {
        putUnsigned(out, entry.entityIndex, 2);
        putUnsigned(out, entry.channels, 1);
        for (const float value : entry.peak) {
            putFloat(out, value);
        }
        for (const float value : entry.rms) {
            putFloat(out, value);
        }
    }
    return out;
}

std::optional<MeterFrame> decodeMeterFrame(std::string_view bytes) {
    if (bytes.size() < kMeterFrameHeaderBytes || bytes.substr(0, 4) != kMeterFrameMagic) {
        return std::nullopt;
    }
    Reader r(bytes.substr(4));
    std::uint64_t version = 0;
    std::uint64_t epoch = 0;
    std::uint64_t timestamp = 0;
    std::uint64_t playhead = 0;
    std::uint64_t playing = 0;
    std::uint64_t count = 0;
    if (!r.take(1, version) || version != kMeterFrameVersion || !r.take(8, epoch) || !r.take(8, timestamp) ||
        !r.take(8, playhead) || !r.take(1, playing) || playing > 1 || !r.take(2, count)) {
        return std::nullopt;
    }
    MeterFrame frame;
    frame.epoch = epoch;
    frame.engineTimestampMicros = static_cast<std::int64_t>(timestamp);
    frame.playheadSamples = static_cast<std::int64_t>(playhead);
    frame.playing = playing == 1;
    for (std::uint64_t i = 0; i < count; ++i) {
        std::uint64_t index = 0;
        std::uint64_t channels = 0;
        if (!r.take(2, index) || !r.take(1, channels)) {
            return std::nullopt;
        }
        MeterFrameEntry entry;
        entry.entityIndex = static_cast<std::uint16_t>(index);
        entry.channels = static_cast<std::uint8_t>(channels);
        entry.peak.resize(channels);
        entry.rms.resize(channels);
        for (auto& value : entry.peak) {
            if (!r.takeFloat(value)) {
                return std::nullopt;
            }
        }
        for (auto& value : entry.rms) {
            if (!r.takeFloat(value)) {
                return std::nullopt;
            }
        }
        frame.entries.push_back(std::move(entry));
    }
    if (!r.done()) {
        return std::nullopt;
    }
    return frame;
}

RealtimeChannel::RealtimeChannel(Transport& transport, RealtimeOptions options)
    : transport_(transport), options_(options) {}

void RealtimeChannel::add(ConnectionId connection) {
    {
        std::lock_guard lock(mutex_);
        connections_.try_emplace(connection);
    }
    changed_.notify_all();
}

void RealtimeChannel::remove(ConnectionId connection) {
    {
        std::lock_guard lock(mutex_);
        connections_.erase(connection);
    }
    changed_.notify_all();
}

std::size_t RealtimeChannel::connections() const {
    std::lock_guard lock(mutex_);
    return connections_.size();
}

bool RealtimeChannel::waitForConnections(std::size_t count, std::chrono::milliseconds timeout) const {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] { return connections_.size() >= count; });
}

std::size_t RealtimeChannel::send(const std::string& frame) {
    std::vector<ConnectionId> targets;
    {
        std::lock_guard lock(mutex_);
        for (const auto& [connection, counters] : connections_) {
            (void)counters;
            targets.push_back(connection);
        }
    }
    std::size_t delivered = 0;
    for (const ConnectionId connection : targets) {
        // Latest wins: a congested socket skips this frame, it is never queued.
        const bool congested = transport_.bufferedAmount(connection) > options_.congestionBytes;
        if (!congested) {
            transport_.sendBinary(connection, frame);
            ++delivered;
        }
        std::lock_guard lock(mutex_);
        if (auto it = connections_.find(connection); it != connections_.end()) {
            ++(congested ? it->second.dropped : it->second.sent);
        }
    }
    return delivered;
}

std::uint64_t RealtimeChannel::sent(ConnectionId connection) const {
    std::lock_guard lock(mutex_);
    auto it = connections_.find(connection);
    return it == connections_.end() ? 0 : it->second.sent;
}

std::uint64_t RealtimeChannel::dropped(ConnectionId connection) const {
    std::lock_guard lock(mutex_);
    auto it = connections_.find(connection);
    return it == connections_.end() ? 0 : it->second.dropped;
}

MeterPublisher::MeterPublisher(const realtime::ControlDispatcher& dispatcher, RealtimeChannel& channel,
                               EventStream& events, Options options)
    : dispatcher_(dispatcher), channel_(channel), events_(events), options_(std::move(options)) {
    if (!options_.clockMicros) {
        options_.clockMicros = steadyMicros;
    }
}

void MeterPublisher::graphPublished(std::uint64_t epoch, const std::map<std::string, graph::NodeId>& meterSlots) {
    epoch_ = epoch;
    legend_.clear();
    json::Array entities;
    for (const auto& [entity, slot] : meterSlots) {
        (void)slot;
        if (legend_.size() > std::numeric_limits<std::uint16_t>::max()) {
            break;  // entity indexes are u16
        }
        legend_.push_back(entity);
        entities.push_back(json::Value(entity));
    }
    events_.publish("meters.legend", json::Object{{"epoch", json::Value(std::to_string(epoch))},
                                                  {"entities", json::Value(std::move(entities))}});
}

bool MeterPublisher::tick() {
    if (legend_.empty()) {
        return false;
    }
    MeterFrame frame;
    frame.epoch = epoch_;
    for (std::size_t i = 0; i < legend_.size(); ++i) {
        const auto sample = dispatcher_.meter(legend_[i]);
        if (!sample || sample->epoch != epoch_) {
            continue;
        }
        MeterFrameEntry entry;
        entry.entityIndex = static_cast<std::uint16_t>(i);
        const int channels = std::min(sample->reading.channels, graph::kMaxMeterChannels);
        entry.channels = static_cast<std::uint8_t>(std::max(channels, 0));
        for (int c = 0; c < channels; ++c) {
            entry.peak.push_back(sample->reading.peak[static_cast<std::size_t>(c)]);
            entry.rms.push_back(sample->reading.rms[static_cast<std::size_t>(c)]);
        }
        frame.entries.push_back(std::move(entry));
    }
    if (frame.entries.empty()) {
        return false;
    }
    frame.engineTimestampMicros = options_.clockMicros();
    frame.playheadSamples = dispatcher_.meterPlayhead();
    frame.playing = options_.playing ? options_.playing() : false;
    channel_.send(encodeMeterFrame(frame));
    return true;
}

}  // namespace siann::protocol
