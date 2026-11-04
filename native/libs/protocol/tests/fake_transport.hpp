#pragma once

// In-memory Transport for deterministic protocol tests: no sockets, no
// threads. The test plays the client side: connect() runs the upgrade
// handler, deliver() hands a text frame to the server, sent() returns what
// the server answered on a connection.

#include <chrono>
#include <condition_variable>
#include <cstddef>
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
        sentChanged_.notify_all();
    }

    void sendBinary(ConnectionId connection, const std::string& bytes) override {
        std::lock_guard lock(mutex_);
        auto it = connections_.find(connection);
        if (it != connections_.end() && !it->second.closed) {
            it->second.binary.push_back(bytes);
        }
        sentChanged_.notify_all();
    }

    std::size_t bufferedAmount(ConnectionId connection) const override {
        std::lock_guard lock(mutex_);
        auto it = connections_.find(connection);
        return it == connections_.end() || it->second.closed ? 0 : it->second.buffered;
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

    Upgrade connect(Headers headers = {}, const std::string& path = "/") {
        HttpRequest request{"GET", path, std::move(headers), {}};
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
        handlers_.onOpen(id, path);
        return Upgrade{id, {}};
    }

    // Opens a connection on the realtime path.
    Upgrade connectRealtime(Headers headers = {}) { return connect(std::move(headers), "/v1/realtime"); }

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

    // Waits until the server has sent at least count frames on the connection
    // (for tests with the pump thread on). The timeout only bounds a hang.
    bool waitSent(ConnectionId connection, std::size_t count,
                  std::chrono::milliseconds timeout = std::chrono::seconds(10)) const {
        std::unique_lock lock(mutex_);
        return sentChanged_.wait_for(lock, timeout, [&] { return connections_.at(connection).sent.size() >= count; });
    }

    // Binary frames the server sent on the connection.
    std::vector<std::string> binary(ConnectionId connection) const {
        std::lock_guard lock(mutex_);
        return connections_.at(connection).binary;
    }

    // Simulates a congested socket: bufferedAmount() reports `bytes`.
    void setBufferedAmount(ConnectionId connection, std::size_t bytes) {
        std::lock_guard lock(mutex_);
        connections_.at(connection).buffered = bytes;
    }

    bool closed(ConnectionId connection) const {
        std::lock_guard lock(mutex_);
        return connections_.at(connection).closed;
    }

    int closeCode(ConnectionId connection) const {
        std::lock_guard lock(mutex_);
        return connections_.at(connection).closeCode;
    }

    bool listening() const noexcept { return listening_; }
    const std::string& host() const noexcept { return host_; }

private:
    struct Connection {
        std::vector<std::string> sent;
        std::vector<std::string> binary;
        std::size_t buffered = 0;
        bool closed = false;
        int closeCode = 0;
    };

    TransportHandlers handlers_;
    mutable std::mutex mutex_;
    mutable std::condition_variable sentChanged_;
    std::map<ConnectionId, Connection> connections_;
    ConnectionId nextId_ = 1;
    bool listening_ = false;
    std::string host_;
};

}  // namespace siann::protocol::testing
