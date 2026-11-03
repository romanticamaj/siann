#pragma once

// A child process that a test can hard-kill: TerminateProcess on Windows,
// SIGKILL on POSIX. Nothing in the child runs after the kill, as after a
// crash or a power cut of the engine process.

#include <stdexcept>
#include <string>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <signal.h>
#include <spawn.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
extern char** environ;
#endif

namespace siann::cli::test {

class ChildProcess {
public:
    // Starts `executable` with `args` (UTF-8, without the program name).
    ChildProcess(const std::string& executable, const std::vector<std::string>& args) {
#if defined(_WIN32)
        std::wstring commandLine = quote(widen(executable));
        for (const std::string& arg : args) {
            commandLine += L' ';
            commandLine += quote(widen(arg));
        }
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        PROCESS_INFORMATION info{};
        const std::wstring exe = widen(executable);
        if (!CreateProcessW(exe.c_str(), commandLine.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup,
                            &info)) {
            throw std::runtime_error("CreateProcessW failed: " + std::to_string(GetLastError()));
        }
        CloseHandle(info.hThread);
        process_ = info.hProcess;
#else
        std::vector<std::string> storage;
        storage.push_back(executable);
        storage.insert(storage.end(), args.begin(), args.end());
        std::vector<char*> argv;
        for (std::string& s : storage) {
            argv.push_back(s.data());
        }
        argv.push_back(nullptr);
        const int rc = posix_spawn(&pid_, executable.c_str(), nullptr, nullptr, argv.data(), environ);
        if (rc != 0) {
            throw std::runtime_error("posix_spawn failed: " + std::to_string(rc));
        }
#endif
    }

    ~ChildProcess() {
        try {
            kill();
        } catch (...) {
        }
    }

    ChildProcess(const ChildProcess&) = delete;
    ChildProcess& operator=(const ChildProcess&) = delete;

    // True until the child has exited.
    bool running() {
#if defined(_WIN32)
        return process_ != nullptr && WaitForSingleObject(process_, 0) == WAIT_TIMEOUT;
#else
        if (pid_ <= 0 || reaped_) {
            return false;
        }
        int status = 0;
        const pid_t done = waitpid(pid_, &status, WNOHANG);
        if (done == pid_) {
            reaped_ = true;
            return false;
        }
        return true;
#endif
    }

    // Hard-kills the child and waits until it is gone (its files closed).
    void kill() {
#if defined(_WIN32)
        if (process_ == nullptr) {
            return;
        }
        TerminateProcess(process_, 137);
        WaitForSingleObject(process_, INFINITE);
        CloseHandle(process_);
        process_ = nullptr;
#else
        if (pid_ <= 0 || reaped_) {
            return;
        }
        ::kill(pid_, SIGKILL);
        int status = 0;
        while (waitpid(pid_, &status, 0) < 0 && errno == EINTR) {
        }
        reaped_ = true;
#endif
    }

private:
#if defined(_WIN32)
    static std::wstring widen(const std::string& utf8) {
        if (utf8.empty()) {
            return std::wstring();
        }
        const int count = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
        std::wstring wide(static_cast<std::size_t>(count), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), wide.data(), count);
        return wide;
    }

    // Quoting for CommandLineToArgvW: backslashes are literal unless they
    // precede a quote.
    static std::wstring quote(const std::wstring& arg) {
        std::wstring out = L"\"";
        std::size_t backslashes = 0;
        for (const wchar_t c : arg) {
            if (c == L'\\') {
                ++backslashes;
                continue;
            }
            if (c == L'"') {
                out.append(backslashes * 2 + 1, L'\\');
            } else {
                out.append(backslashes, L'\\');
            }
            backslashes = 0;
            out += c;
        }
        out.append(backslashes * 2, L'\\');
        out += L'"';
        return out;
    }

    HANDLE process_ = nullptr;
#else
    pid_t pid_ = -1;
    bool reaped_ = false;
#endif
};

}  // namespace siann::cli::test
