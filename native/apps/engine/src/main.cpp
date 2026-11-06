// siann-engine: the engine process the Electron shell spawns and supervises
// (architecture spec, "Process model"; Protocol v0 item 17). It stops, and
// exits 0, when its stdin reaches EOF (the launcher holds the pipe, so a dead
// launcher never leaves an orphan) and on SIGTERM / CTRL_BREAK.

#include <atomic>
#include <csignal>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "siann/engine_app/engine.hpp"

namespace {

std::atomic<bool> stopRequested{false};
static_assert(std::atomic<bool>::is_always_lock_free, "the stop flag is set from a signal handler");

}  // namespace

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#include <shellapi.h>

namespace {

BOOL WINAPI onConsoleControl(DWORD type) {
    if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT || type == CTRL_CLOSE_EVENT) {
        stopRequested.store(true);
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

// Reads (and discards) stdin until EOF or a broken pipe, then asks to stop.
void watchStdin() {
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    char buffer[256];
    DWORD read = 0;
    while (input != nullptr && input != INVALID_HANDLE_VALUE &&
           ReadFile(input, buffer, sizeof(buffer), &read, nullptr) && read > 0) {
    }
    stopRequested.store(true);
}

}  // namespace

int main() {
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCtrlHandler(onConsoleControl, TRUE);
    // The ready line ends in "\n", not "\r\n".
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stderr), _O_BINARY);
    std::thread(watchStdin).detach();
    return siann::engine_app::runEngine(utf8Arguments(), std::cout, std::cerr, &stopRequested);
}

#else

#include <cerrno>
#include <unistd.h>

namespace {

void onSignal(int) {
    stopRequested.store(true);
}

void watchStdin() {
    char buffer[256];
    for (;;) {
        const ssize_t got = ::read(STDIN_FILENO, buffer, sizeof(buffer));
        if (got > 0) {
            continue;
        }
        if (got < 0 && errno == EINTR) {
            continue;
        }
        break;
    }
    stopRequested.store(true);
}

}  // namespace

int main(int argc, char** argv) {
    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);
    std::signal(SIGPIPE, SIG_IGN);
    std::thread(watchStdin).detach();
    return siann::engine_app::runEngine(std::vector<std::string>(argv + 1, argv + argc), std::cout, std::cerr,
                                        &stopRequested);
}

#endif
