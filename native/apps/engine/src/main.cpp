// siann-engine: the engine process the Electron shell spawns and supervises
// (architecture spec, "Process model"; Protocol v0 item 17). It stops, and
// exits 0, when its stdin reaches EOF (the launcher holds the pipe, so a dead
// launcher never leaves an orphan) and on SIGTERM / CTRL_BREAK.

#include <atomic>
#include <csignal>
#include <iostream>
#include <ostream>
#include <streambuf>
#include <string>
#include <thread>
#include <vector>

#include "siann/engine_app/engine.hpp"

namespace {

std::atomic<bool> stopRequested{false};
static_assert(std::atomic<bool>::is_always_lock_free, "the stop flag is set from a signal handler");

// Writes straight to a file descriptor, unbuffered: each insertion is a write
// (the ready line is two, its text and its newline; the launcher reads up to the
// newline). `writeFd` is the platform's write call, set below.
int writeFd(int fd, const char* data, std::size_t size);

class FdStreamBuf final : public std::streambuf {
public:
    explicit FdStreamBuf(int fd) : fd_(fd) {}

protected:
    int_type overflow(int_type ch) override {
        if (traits_type::eq_int_type(ch, traits_type::eof())) {
            return traits_type::not_eof(ch);
        }
        const char c = traits_type::to_char_type(ch);
        return writeAll(&c, 1) ? ch : traits_type::eof();
    }
    std::streamsize xsputn(const char* data, std::streamsize count) override {
        return writeAll(data, static_cast<std::size_t>(count)) ? count : 0;
    }

private:
    bool writeAll(const char* data, std::size_t size) {
        while (size > 0) {
            const int written = writeFd(fd_, data, size);
            if (written <= 0) {
                return false;
            }
            data += written;
            size -= static_cast<std::size_t>(written);
        }
        return true;
    }

    int fd_;
};

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

namespace {

// The launcher's stdout, moved off fd 1 before any plugin loads: the ready line
// goes to the duplicate, and fd 1 (and the Win32 standard output handle, which
// the CRT's dup does not touch) becomes stderr. Code sharing this CRT (JUCE, a
// plugin on the same runtime DLL) then prints to the shell's stderr log. A
// plugin with its own CRT took fd 1's handle value from the launcher's
// lpReserved2 block when it loaded; _dup2 closes that handle, so its writes fail
// and its output is dropped. The freed value is re-occupied with NUL below, so a
// handle the engine opens later cannot inherit that plugin's output. -1 when the
// redirect could not be made; stdout then stays as it is.
int detachHandshakeFd() {
    const int fd = _dup(_fileno(stdout));
    if (fd < 0) {
        return -1;
    }
    _setmode(fd, _O_BINARY);  // the ready line ends in "\n", not "\r\n"
    const HANDLE freed = reinterpret_cast<HANDLE>(_get_osfhandle(_fileno(stdout)));
    if (_dup2(_fileno(stderr), _fileno(stdout)) != 0) {
        _close(fd);
        return -1;
    }
    SetStdHandle(STD_OUTPUT_HANDLE, GetStdHandle(STD_ERROR_HANDLE));
    // Windows hands out the lowest free handle value, so NUL usually lands on the
    // freed one at once; a few tries cover a value taken meanwhile. The matching
    // handle stays open for the life of the process; the others are closed.
    HANDLE spare[8];
    int spares = 0;
    bool reoccupied = false;
    while (!reoccupied && spares < static_cast<int>(sizeof(spare) / sizeof(spare[0]))) {
        const HANDLE nul = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                                       OPEN_EXISTING, 0, nullptr);
        if (nul == INVALID_HANDLE_VALUE) {
            break;
        }
        if (nul == freed) {
            reoccupied = true;
        } else {
            spare[spares++] = nul;
        }
    }
    for (int i = 0; i < spares; ++i) {
        CloseHandle(spare[i]);
    }
    return fd;
}

int writeFd(int fd, const char* data, std::size_t size) {
    return _write(fd, data, static_cast<unsigned int>(size));
}

}  // namespace

int main() {
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCtrlHandler(onConsoleControl, TRUE);
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stderr), _O_BINARY);
    std::thread(watchStdin).detach();
    const int handshakeFd = detachHandshakeFd();
    FdStreamBuf handshakeBuffer(handshakeFd);
    std::ostream handshake(handshakeFd >= 0 ? &handshakeBuffer : std::cout.rdbuf());
    return siann::engine_app::runEngine(utf8Arguments(), handshake, std::cerr, &stopRequested);
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

namespace {

// As on Windows: the launcher's stdout moves off fd 1 before any plugin loads,
// and fd 1 becomes stderr. Here fd 1 is the kernel's, shared by every library in
// the process, so any plugin's stdout output reaches the shell's stderr log. -1
// when the redirect fails; stdout then stays as it is.
int detachHandshakeFd() {
    const int fd = ::dup(STDOUT_FILENO);
    if (fd < 0) {
        return -1;
    }
    if (::dup2(STDERR_FILENO, STDOUT_FILENO) < 0) {
        ::close(fd);
        return -1;
    }
    return fd;
}

int writeFd(int fd, const char* data, std::size_t size) {
    for (;;) {
        const ssize_t written = ::write(fd, data, size);
        if (written < 0 && errno == EINTR) {
            continue;
        }
        return static_cast<int>(written);
    }
}

}  // namespace

int main(int argc, char** argv) {
    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);
    std::signal(SIGPIPE, SIG_IGN);
    std::thread(watchStdin).detach();
    const int handshakeFd = detachHandshakeFd();
    FdStreamBuf handshakeBuffer(handshakeFd);
    std::ostream handshake(handshakeFd >= 0 ? &handshakeBuffer : std::cout.rdbuf());
    return siann::engine_app::runEngine(std::vector<std::string>(argv + 1, argv + argc), handshake, std::cerr,
                                        &stopRequested);
}

#endif
