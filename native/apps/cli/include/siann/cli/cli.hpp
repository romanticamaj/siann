#pragma once

// siann-cli: the headless command line for M1. Every command prints one JSON
// object on stdout: {"ok":true,...} or {"ok":false,"error":{"code","message"}}.
// Exit codes: 0 success, 1 command failure, 2 usage error.

#include <ostream>
#include <string>
#include <vector>

namespace siann::cli {

// args excludes the program name. Strings are UTF-8.
int runCli(const std::vector<std::string>& args, std::ostream& out);

}  // namespace siann::cli
