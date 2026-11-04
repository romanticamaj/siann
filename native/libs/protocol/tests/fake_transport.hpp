#pragma once

// In-memory Transport for deterministic protocol tests: no sockets, no
// threads. The test plays the client side: connect() runs the upgrade
// handler, deliver() hands a text frame to the server, sent() returns what
// the server answered on a connection.

#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "siann/protocol/transport.hpp"

namespace siann::protocol::testing {

class FakeTransport final : public Transport {
public:
    struct Upgrade {
        std::optional<ConnectionId> connection;  // set when accepted
        HttpResponse rejection;                  // set when rejected
    };

    void setHandlers(TransportHandlers handlers) override { handlers_ = std::move(handlers); }

    Listening listen(const std::string& host, std::uint16_t port) override {
        listening_ = true;
        host_ = host;
        return Listening{port == 0 ? std::uint16_t{40000} : port};
    }

    void stop() override { listening_ = false; }

    void send(ConnectionId connection, const std::string& text) override {
        std::lock_guard lock(mutex_);
        auto it = connections_.find(connection);
        if (it != connections_.end() && !it->second.closed) {
            it->second.sent.push_back(text);
        }
    }

    void close(ConnectionId connection, int code, const std::string&) override {
        {
            std::lock_guard lock(mutex_);
            auto it = connections_.find(connection);
            if (it == connections_.end() || it->second.closed) {
                return;
            }
            it->second.closed = true;
            it->second.closeCode = code;
        }
        if (handlers_.onClose) {
            handlers_.onClose(connection);
        }
    }

    // Client side.

    Upgrade connect(Headers headers = {}) {
        HttpRequest request{"GET", "/", std::move(headers), {}};
        request.headers.emplace("upgrade", "websocket");
        if (auto rejection = handlers_.onUpgrade(request)) {
            return Upgrade{std::nullopt, *rejection};
        }
        ConnectionId id = 0;
        {
            std::lock_guard lock(mutex_);
            id = nextId_++;
            connections_[id];
        }
        handlers_.onOpen(id);
        return Upgrade{id, {}};
    }

    void deliver(ConnectionId connection, const std::string& text) {
        {
            std::lock_guard lock(mutex_);
            if (connections_.at(connection).closed) {
                return;
            }
        }
        handlers_.onMessage(connection, text);
    }

    // The client closes the socket.
    void disconnect(ConnectionId connection) { close(connection, 1000, "client"); }

    HttpResponse http(HttpRequest request) { return handlers_.onHttp(request); }

    std::vector<std::string> sent(ConnectionId connection) const {
        std::lock_guard lock(mutex_);
        return connections_.at(connection).sent;
    }

    bool closed(ConnectionId connection) const {
        std::lock_guard lock(mutex_);
        return connections_.at(connection).closed;
    }

    bool listening() const noexcept { return listening_; }
    const std::string& host() const noexcept { return host_; }

private:
    struct Connection {
        std::vector<std::string> sent;
        bool closed = false;
        int closeCode = 0;
    };

    TransportHandlers handlers_;
    mutable std::mutex mutex_;
    std::map<ConnectionId, Connection> connections_;
    ConnectionId nextId_ = 1;
    bool listening_ = false;
    std::string host_;
};

}  // namespace siann::protocol::testing
