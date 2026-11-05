#pragma once

// The thin adapter between siann-protocol and a WebSocket/HTTP library
// (architecture spec, "siann-protocol"; IXWebSocket behind it, see
// ix_transport.hpp). The protocol server owns no sockets: it reacts to the
// handlers below and answers through send and close. Tests drive it through an
// in-memory transport.

#include <cstdint>
#include <cstddef>
#include <functional>
#include <map>
#include <optional>
#include <string>

namespace siann::protocol {

using ConnectionId = std::uint64_t;

// Header names are lowercase.
using Headers = std::map<std::string, std::string>;

struct HttpRequest {
    std::string method;
    std::string path;  // without the query string
    Headers headers;
    std::string body;
};

struct HttpResponse {
    int status = 200;
    std::string contentType = "application/json";
    std::string body;
    // Extra response headers, as written (for example "Mcp-Session-Id").
    Headers headers{};
};

struct TransportHandlers {
    // Called with the HTTP upgrade request. std::nullopt accepts it; a response
    // rejects it and no socket is opened.
    std::function<std::optional<HttpResponse>(const HttpRequest&)> onUpgrade;
    // The socket is open; `path` is the upgrade request's path (no query string).
    std::function<void(ConnectionId, const std::string& path)> onOpen;
    // One text frame (binary frames from clients are ignored).
    std::function<void(ConnectionId, const std::string&)> onMessage;
    std::function<void(ConnectionId)> onClose;
    // A plain (non-upgrade) HTTP request.
    std::function<HttpResponse(const HttpRequest&)> onHttp;
};

struct Listening {
    std::uint16_t port = 0;  // the bound port, also when 0 was requested
};

class Transport {
public:
    virtual ~Transport() = default;

    // Set once, before listen. Handlers may run on transport threads.
    virtual void setHandlers(TransportHandlers handlers) = 0;
    // Port 0 picks a free port. Throws std::runtime_error when it cannot bind.
    virtual Listening listen(const std::string& host, std::uint16_t port) = 0;
    // Closes every connection and stops listening; no handler runs afterwards.
    virtual void stop() = 0;
    // send, sendBinary and close are ignored for a connection that is already closed.
    virtual void send(ConnectionId connection, const std::string& text) = 0;
    // One binary frame.
    virtual void sendBinary(ConnectionId connection, const std::string& bytes) = 0;
    // Bytes queued on the socket and not yet written; 0 for a closed connection.
    virtual std::size_t bufferedAmount(ConnectionId connection) const = 0;
    virtual void close(ConnectionId connection, int code, const std::string& reason) = 0;
};

}  // namespace siann::protocol
