#include "siann/protocol/protocol_server.hpp"

#include <optional>
#include <utility>

namespace siann::protocol {

// Stub: every frame is answered with not_implemented.
struct ProtocolServer::Impl {
    Transport& transport;
    session::Session& session;
    ServerOptions options;
    std::string token;
    std::string sessionId;
    std::uint16_t port = 0;
};

ProtocolServer::ProtocolServer(Transport& transport, session::Session& session, ServerOptions options)
    : impl_(std::make_unique<Impl>(Impl{transport, session, std::move(options), {}, {}, 0})) {
    Impl* impl = impl_.get();
    TransportHandlers handlers;
    handlers.onUpgrade = [](const HttpRequest&) -> std::optional<HttpResponse> { return std::nullopt; };
    handlers.onOpen = [](ConnectionId) {};
    handlers.onMessage = [impl](ConnectionId connection, const std::string&) {
        impl->transport.send(connection,
                             R"({"ok":false,"error":{"code":"not_implemented"},"requestId":null})");
    };
    handlers.onClose = [](ConnectionId) {};
    handlers.onHttp = [](const HttpRequest&) { return HttpResponse{501, "application/json", "{}"}; };
    impl_->transport.setHandlers(std::move(handlers));
}

ProtocolServer::~ProtocolServer() = default;

void ProtocolServer::start() {}
void ProtocolServer::stop() {}
std::size_t ProtocolServer::pump() {
    return 0;
}
const std::string& ProtocolServer::token() const noexcept {
    return impl_->token;
}
const std::string& ProtocolServer::sessionId() const noexcept {
    return impl_->sessionId;
}
std::uint16_t ProtocolServer::port() const noexcept {
    return impl_->port;
}

}  // namespace siann::protocol
