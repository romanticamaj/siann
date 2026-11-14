#pragma once

// Protocol server v0 (architecture spec, "siann-protocol", decisions of
// 2026-11-04).
//
//   client                                server
//   {type:"auth", token}             ->   {type:"auth", ok, sessionId, revision, documentHash}
//   {requestId, sessionId, method,   ->   {requestId, ok:true, result}
//    params, expectedRevision?}           {requestId, ok:false, error:{code, message, step?, data?}}
//
// A request with expectedRevision other than the head revision is answered
// revision_mismatch without running the method.
// Transport threads parse and validate frames and hand requests to a bounded
// inbox; pump() executes them on the caller's thread, which is the only thread
// that touches the session (the command thread). A full inbox answers
// queue_full at once. Executed responses are cached by requestId, so a
// duplicate returns the original response text, also after a reconnect.
//
// Events v1 (docs/schemas/protocol-events-v1.md): {type:"auth", token,
// events:true} subscribes the connection to the event stream; the reply adds
// the stream's seq, the current meter legend `meters` and the build's `about`. pump() flushes the event outboxes
// after the responses. Connections on kRealtimePath authenticate the same way
// and then receive only binary meter frames.
//
// m3-mcp (spec, Protocol v0 items 14 to 16): plan.*, proposal.*,
// audition.hear (through ServerOptions::auditionPort), render.start and
// job.status (Jobs v0), session.save and session.open, command.list and
// engine.capabilities; the MCP adapter serves them as tools on POST
// /v0/mcp (docs/schemas/protocol-mcp-v0.md).
//
// m4-engine-device (spec, Protocol v0 item 18): transport.play, transport.stop,
// transport.locate and engine.status, through ServerOptions::transportPort.
//
// m4-plugin-node (spec, Protocol v0 item 19): plugin.instantiate (a job that runs
// inside its request), plugin.open_editor and plugin.close_editor, engine.status
// plugins[], and render.start's own plugin instances, through
// ServerOptions::pluginPort.
//
// m5b-engine-record (spec, Protocol v0 items 22 and 27): engine.select_device's
// inputId, record.arm, transport.record and record.recover_take through
// ServerOptions::recordPort; record.changed whenever the port's record state
// differs after a request or a pump (with the session.changed of a commit the
// engine host made itself), and the pending takes in the auth reply and every
// session.sync chunk.
//
// m5-mixer (spec, Protocol v0 item 24): gesture.begin, gesture.update,
// gesture.hold, gesture.end and gesture.cancel through ServerOptions::
// gesturePort, each gesture under a lease of the connection that began it
// (docs/schemas/protocol-gestures-v0.md).
//
// m5b-engine-project-media (spec, Protocol v0 item 27; Jobs v0, import):
// session.create through ServerOptions::createSession, and media.import, a job
// whose worker writes the files and whose media.add the command thread commits.

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "siann/hash/json.hpp"
#include "siann/session/media_import.hpp"
#include "siann/protocol/audition_port.hpp"
#include "siann/protocol/event_stream.hpp"
#include "siann/protocol/gesture_port.hpp"
#include "siann/protocol/plugin_port.hpp"
#include "siann/protocol/realtime_channel.hpp"
#include "siann/protocol/record_port.hpp"
#include "siann/protocol/transport.hpp"
#include "siann/protocol/transport_port.hpp"
#include "siann/session/session.hpp"

