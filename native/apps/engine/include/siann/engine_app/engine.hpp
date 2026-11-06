#pragma once

// The siann-engine executable's body (architecture spec, "Process model" and
// siann-protocol, Protocol v0 item 17: the launcher handshake).
//
//   siann-engine --session <bundle> [--host 127.0.0.1] [--port 0] [--mcp-trusted]
//                [--owner-window <handle>] [--open-editor <bundle>]
//
// Opens the bundle, or creates a new empty session there when the directory
// does not exist, starts the protocol server and writes exactly one line to
// `out` once it is listening:
//
//   {"schema":"siann.engine.ready.v0","port":<n>,"token":"<64 hex>",
//    "mcpToken":"<64 hex>","sessionId":"ses_<hex>","pid":<n>,"about":{...}}
//
// Nothing else is ever written to `out`. It then serves until `stop` is set
// (stdin EOF, SIGTERM or CTRL_BREAK in main.cpp) and returns 0. A bad launch
// writes one JSON error {ok:false, error:{code, message}} to `err`, nothing to
// `out`, and returns 1.
//
// A SIANN_WITH_JUCE build serves from the JUCE message loop, so call this on the
// process's main thread. There --open-editor opens the first plugin of a bundle
// before the ready line, owned on Windows by the window whose decimal handle
// --owner-window gives; a core-only build accepts --owner-window and refuses
// --open-editor with no_plugin_host.

#include <atomic>
#include <ostream>
#include <string>
#include <string_view>
#include <vector>

namespace siann::engine_app {

// The ready line's schema.
inline constexpr std::string_view kReadySchema = "siann.engine.ready.v0";

// `args` are UTF-8 without the program name. With `stop` null the engine
// serves until the process ends.
int runEngine(const std::vector<std::string>& args, std::ostream& out, std::ostream& err,
              const std::atomic<bool>* stop);

}  // namespace siann::engine_app
