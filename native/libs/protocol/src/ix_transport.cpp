#include "siann/protocol/ix_transport.hpp"

#include <stdexcept>

#include <ixwebsocket/IXNetSystem.h>

namespace siann::protocol {

// Stub: not implemented yet.
struct IxTransport::Impl {};

IxTransport::IxTransport() : impl_(std::make_unique<Impl>()) {
    ix::initNetSystem();
}

IxTransport::~IxTransport() = default;

void IxTransport::setHandlers(TransportHandlers) {}

Listening IxTransport::listen(const std::string&, std::uint16_t) {
    throw std::runtime_error("not_implemented");
}

void IxTransport::stop() {}
void IxTransport::send(ConnectionId, const std::string&) {}
void IxTransport::close(ConnectionId, int, const std::string&) {}

}  // namespace siann::protocol
