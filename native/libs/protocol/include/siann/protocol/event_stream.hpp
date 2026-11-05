#pragma once

// The event stream (architecture spec, "siann-protocol"; wire format in
// docs/schemas/protocol-events-v1.md). One sequence counter per session and
// process, shared by every event type. Each subscribed connection has a
// bounded outbox; a full outbox drops the event for that connection and
// counts it, so the client sees a seq gap and calls session.sync. Nothing here
// ever waits for a client.
//
// Thread-safe: publish, subscribe and unsubscribe may run on any thread;
// flush() sends in seq order per connection, one flush at a time.

#include <cstddef>
#include <cstdint>
#include <map>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>

#include "siann/command/history.hpp"
#include "siann/hash/json.hpp"
#include "siann/protocol/transport.hpp"

namespace siann::protocol {

inline constexpr std::string_view kEventSchema = "siann.event.v1";

struct EventStreamOptions {
    std::size_t outboxCapacity = 1024;              // events per connection
    std::size_t highWaterBytes = std::size_t{1} << 20;  // flush only while the socket buffers at most this
};

// Where the stream stands: the last published seq (0 before any event), the
// head revision it was published at, and the newest meter legend at that seq.
struct StreamPosition {
    std::uint64_t seq = 0;
    std::string revision;
    std::string documentHash;  // "sha256:<hex>"
    // {epoch, entities} of the newest meters.legend event, null before one. A
    // client that subscribes or syncs later decodes meter frames with it.
    json::Value meters;
};

class EventStream {
public:
    EventStream(Transport& transport, std::string sessionId, StreamPosition head, EventStreamOptions options = {});
    EventStream(const EventStream&) = delete;
    EventStream& operator=(const EventStream&) = delete;

    // Subscribes a connection; every event published afterwards has a seq
    // above the returned one. When `first` is given, its text is sent on the
    // connection before any event (the auth reply carrying the position).
    StreamPosition subscribe(ConnectionId connection,
                             const std::function<std::string(const StreamPosition&)>& first = {});
    void unsubscribe(ConnectionId connection);
    StreamPosition position() const;

    // Publishes `payload` (an object; its keys must not be envelope keys) as
    // an event of `type` at the current head revision. Returns its seq.
    std::uint64_t publish(std::string_view type, json::Object payload);
    // Moves the head to `revision` and publishes session.changed for it.
    std::uint64_t publishRevision(const command::Revision& revision);
    // Makes `legend` ({epoch, entities}) the position's meters and publishes
    // it as meters.legend, atomically: a subscriber gets either the new legend
    // in its position or the event, never neither.
    std::uint64_t publishMeterLegend(json::Object legend);
    // A commit onto a proposal branch: proposal.changed {branch, changedIds}
    // with the branch revision as the event's revision. The head stays.
    std::uint64_t publishBranchRevision(const command::Revision& revision);
    // session.open switched the served session: from now on events carry
    // `sessionId`, the head moves to `head` (main's head of the new session),
    // the meter legend is cleared and session.opened {documentHash} goes out.
    // seq keeps counting.
    std::uint64_t publishSessionOpened(std::string sessionId, const command::Revision& head);

    // Sends queued events while each connection's socket buffers at most
    // highWaterBytes. Returns the number of events sent.
    std::size_t flush();

    std::uint64_t dropped(ConnectionId connection) const;
    std::size_t queued(ConnectionId connection) const;

private:
    struct Outbox {
        std::deque<std::string> events;
        std::uint64_t dropped = 0;
    };

    std::uint64_t publishLocked(std::string_view type, json::Object payload);

    Transport& transport_;
    std::string sessionId_;  // guarded by mutex_
    const EventStreamOptions options_;
    mutable std::mutex mutex_;
    std::mutex flushMutex_;
    StreamPosition head_;
    std::map<ConnectionId, Outbox> outboxes_;
};

// The session.changed payload of a revision (without the envelope).
json::Object sessionChangedPayload(const command::Revision& revision);

// "<entityType>:<id>", for example "track:trk_1" or "root:root".
std::string formatRef(const model::EntityRef& ref);

}  // namespace siann::protocol
