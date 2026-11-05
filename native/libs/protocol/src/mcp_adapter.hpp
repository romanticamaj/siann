#pragma once

// The MCP adapter (docs/schemas/protocol-mcp-v0.md): JSON-RPC 2.0 over
// Streamable HTTP with JSON responses, on the protocol server's POST
// /v0/mcp. Every tool is a one-to-one wrapper of a protocol method; a tool
// call becomes the protocol request "<Mcp-Session-Id>/<jsonrpc id>" so the
// server's idempotency cache answers retries. The caller has already checked
// the bearer token (the MCP credential, not the UI's), the Origin and the HTTP
// method.

#include <functional>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <vector>

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

class McpAdapter {
public:
    // Queues one protocol request; `done` later receives the response text.
    // Returns false when the inbox is full (nothing was queued).
    using Submit = std::function<bool(std::string requestId, std::string method, json::Value params,
                                      std::function<void(const std::string&)> done)>;

    // The scope is not the adapter's: the server ties it to the MCP
    // credential and checks it on the command thread.
    explicit McpAdapter(Submit submit);

    // `complete` runs exactly once: at once, or from `done`.
    void handle(const HttpRequest& request, const std::function<void(HttpResponse)>& complete);

private:
    Submit submit_;
    std::mutex mutex_;
    std::set<std::string> sessions_;  // Mcp-Session-Id values handed out
};

}  // namespace siann::protocol::detail
