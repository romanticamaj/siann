#include <atomic>
#include <csignal>
#include <iostream>
#include <string>
#include <vector>

#include "siann/cli/cli.hpp"

namespace {

// Set on SIGINT / Ctrl+C: an open-ended `record` stops and commits its take.
std::atomic<bool> interrupted{false};
static_assert(std::atomic<bool>::is_always_lock_free, "the interrupt flag is set from a signal handler");

}  // namespace

#if defined(_WIN32)
#include <windows.h>
#include <shellapi.h>

namespace {

BOOL WINAPI onConsoleControl(DWORD type) {
    if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT) {
        interrupted.store(true);
        return TRUE;
    }
    return FALSE;
}

// Windows passes arguments in the ANSI code page; read the wide command line
// and convert to UTF-8 so non-ASCII paths survive.
std::vector<std::string> utf8Arguments() {
    int count = 0;
    LPWSTR* wide = CommandLineToArgvW(GetCommandLineW(), &count);
    std::vector<std::string> args;
    for (int i = 1; i < count; ++i) {
        const int bytes = WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, nullptr, 0, nullptr, nullptr);
        std::string arg(static_cast<std::size_t>(bytes > 0 ? bytes - 1 : 0), '\0');
        if (bytes > 1) {
            WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, arg.data(), bytes, nullptr, nullptr);
        }
        args.push_back(std::move(arg));
    }
    LocalFree(wide);
    return args;
}

}  // namespace

int main() {
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCtrlHandler(onConsoleControl, TRUE);
    return siann::cli::runCli(utf8Arguments(), std::cout, &interrupted);
}

#else

namespace {

void onSignal(int) {
    interrupted.store(true);
}

}  // namespace

int main(int argc, char** argv) {
    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);
    return siann::cli::runCli(std::vector<std::string>(argv + 1, argv + argc), std::cout, &interrupted);
}

#endif
