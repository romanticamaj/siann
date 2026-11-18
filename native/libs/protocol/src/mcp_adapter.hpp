#pragma once

// The MCP adapter (docs/schemas/protocol-mcp-v0.md): JSON-RPC 2.0 over
// Streamable HTTP with JSON responses, on the protocol server's POST
// /v0/mcp. Every tool is a one-to-one wrapper of a protocol method; a tool
// call becomes the protocol request "<Mcp-Session-Id>/<jsonrpc id>" so the
// server's idempotency cache answers retries. The caller has already checked
// the bearer token (the MCP credential, not the UI's), the Origin and the HTTP
// method. Every session is an agent of the AgentRegistry (m5b-engine-plan-
// metadata): initialize names it after clientInfo.name, every request marks it
// seen, and end() serves DELETE /v0/mcp.

#include <functional>
#include <string>
#include <string_view>
#include <vector>

#include "agent_registry.hpp"
#include "siann/hash/json.hpp"
#include "siann/protocol/protocol_server.hpp"
#include "siann/protocol/transport.hpp"

namespace siann::protocol::detail {

struct McpTool {
    std::string_view name;
    std::string_view method;
    McpScope scope;
    std::string_view description;
    std::string_view inputSchema;  // JSON Schema text
};

// The tools in tools/list order.
const std::vector<McpTool>& mcpTools();

// A protocol method with no MCP tool, and why (kNotMcp). Every method of
// protocolMethods() is a tool's method or one of these (protocol_parity_test).
struct McpExclusion {
    std::string_view method;
    std::string_view reason;
};

const std::vector<McpExclusion>& mcpExclusions();

// The methods engine.capabilities lists, in its order (kMethods,
// protocol_server.cpp).
const std::vector<std::string_view>& protocolMethods();

// Who a tool call came from: the session's agent and the tool's name, for the
// plan's actor and the agent's lastAction (never the arguments).
struct McpCaller {
    std::string agentId;
    std::string name;
    std::string tool;
};

class McpAdapter {
public:
    // Queues one protocol request; `done` later receives the response text.
    // Returns false when the inbox is full (nothing was queued).
    using Submit = std::function<bool(std::string requestId, std::string method, json::Value params,
                                      McpCaller caller, std::function<void(const std::string&)> done)>;

    // The scope is not the adapter's: the server ties it to the MCP
    // credential and checks it on the command thread. `agents` must outlive it.
    McpAdapter(Submit submit, AgentRegistry& agents);

    // POST: `complete` runs exactly once, at once or from `done`.
    void handle(const HttpRequest& request, const std::function<void(HttpResponse)>& complete);
    // DELETE: ends the session named by the header (204), 400 without one, 404
    // for an unknown one. `complete` runs at once.
    void end(const HttpRequest& request, const std::function<void(HttpResponse)>& complete);

private:
    Submit submit_;
    AgentRegistry& agents_;
};

}  // namespace siann::protocol::detail
