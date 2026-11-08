#pragma once

// The siann-engine executable's body (architecture spec, "Process model" and
// siann-protocol, Protocol v0 item 17: the launcher handshake).
//
//   siann-engine --session <bundle> [--host 127.0.0.1] [--port 0] [--mcp-trusted]
//                [--owner-window <handle>]
//                [--device <id>] [--fake-callback-nanos N]
//
// Opens the bundle, or creates a new empty session there when the directory
// does not exist, loads it into the playback graph on a device (EngineHost; a
// device that cannot open is one line on `err`, never a failed launch), starts
// the protocol server and writes exactly one line to `out` once it is listening:
//
//   {"schema":"siann.engine.ready.v0","port":<n>,"token":"<64 hex>",
//    "mcpToken":"<64 hex>","sessionId":"ses_<hex>","pid":<n>,"about":{...}}
//
// Nothing else is ever written to `out`. It then serves until `stop` is set
// (stdin EOF, SIGTERM or CTRL_BREAK in main.cpp) and returns 0. A bad launch
// writes one JSON error {ok:false, error:{code, message}} to `err`, nothing to
// `out`, and returns 1.
//
// `out` must not be the process's fd 1 once a plugin can load: hosted plugins
// (and JUCE) print to stdout, and a line of theirs before or after the ready
// line is a failed launch for the shell. main.cpp duplicates the launcher's
// stdout into `out` and points fd 1 (and the Win32 standard output handle) at
// stderr before calling this. On POSIX that sends any plugin's stdout output to
// the shell's stderr log. On Windows it does so for code sharing the engine's
// CRT; a plugin with its own CRT holds the handle value the launcher passed in
// lpReserved2, which the redirect closes. main.cpp re-occupies the freed value
// with NUL so nothing the engine opens later receives that output: its writes
// normally succeed into NUL, and the output is dropped.
//
// Call this on the process's main thread: it is the command and control thread,
// which ticks the server and the host at most every 10 ms, and a SIANN_WITH_JUCE
// build serves from the JUCE message loop. plugin.open_editor (Protocol v0 item
// 19) opens a plugin's editor, owned on Windows by the window whose decimal
// handle --owner-window gives; a core-only build accepts --owner-window and hosts
// CLAP only. M4 removed --open-editor: it is an unknown option.

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

// The engine raises no dialog when it crashes (spec, "Process model", Crash;
// m4-crash-recovery): on Windows it adds SEM_FAILCRITICALERRORS and
// SEM_NOGPFAULTERRORBOX to the process's error mode (keeping the flags already
// set) and clears _WRITE_ABORT_MSG and _CALL_REPORTFAULT from the CRT's abort
// behaviour, so a plugin's crash ends the process at once and the shell restarts
// it. main() calls it first, before any plugin loads. Elsewhere it does nothing.
void disableCrashDialogs();

}  // namespace siann::engine_app
