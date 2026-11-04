#pragma once

// Protocol server v0 (architecture spec, "siann-protocol", decisions of
// 2026-11-04).
//
//   client                                server
//   {type:"auth", token}             ->   {type:"auth", ok, sessionId, revision, documentHash}
//   {requestId, sessionId, method,   ->   {requestId, ok:true, result}
//    params}                              {requestId, ok:false, error:{code, message, step?}}
//
// Transport threads parse and validate frames and hand requests to a bounded
// inbox; pump() executes them on the caller's thread, which is the only thread
// that touches the session (the command thread). A full inbox answers
// queue_full at once. Executed responses are cached by requestId, so a
// duplicate returns the original response text, also after a reconnect.

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "siann/protocol/transport.hpp"
#include "siann/session/session.hpp"

namespace siann::protocol {

// The Origin of the SIANN app (the Electron shell loads the UI from this scheme).
inline constexpr std::string_view kAppOrigin = "siann://app";

struct ServerOptions {
    std::string host = "127.0.0.1";
    std::uint16_t port = 0;  // 0 picks a free port
    // Origins accepted at the WebSocket upgrade. A request without an Origin
    // header is accepted (non-browser client); the token is required anyway.
    std::vector<std::string> allowedOrigins{std::string(kAppOrigin)};
    std::size_t inboxCapacity = 256;
    std::size_t idempotencyCapacity = 1024;
    // start() runs pump() on its own thread until stop(). Off, the owner calls
    // pump() (for example from the engine's command thread).
    bool pumpThread = true;
    std::string actor = "protocol";
    // ISO 8601 UTC time for revision envelopes; defaults to the system clock.
    std::function<std::string()> clock;
};

class ProtocolServer {
public:
    ProtocolServer(Transport& transport, session::Session& session, ServerOptions options = {});
    ~ProtocolServer();
    ProtocolServer(const ProtocolServer&) = delete;
    ProtocolServer& operator=(const ProtocolServer&) = delete;

    // Listens on options.host and options.port. Throws std::runtime_error.
    void start();
    void stop();

    // Executes every queued request on the calling thread and sends the
    // responses. Returns the number of requests handled.
    std::size_t pump();

    // 64 lowercase hex characters, random per server.
    const std::string& token() const noexcept;
    // "ses_<hex>", random per server.
    const std::string& sessionId() const noexcept;
    // The bound port after start().
    std::uint16_t port() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::protocol
