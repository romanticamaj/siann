#pragma once

// siann-cli: the headless command line. Every command prints one JSON object
// on stdout: {"ok":true,...} or {"ok":false,"error":{"code","message"}}.
// Exit codes: 0 success, 1 command failure, 2 usage error.

#include <atomic>
#include <ostream>
#include <string>
#include <vector>

namespace siann::cli {

// args excludes the program name. Strings are UTF-8. `interrupt`, when given,
// is polled by the realtime commands: once it is true, an open-ended record
// stops and commits its take (main sets it on SIGINT / Ctrl+C).
int runCli(const std::vector<std::string>& args, std::ostream& out, const std::atomic<bool>* interrupt = nullptr);

}  // namespace siann::cli
