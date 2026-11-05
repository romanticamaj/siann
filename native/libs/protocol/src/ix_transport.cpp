// The only translation unit of siann-protocol that includes IXWebSocket.

#include "siann/protocol/ix_transport.hpp"

#include <algorithm>
#include <cctype>
#include <cstdint>
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
        case 500: return "Internal Server Error";
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

// IX runs every connection on a bare std::thread with no handler of its own:
// an exception escaping a handler there would reach std::terminate.
HttpResponse internalError() {
    return HttpResponse{500, "application/json",
                        R"({"error":{"code":"internal_error","message":"the server failed on this request"},"ok":false})",
                        {}};
}

// WebSocket close code 1011: internal error (RFC 6455, section 7.4.1).
constexpr std::uint16_t kCloseInternalError = 1011;

}  // namespace

struct IxTransport::Impl {
    struct Connection {
        std::weak_ptr<ix::WebSocket> socket;
        bool open = false;
        std::string path;
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
            try {
                serve(socket, state);
            } catch (...) {
                // A handler failed before the upgrade (after it, the message
                // callback catches its own): answer 500 while the socket is ours.
                if (socket) {
                    try {
                        ix::Http::sendResponse(toIx(internalError()), socket);
                    } catch (...) {
                    }
                }
            }
            state->setTerminated();
        }

        void serve(std::unique_ptr<ix::Socket>& socket, const std::shared_ptr<ix::ConnectionState>& state) {
            auto [ok, error, request] = ix::Http::parseRequest(socket, kHttpTimeoutSecs);
            (void)error;
            if (!ok || !request) {
                return;
            }
            const HttpRequest converted = toRequest(*request);
            auto upgrade = converted.headers.find("upgrade");
            if (upgrade != converted.headers.end() && lower(upgrade->second) == "websocket") {
                if (auto rejection = owner_.handlers.onUpgrade(converted)) {
                    ix::Http::sendResponse(toIx(*rejection), socket);
                } else {
                    // attach() runs inside handleUpgrade, on this thread.
                    owner_.rememberPath(state.get(), converted.path);
                    handleUpgrade(std::move(socket), state, request);
                    owner_.finish(state.get());
                }
            } else {
                ix::Http::sendResponse(toIx(owner_.handlers.onHttp(converted)), socket);
            }
        }

        Impl& owner_;
    };

    TransportHandlers handlers;
    std::unique_ptr<Server> server;

    std::mutex mutex;
    std::map<ConnectionId, Connection> connections;
    std::map<const ix::ConnectionState*, ConnectionId> byState;
    std::map<const ix::ConnectionState*, std::string> pendingPaths;  // upgrade path until attach()
    ConnectionId nextId = 1;

    void rememberPath(const ix::ConnectionState* state, std::string path) {
        std::lock_guard lock(mutex);
        pendingPaths[state] = std::move(path);
    }

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
            std::string path;
            if (auto pending = pendingPaths.find(state.get()); pending != pendingPaths.end()) {
                path = std::move(pending->second);
                pendingPaths.erase(pending);
            }
            connections[id] = Connection{weak, false, std::move(path)};
            byState[state.get()] = id;
        }
        socket->setOnMessageCallback([this, id, weak](const ix::WebSocketMessagePtr& message) {
            try {
                dispatch(id, message);
            } catch (...) {
                // The connection's state is unknown after a failed handler: close it.
                if (auto live = weak.lock()) {
                    live->close(kCloseInternalError, "internal_error");
                }
            }
        });
    }

    // The connection's thread, inside its message callback.
    void dispatch(ConnectionId id, const ix::WebSocketMessagePtr& message) {
        switch (message->type) {
            case ix::WebSocketMessageType::Open: {
                std::string path;
                {
                    std::lock_guard lock(mutex);
                    auto it = connections.find(id);
                    if (it == connections.end()) {
                        return;
                    }
                    it->second.open = true;
                    path = it->second.path;
                }
                handlers.onOpen(id, path);
                break;
            }
            case ix::WebSocketMessageType::Message:
                if (!message->binary) {
                    handlers.onMessage(id, message->str);
                }
                break;
            case ix::WebSocketMessageType::Close:
                finish(id);
                break;
            default:
                break;
        }
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
            pendingPaths.erase(state);
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

void IxTransport::sendBinary(ConnectionId connection, const std::string& bytes) {
    if (auto socket = impl_->socketOf(connection)) {
        socket->sendBinary(bytes);
    }
}

std::size_t IxTransport::bufferedAmount(ConnectionId connection) const {
    auto socket = impl_->socketOf(connection);
    return socket ? socket->bufferedAmount() : 0;
}

void IxTransport::close(ConnectionId connection, int code, const std::string& reason) {
    if (auto socket = impl_->socketOf(connection)) {
        socket->close(static_cast<std::uint16_t>(code), reason);
    }
}

}  // namespace siann::protocol
