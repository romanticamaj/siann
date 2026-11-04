#include "siann/protocol/realtime_channel.hpp"

#include <utility>

namespace siann::protocol {

std::string encodeMeterFrame(const MeterFrame&) {
    return {};
}

std::optional<MeterFrame> decodeMeterFrame(std::string_view) {
    return std::nullopt;
}

RealtimeChannel::RealtimeChannel(Transport& transport, RealtimeOptions options)
    : transport_(transport), options_(options) {}

void RealtimeChannel::add(ConnectionId) {}

void RealtimeChannel::remove(ConnectionId) {}

std::size_t RealtimeChannel::connections() const {
    return 0;
}

bool RealtimeChannel::waitForConnections(std::size_t, std::chrono::milliseconds) const {
    return false;
}

std::size_t RealtimeChannel::send(const std::string&) {
    return 0;
}

std::uint64_t RealtimeChannel::sent(ConnectionId) const {
    return 0;
}

std::uint64_t RealtimeChannel::dropped(ConnectionId) const {
    return 0;
}

MeterPublisher::MeterPublisher(const realtime::ControlDispatcher& dispatcher, RealtimeChannel& channel,
                               EventStream& events, Options options)
    : dispatcher_(dispatcher), channel_(channel), events_(events), options_(std::move(options)) {}

void MeterPublisher::graphPublished(std::uint64_t, const std::map<std::string, graph::NodeId>&) {}

bool MeterPublisher::tick() {
    return false;
}

}  // namespace siann::protocol
