#include "siann/protocol/event_stream.hpp"

#include <algorithm>
#include <utility>
#include <vector>

#include "siann/hash/jcs.hpp"
#include "siann/hash/sha256.hpp"

namespace siann::protocol {

namespace {

using json::Array;
using json::Object;
using json::Value;

std::string_view changeName(model::DiffEntry::Change change) noexcept {
    switch (change) {
        case model::DiffEntry::Change::added: return "added";
        case model::DiffEntry::Change::removed: return "removed";
        case model::DiffEntry::Change::modified: return "modified";
    }
    return "modified";
}

}  // namespace

std::string formatRef(const model::EntityRef& ref) {
    return std::string(model::entityTypeName(ref.type)) + ":" + ref.id;
}

json::Object sessionChangedPayload(const command::Revision& revision) {
    Array parents;
    for (const auto& parent : revision.envelope.parents) {
        parents.push_back(Value(parent));
    }
    Array changed;
    for (const auto& entry : revision.diff) {
        changed.push_back(
            Value(Object{{"ref", Value(formatRef(entry.entity))}, {"change", Value(std::string(changeName(entry.change)))}}));
    }
    return Object{{"parents", Value(std::move(parents))},
                  {"cause", Value(std::string(command::causeName(revision.envelope.cause)))},
                  {"actor", Value(revision.envelope.actor)},
                  {"time", Value(revision.envelope.time)},
                  {"documentHash", Value(hash::formatHash(revision.envelope.documentHash))},
                  {"changedIds", Value(std::move(changed))}};
}

EventStream::EventStream(Transport& transport, std::string sessionId, StreamPosition head, EventStreamOptions options)
    : transport_(transport), sessionId_(std::move(sessionId)), options_(options), head_(std::move(head)) {}

StreamPosition EventStream::subscribe(ConnectionId connection,
                                      const std::function<std::string(const StreamPosition&)>& first) {
    // flush() sends under flushMutex_, so no event of this connection can go
    // out before `first`.
    std::lock_guard flushLock(flushMutex_);
    StreamPosition head;
    {
        std::lock_guard lock(mutex_);
        outboxes_.try_emplace(connection);
        head = head_;
    }
    if (first) {
        transport_.send(connection, first(head));
    }
    return head;
}

void EventStream::unsubscribe(ConnectionId connection) {
    std::lock_guard lock(mutex_);
    outboxes_.erase(connection);
}

StreamPosition EventStream::position() const {
    std::lock_guard lock(mutex_);
    return head_;
}

std::uint64_t EventStream::publish(std::string_view type, json::Object payload) {
    std::lock_guard lock(mutex_);
    return publishLocked(type, std::move(payload));
}

std::uint64_t EventStream::publishLocked(std::string_view type, json::Object payload) {
    const std::uint64_t seq = ++head_.seq;
    Object event{{"schema", Value(std::string(kEventSchema))},
                 {"seq", Value(std::to_string(seq))},
                 {"sessionId", Value(sessionId_)},
                 {"revision", Value(head_.revision)},
                 {"type", Value(std::string(type))}};
    for (auto& member : payload) {
        const bool reserved = std::any_of(event.begin(), event.begin() + 5,
                                          [&](const json::Member& m) { return m.first == member.first; });
        if (!reserved) {
            event.push_back(std::move(member));
        }
    }
    const std::string text = jcs::canonicalize(Value(std::move(event)));
    const std::size_t capacity = std::max<std::size_t>(options_.outboxCapacity, 1);
    for (auto& [connection, outbox] : outboxes_) {
        (void)connection;
        if (outbox.events.size() >= capacity) {
            ++outbox.dropped;
        } else {
            outbox.events.push_back(text);
        }
    }
    return seq;
}

std::uint64_t EventStream::publishRevision(const command::Revision& revision) {
    json::Object payload = sessionChangedPayload(revision);
    std::lock_guard lock(mutex_);
    head_.revision = revision.envelope.id;
    head_.documentHash = hash::formatHash(revision.envelope.documentHash);
    return publishLocked("session.changed", std::move(payload));
}

std::size_t EventStream::flush() {
    std::lock_guard flushLock(flushMutex_);
    std::vector<ConnectionId> connections;
    {
        std::lock_guard lock(mutex_);
        for (const auto& [connection, outbox] : outboxes_) {
            if (!outbox.events.empty()) {
                connections.push_back(connection);
            }
        }
    }
    std::size_t sent = 0;
    for (const ConnectionId connection : connections) {
        for (;;) {
            if (transport_.bufferedAmount(connection) > options_.highWaterBytes) {
                break;
            }
            std::string text;
            {
                std::lock_guard lock(mutex_);
                auto it = outboxes_.find(connection);
                if (it == outboxes_.end() || it->second.events.empty()) {
                    break;
                }
                text = std::move(it->second.events.front());
                it->second.events.pop_front();
            }
            transport_.send(connection, text);
            ++sent;
        }
    }
    return sent;
}

std::uint64_t EventStream::dropped(ConnectionId connection) const {
    std::lock_guard lock(mutex_);
    auto it = outboxes_.find(connection);
    return it == outboxes_.end() ? 0 : it->second.dropped;
}

std::size_t EventStream::queued(ConnectionId connection) const {
    std::lock_guard lock(mutex_);
    auto it = outboxes_.find(connection);
    return it == outboxes_.end() ? 0 : it->second.events.size();
}

}  // namespace siann::protocol
