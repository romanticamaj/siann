#pragma once

// The connected agents (spec, Protocol v0 item 29, m5b-engine-plan-metadata, UI
// redesign E-14). Every MCP session is an agent: initialize connects it, any
// request with its session header keeps it connected (and reconnects it after an
// idle spell), DELETE /v0/mcp ends its session. The command thread records what
// it executed for an agent (the tool's name, never its arguments) and expires
// agents idle past ServerOptions::agentIdleMs.
//
// Threads: the transport threads call connect, seen and end; the command thread
// calls acted, expire and snapshot. One mutex of its own guards the table; it is
// never held while calling out (the `changed` callback wakes the command
// thread). Nothing here touches the audio thread.

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "siann/hash/json.hpp"

namespace siann::protocol::detail {

// The names a client gives itself (MCP clientInfo.name, the UI's auth frame
// client.name), as the actor of its plans and an agent's name: control
// characters (C0, DEL, C1), bidi formatting and line separators
// (command::withoutUnsafeCharacters) and bytes that are not UTF-8 removed, leading and trailing white space trimmed,
// cut to kClientNameMaxBytes UTF-8 bytes at a character boundary. `fallback`
// when the name is absent, not a string or empty after that.
inline constexpr std::size_t kClientNameMaxBytes = 64;
inline constexpr std::string_view kDefaultMcpName = "MCP client";
inline constexpr std::string_view kDefaultUiName = "SIANN";
std::string sanitizeClientName(const json::Value* name, std::string_view fallback);

// One agent as engine.status lists it and agent.changed carries it.
struct AgentView {
    std::string id;  // agt_<hex>, never the Mcp-Session-Id
    std::string name;
    bool connected = false;
    std::optional<std::string> lastAction;    // a tool name
    std::optional<std::string> lastActionAt;  // the server clock's ISO time
    std::uint64_t actions = 0;  // not published: tells two actions with the same name and time apart

    friend bool operator==(const AgentView&, const AgentView&) = default;
};

json::Value agentJson(const AgentView& agent);

class AgentRegistry {
public:
    using Clock = std::function<std::chrono::steady_clock::time_point()>;

    // `retained`: at most this many agents are kept; `changed` runs (outside the
    // lock) when a transport thread changed what the command thread publishes.
    AgentRegistry(std::size_t retained, Clock clock, std::function<void()> changed);

    // initialize: a new session and its agent, connected; returns the session id
    // (mcp_<hex>). Past `retained` the oldest disconnected agent is forgotten, or
    // when every one is connected the oldest, whose session ends.
    std::string connect(std::string name);

    struct Caller {
        std::string agentId;
        std::string name;
    };
    // A request with this session header: the session's agent, now seen (and
    // connected again after idling); nullopt for an unknown or ended session.
    std::optional<Caller> seen(const std::string& session);

    // DELETE /v0/mcp: ends the session; false for an unknown one.
    bool end(const std::string& session);

    // Command thread.
    void acted(const std::string& agentId, std::string tool, std::string time);
    // A parked next_request (Protocol v0 item 32) keeps its agent connected: the
    // agent counts as seen now. Does nothing for an ended or unknown session.
    void touch(const std::string& agentId);
    // Disconnects every connected agent not seen for `idle` or longer.
    void expire(std::chrono::milliseconds idle);
    // In the order the agents initialized.
    std::vector<AgentView> snapshot() const;

private:
    struct Entry {
        AgentView view;
        std::optional<std::string> session;  // empty once ended
        std::chrono::steady_clock::time_point lastSeen{};
    };

    std::size_t retained_;
    Clock clock_;
    std::function<void()> changed_;
    mutable std::mutex mutex_;
    std::vector<Entry> agents_;
};

}  // namespace siann::protocol::detail
