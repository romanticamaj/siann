#pragma once

// The realtime channel (spec "siann-protocol": meters and playhead are binary,
// latest wins, dropped when the socket is congested, and never queue behind
// commands). Its connections are separate WebSockets on kRealtimePath that
// carry only binary frames. The layout is in docs/schemas/protocol-events-v1.md.
//
// The audio thread is not involved: meters reach the ControlDispatcher through
// the meterOutbox as before, and MeterPublisher reads the dispatcher's newest
// values on the protocol side.

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/protocol/event_stream.hpp"
#include "siann/protocol/transport.hpp"
#include "siann/realtime/control_dispatcher.hpp"

namespace siann::protocol {

inline constexpr std::string_view kRealtimePath = "/v1/realtime";
inline constexpr std::string_view kMeterFrameMagic = "SMTR";
inline constexpr std::uint8_t kMeterFrameVersion = 1;
inline constexpr std::size_t kMeterFrameHeaderBytes = 32;

struct MeterFrameEntry {
    std::uint16_t entityIndex = 0;
    std::uint8_t channels = 0;
    std::vector<float> peak;  // `channels` values
    std::vector<float> rms;
};

struct MeterFrame {
    std::uint64_t epoch = 0;
    std::int64_t engineTimestampMicros = 0;
    std::int64_t playheadSamples = 0;
    bool playing = false;
    std::vector<MeterFrameEntry> entries;
};

// Little-endian, as documented. Throws std::invalid_argument when an entry's
// value counts differ from its channel count or there are too many entries.
std::string encodeMeterFrame(const MeterFrame& frame);
// nullopt for a frame that is malformed (magic, version or length).
std::optional<MeterFrame> decodeMeterFrame(std::string_view bytes);

struct RealtimeOptions {
    // A frame is dropped for a connection whose socket buffers more than this.
    std::size_t congestionBytes = 64 * 1024;
};

// The authenticated realtime connections. Thread-safe.
class RealtimeChannel {
public:
    explicit RealtimeChannel(Transport& transport, RealtimeOptions options = {});
    RealtimeChannel(const RealtimeChannel&) = delete;
    RealtimeChannel& operator=(const RealtimeChannel&) = delete;

    void add(ConnectionId connection);
    void remove(ConnectionId connection);
    std::size_t connections() const;
    // Waits (condition wait, no polling) until at least `count` connections
    // are authenticated; false on timeout.
    bool waitForConnections(std::size_t count, std::chrono::milliseconds timeout) const;

    // Sends one binary frame to every connection that is not congested and
    // counts a drop for the others. Returns how many got it.
    std::size_t send(const std::string& frame);

    std::uint64_t sent(ConnectionId connection) const;
    std::uint64_t dropped(ConnectionId connection) const;

private:
    struct Counters {
        std::uint64_t sent = 0;
        std::uint64_t dropped = 0;
    };

    Transport& transport_;
    const RealtimeOptions options_;
    mutable std::mutex mutex_;
    mutable std::condition_variable changed_;
    std::map<ConnectionId, Counters> connections_;
};

// Builds meter frames from the dispatcher's newest samples and publishes the
// legend. Call graphPublished() and tick() from one thread (the protocol
// side's publisher tick).
class MeterPublisher {
public:
    struct Options {
        // Whether the transport is playing; defaults to false.
        std::function<bool()> playing;
        // The transport's position in session frames. Set, a frame goes out on
        // every tick once there is a legend, with no entries before the first
        // meter reading, so a locate shows while stopped. Unset, the playhead
        // is the newest meter block's start and a frame needs a reading.
        std::function<std::int64_t()> playhead;
        // Engine steady-clock time in microseconds; defaults to steady_clock.
        std::function<std::int64_t()> clockMicros;
    };

    MeterPublisher(const realtime::ControlDispatcher& dispatcher, RealtimeChannel& channel, EventStream& events,
                   Options options = {});

    // With the same meter slots as ControlDispatcher::graphPublished: sets the
    // legend for `epoch` and publishes meters.legend on the event stream,
    // which also keeps it as the position's `meters` for the auth reply and
    // session.sync of clients that connect or sync later.
    void graphPublished(std::uint64_t epoch, const std::map<std::string, graph::NodeId>& meterSlots);

    // Builds one frame from the newest samples of the legend's epoch and sends
    // it on the channel. False (nothing sent) before a legend, or before a
    // sample without Options::playhead.
    bool tick();

    const std::vector<std::string>& legend() const noexcept { return legend_; }
    std::uint64_t epoch() const noexcept { return epoch_; }

private:
    const realtime::ControlDispatcher& dispatcher_;
    RealtimeChannel& channel_;
    EventStream& events_;
    Options options_;
    std::uint64_t epoch_ = 0;
    std::vector<std::string> legend_;
};

}  // namespace siann::protocol
