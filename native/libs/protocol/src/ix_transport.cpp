// The only translation unit of siann-protocol that includes IXWebSocket.

#include "siann/protocol/ix_transport.hpp"

#include <algorithm>
#include <cctype>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>

#include <ixwebsocket/IXConnectionState.h>
#include <ixwebsocket/IXGetFreePort.h>
#include <ixwebsocket/IXHttp.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXSocket.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketServer.h>

namespace siann::protocol {

namespace {

constexpr int kHttpTimeoutSecs = 5;
constexpr int kListenAttempts = 20;

std::string lower(std::string text) {
    std::transform(text.begin(), text.end(), text.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}

HttpRequest toRequest(const ix::HttpRequest& request) {
    HttpRequest out;
    out.method = request.method;
    out.path = request.uri.substr(0, request.uri.find('?'));
    for (const auto& [name, value] : request.headers) {
        out.headers[lower(name)] = value;
    }
    out.body = request.body;
    return out;
}

std::string reasonPhrase(int status) {
    switch (status) {
        case 200: return "OK";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        default: return "Error";
    }
}

ix::HttpResponsePtr toIx(const HttpResponse& response) {
    ix::WebSocketHttpHeaders headers;
    headers["Content-Type"] = response.contentType;
    headers["Connection"] = "close";
    return std::make_shared<ix::HttpResponse>(response.status, reasonPhrase(response.status), ix::HttpErrorCode::Ok,
                                              headers, response.body);
}

}  // namespace

struct IxTransport::Impl {
    struct Connection {
        std::weak_ptr<ix::WebSocket> socket;
        bool open = false;
    };

    // A WebSocket server that sees the HTTP request first: it answers plain
    // HTTP and refuses an upgrade before any socket is created.
    class Server final : public ix::WebSocketServer {
    public:
        Server(Impl& owner, int port, const std::string& host) : ix::WebSocketServer(port, host), owner_(owner) {}
        ~Server() override = default;

    private:
        void handleConnection(std::unique_ptr<ix::Socket> socket,
                              std::shared_ptr<ix::ConnectionState> state) override {
            auto [ok, error, request] = ix::Http::parseRequest(socket, kHttpTimeoutSecs);
            (void)error;
            if (ok && request) {
                const HttpRequest converted = toRequest(*request);
                auto upgrade = converted.headers.find("upgrade");
                if (upgrade != converted.headers.end() && lower(upgrade->second) == "websocket") {
                    if (auto rejection = owner_.handlers.onUpgrade(converted)) {
                        ix::Http::sendResponse(toIx(*rejection), socket);
                    } else {
                        handleUpgrade(std::move(socket), state, request);
                        owner_.finish(state.get());
                    }
                } else {
                    ix::Http::sendResponse(toIx(owner_.handlers.onHttp(converted)), socket);
                }
            }
            state->setTerminated();
        }

        Impl& owner_;
    };

    TransportHandlers handlers;
    std::unique_ptr<Server> server;

    std::mutex mutex;
    std::map<ConnectionId, Connection> connections;
    std::map<const ix::ConnectionState*, ConnectionId> byState;
    ConnectionId nextId = 1;

    // An IX connection thread, before the handshake.
    void attach(std::weak_ptr<ix::WebSocket> weak, const std::shared_ptr<ix::ConnectionState>& state) {
        auto socket = weak.lock();
        if (!socket) {
            return;
        }
        ConnectionId id = 0;
        {
            std::lock_guard lock(mutex);
            id = nextId++;
            connections[id] = Connection{weak, false};
            byState[state.get()] = id;
        }
        socket->setOnMessageCallback([this, id](const ix::WebSocketMessagePtr& message) {
            switch (message->type) {
                case ix::WebSocketMessageType::Open: {
                    {
                        std::lock_guard lock(mutex);
                        auto it = connections.find(id);
                        if (it == connections.end()) {
                            return;
                        }
                        it->second.open = true;
                    }
                    handlers.onOpen(id);
                    break;
                }
                case ix::WebSocketMessageType::Message:
                    handlers.onMessage(id, message->str);
                    break;
                case ix::WebSocketMessageType::Close:
                    finish(id);
                    break;
                default:
                    break;
            }
        });
    }

    void finish(ConnectionId id) {
        bool wasOpen = false;
        {
            std::lock_guard lock(mutex);
            auto it = connections.find(id);
            if (it == connections.end()) {
                return;
            }
            wasOpen = it->second.open;
            connections.erase(it);
        }
        if (wasOpen) {
            handlers.onClose(id);
        }
    }

    // After the connection's run loop ended, whether or not a Close arrived.
    void finish(const ix::ConnectionState* state) {
        ConnectionId id = 0;
        {
            std::lock_guard lock(mutex);
            auto it = byState.find(state);
            if (it == byState.end()) {
                return;
            }
            id = it->second;
            byState.erase(it);
        }
        finish(id);
    }

    std::shared_ptr<ix::WebSocket> socketOf(ConnectionId id) {
        std::lock_guard lock(mutex);
        auto it = connections.find(id);
        return it == connections.end() ? nullptr : it->second.socket.lock();
    }
};

IxTransport::IxTransport() : impl_(std::make_unique<Impl>()) {
    ix::initNetSystem();
}

IxTransport::~IxTransport() {
    stop();
}

void IxTransport::setHandlers(TransportHandlers handlers) {
    impl_->handlers = std::move(handlers);
}

Listening IxTransport::listen(const std::string& host, std::uint16_t port) {
    if (impl_->server) {
        throw std::runtime_error("the transport is already listening");
    }
    std::string lastError;
    // IXWebSocket keeps the requested port; for port 0 pick a free one first
    // and retry if another process takes it in between.
    for (int attempt = 0; attempt < (port == 0 ? kListenAttempts : 1); ++attempt) {
        const int chosen = port == 0 ? ix::getFreePort() : static_cast<int>(port);
        auto server = std::make_unique<Impl::Server>(*impl_, chosen, host);
        server->disablePerMessageDeflate();
        Impl* impl = impl_.get();
        server->setOnConnectionCallback(
            [impl](std::weak_ptr<ix::WebSocket> socket, std::shared_ptr<ix::ConnectionState> state) {
                impl->attach(std::move(socket), state);
            });
        auto [ok, error] = server->listen();
        if (ok) {
            server->start();
            impl_->server = std::move(server);
            return Listening{static_cast<std::uint16_t>(chosen)};
        }
        lastError = error;
    }
    throw std::runtime_error("cannot listen on " + host + ": " + lastError);
}

void IxTransport::stop() {
    if (impl_->server) {
        impl_->server->stop();
        impl_->server.reset();
    }
}

void IxTransport::send(ConnectionId connection, const std::string& text) {
    if (auto socket = impl_->socketOf(connection)) {
        socket->sendText(text);
    }
}

void IxTransport::close(ConnectionId connection, int code, const std::string& reason) {
    if (auto socket = impl_->socketOf(connection)) {
        socket->close(static_cast<std::uint16_t>(code), reason);
    }
}

}  // namespace siann::protocol