namespace siann::protocol {

// The Origin of the SIANN app (the Electron shell loads the UI from this scheme).
inline constexpr std::string_view kAppOrigin = "siann://app";

// The MCP path (docs/schemas/protocol-mcp-v0.md).
inline constexpr std::string_view kMcpPath = "/v0/mcp";

// MCP scopes v0 (spec, "Security rules", Scopes v0).
enum class McpScope { propose, trusted };

// "propose" or "trusted".
std::string_view mcpScopeName(McpScope scope) noexcept;

struct JobOptions {
    // true: one worker thread runs the jobs (the offline-render thread).
    // false: queued jobs wait for runJobs() on the caller's thread (tests).
    bool workerThread = true;
};

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
    // Event outboxes (docs/schemas/protocol-events-v1.md).
    EventStreamOptions events{};
    // Entities per session.sync chunk.
    std::size_t syncChunkEntities = 500;
    RealtimeOptions realtime{};
    // MCP (docs/schemas/protocol-mcp-v0.md): the scope every MCP client gets
    // (the scope of mcpToken(), checked on the command thread), and how long the protocol thread waits for the command thread's answer.
    McpScope mcpScope = McpScope::propose;
    std::chrono::milliseconds mcpRequestTimeout{30'000};
    // The engine host's auditioner; nullptr: audition.hear is audition_unavailable.
    // Must outlive the server.
    AuditionPort* auditionPort = nullptr;
    // The engine host's transport and device; nullptr: transport.* and
    // engine.status are not_supported. Must outlive the server.
    TransportPort* transportPort = nullptr;
    // The engine host's plugin hosts; nullptr: plugin.* is not_supported and
    // render.start renders every plugin slot dry. Must outlive the server.
    PluginPort* pluginPort = nullptr;
    // The engine host's fader gestures (Protocol v0 item 24); nullptr: gesture.*
    // is not_supported. Must outlive the server.
    GesturePort* gesturePort = nullptr;
    // The engine host's recording (Protocol v0 item 28, m5b-engine-record);
    // nullptr: record.arm, transport.record and record.recover_take are
    // not_supported. Must outlive the server.
    RecordPort* recordPort = nullptr;
    // How long a gesture's lease lasts without a renewal, and the clock it is
    // measured on (empty: the steady clock; tests inject one).
    std::chrono::milliseconds gestureLeaseMs{5'000};
    std::function<std::chrono::steady_clock::time_point()> steadyClock;
    // session.open: opens the bundle and returns the session to serve from now
    // on (owned by the launcher, which rebinds its engine inside). Runs on the
    // command thread. Empty: session.open is not_supported.
    std::function<session::Session&(const std::filesystem::path&)> openSession;
    // session.create (Protocol v0 item 27): creates an empty bundle at `path` (the
    // server has checked it is absolute, not UNC, absent, with an existing parent),
    // whose root is `name` at `sampleRate`, and returns the session to serve from
    // now on (the launcher rebinds its engine inside, as for openSession). Runs on
    // the command thread. Empty: session.create is not_supported.
    std::function<session::Session&(const std::filesystem::path& path, const std::string& name,
                                    std::int64_t sampleRate)>
        createSession;
    // media.import (Jobs v0, import): opens the file to import, on the jobs worker.
    // Empty: session::openImportSource. Tests pass a paced decoder.
    std::function<session::ImportSource(const std::filesystem::path&)> openImportSource;
    JobOptions jobs{};
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

    // The UI's credential: 64 lowercase hex characters, random per server. It
    // authenticates the WebSocket, the realtime path and plain HTTP, never
    // /v0/mcp.
    const std::string& token() const noexcept;
    // The MCP clients' credential (Bearer on /v0/mcp only), random per server
    // and distinct from token(); it carries ServerOptions::mcpScope.
    const std::string& mcpToken() const noexcept;
    // "ses_<hex>", random per server.
    const std::string& sessionId() const noexcept;
    // The bound port after start().
    std::uint16_t port() const noexcept;

    // A revision committed on the command thread outside the protocol (the
    // engine's own commands): moves the stream's head and publishes
    // session.changed. The protocol's own methods do this themselves.
    void publishRevision(const command::Revision& revision);

    // The event stream (subscribed connections) and the realtime channel
    // (authenticated kRealtimePath connections), for the engine's publishers.
    EventStream& events() noexcept;
    RealtimeChannel& realtime() noexcept;

    // The session served now (session.open replaces it). Command thread.
    session::Session& session() noexcept;

    // One MCP HTTP request (POST /v0/mcp, docs/schemas/protocol-mcp-v0.md)
    // without blocking: `complete` runs with the response, at once when no
    // method has to run, otherwise on the command thread when pump() handles
    // the tool call. The transport's onHttp handler uses it and waits.
    void handleMcp(const HttpRequest& request, std::function<void(HttpResponse)> complete);

    // Jobs (render.start): with JobOptions::workerThread false, runs every
    // queued job on the calling thread and returns how many ran.
    std::size_t runJobs();
    // Waits on the job's condition until it is done or failed; false on
    // timeout or for an unknown id.
    bool waitJob(const std::string& jobId, std::chrono::milliseconds timeout);
    // What job.status answers for the job (any thread, also after stop());
    // nullopt for an unknown id.
    std::optional<json::Value> jobStatus(const std::string& jobId) const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::protocol
