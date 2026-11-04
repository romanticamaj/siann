#include "siann/protocol/event_stream.hpp"

#include <utility>

namespace siann::protocol {

EventStream::EventStream(Transport& transport, std::string sessionId, StreamPosition head, EventStreamOptions options)
    : transport_(transport), sessionId_(std::move(sessionId)), options_(options), head_(std::move(head)) {}

StreamPosition EventStream::subscribe(ConnectionId) {
    return position();
}

void EventStream::unsubscribe(ConnectionId) {}

StreamPosition EventStream::position() const {
    std::lock_guard lock(mutex_);
    return head_;
}

std::uint64_t EventStream::publish(std::string_view, json::Object) {
    return 0;
}

std::uint64_t EventStream::publishRevision(const command::Revision&) {
    return 0;
}

std::size_t EventStream::flush() {
    return 0;
}

std::uint64_t EventStream::dropped(ConnectionId) const {
    return 0;
}

std::size_t EventStream::queued(ConnectionId) const {
    return 0;
}

json::Object sessionChangedPayload(const command::Revision&) {
    return {};
}

std::string formatRef(const model::EntityRef&) {
    return {};
}

}  // namespace siann::protocol
