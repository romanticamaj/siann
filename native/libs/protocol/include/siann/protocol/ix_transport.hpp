#pragma once

// Transport over IXWebSocket (pinned in cmake/SiannThirdParty.cmake). This
// header does not include IXWebSocket; src/ix_transport.cpp is the only
// translation unit of siann-protocol that does.

#include <memory>

#include "siann/protocol/transport.hpp"

namespace siann::protocol {

class IxTransport final : public Transport {
public:
    IxTransport();
    ~IxTransport() override;
    IxTransport(const IxTransport&) = delete;
    IxTransport& operator=(const IxTransport&) = delete;

    void setHandlers(TransportHandlers handlers) override;
    Listening listen(const std::string& host, std::uint16_t port) override;
    void stop() override;
    void send(ConnectionId connection, const std::string& text) override;
    void close(ConnectionId connection, int code, const std::string& reason) override;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::protocol
