#pragma once

// A child process with its stdin, stdout and stderr on pipes, as a launcher
// (the Electron shell) runs siann-engine. Reader threads drain stdout and
// stderr so the child never blocks on a full pipe; a test reads the first
// stdout line, closes stdin (the launcher's way of saying "stop") and waits on
// the process exit. Waits are condition waits with a bounded timeout or
// waits on the process itself, never sleeps. Unlike cli/tests/support/
// child_process.hpp (stdout to a file, stdin inherited), the launcher needs
// all three pipes.

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
extern char** environ;
#endif

namespace siann::engine_app::test {

class PipedProcess {
public:
    static constexpr auto kTimeout = std::chrono::seconds(60);

    PipedProcess(const std::string& executable, const std::vector<std::string>& args) {
#if defined(_WIN32)
        SECURITY_ATTRIBUTES inherit{};
        inherit.nLength = sizeof(inherit);
        inherit.bInheritHandle = TRUE;
        HANDLE childIn = nullptr;
        HANDLE childOut = nullptr;
        HANDLE childErr = nullptr;
        if (!CreatePipe(&childIn, &stdin_, &inherit, 0) || !CreatePipe(&stdoutRead_, &childOut, &inherit, 0) ||
            !CreatePipe(&stderrRead_, &childErr, &inherit, 0)) {
            throw std::runtime_error("CreatePipe failed: " + std::to_string(GetLastError()));
        }
        // The parent's ends stay in the parent.
        SetHandleInformation(stdin_, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(stdoutRead_, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(stderrRead_, HANDLE_FLAG_INHERIT, 0);

        std::wstring commandLine = quote(widen(executable));
        for (const std::string& arg : args) {
            commandLine += L' ';
            commandLine += quote(widen(arg));
        }
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = childIn;
        startup.hStdOutput = childOut;
        startup.hStdError = childErr;
        PROCESS_INFORMATION info{};
        const std::wstring exe = widen(executable);
        const BOOL created = CreateProcessW(exe.c_str(), commandLine.data(), nullptr, nullptr, TRUE, 0, nullptr,
                                            nullptr, &startup, &info);
        const DWORD error = GetLastError();
        CloseHandle(childIn);  // the child holds its own copies
        CloseHandle(childOut);
        CloseHandle(childErr);
        if (!created) {
            closeAll();
            throw std::runtime_error("CreateProcessW failed: " + std::to_string(error));
        }
        CloseHandle(info.hThread);
        process_ = info.hProcess;
        pid_ = static_cast<long>(info.dwProcessId);
#else
        int in[2];
        int out[2];
        int errPipe[2];
        if (::pipe(in) != 0 || ::pipe(out) != 0 || ::pipe(errPipe) != 0) {
            throw std::runtime_error("pipe failed: " + std::to_string(errno));
        }
        for (const int fd : {in[0], in[1], out[0], out[1], errPipe[0], errPipe[1]}) {
            ::fcntl(fd, F_SETFD, FD_CLOEXEC);  // dup2 below clears it on 0, 1 and 2
        }
        std::vector<std::string> storage;
        storage.push_back(executable);
        storage.insert(storage.end(), args.begin(), args.end());
        std::vector<char*> argv;
        for (std::string& s : storage) {
            argv.push_back(s.data());
        }
        argv.push_back(nullptr);
        posix_spawn_file_actions_t actions;
        posix_spawn_file_actions_init(&actions);
        posix_spawn_file_actions_adddup2(&actions, in[0], STDIN_FILENO);
        posix_spawn_file_actions_adddup2(&actions, out[1], STDOUT_FILENO);
        posix_spawn_file_actions_adddup2(&actions, errPipe[1], STDERR_FILENO);
        pid_t child = -1;
        const int rc = posix_spawn(&child, executable.c_str(), &actions, nullptr, argv.data(), environ);
        posix_spawn_file_actions_destroy(&actions);
        ::close(in[0]);
        ::close(out[1]);
        ::close(errPipe[1]);
        stdin_ = in[1];
        stdoutRead_ = out[0];
        stderrRead_ = errPipe[0];
        if (rc != 0) {
            closeAll();
            throw std::runtime_error("posix_spawn failed: " + std::to_string(rc));
        }
        pid_ = static_cast<long>(child);
#endif
        stdoutReader_ = std::thread([this] { drain(stdoutRead_, stdout_, stdoutEof_); });
        stderrReader_ = std::thread([this] { drain(stderrRead_, stderr_, stderrEof_); });
    }

    ~PipedProcess() {
        try {
            kill();
        } catch (...) {
        }
        closeStdin();
        if (stdoutReader_.joinable()) {
            stdoutReader_.join();
        }
        if (stderrReader_.joinable()) {
            stderrReader_.join();
        }
        closeAll();
    }

    PipedProcess(const PipedProcess&) = delete;
    PipedProcess& operator=(const PipedProcess&) = delete;

    long pid() const noexcept { return pid_; }

    // The first stdout line without its "\n"; nullopt when stdout ends (or the
    // timeout passes) before a full line.
    std::optional<std::string> firstLine() {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, kTimeout, [this] { return stdout_.find('\n') != std::string::npos || stdoutEof_; });
        const std::size_t end = stdout_.find('\n');
        if (end == std::string::npos) {
            return std::nullopt;
        }
        return stdout_.substr(0, end);
    }

    // Closes the child's stdin (EOF on its side).
    void closeStdin() {
#if defined(_WIN32)
        if (stdin_ != nullptr) {
            CloseHandle(stdin_);
            stdin_ = nullptr;
        }
#else
        if (stdin_ >= 0) {
            ::close(stdin_);
            stdin_ = -1;
        }
#endif
    }

    // Waits until the child exits on its own; its exit code (-1 if it did not
    // exit normally).
    int wait() {
#if defined(_WIN32)
        if (process_ == nullptr) {
            return exitCode_;
        }
        WaitForSingleObject(process_, INFINITE);
        DWORD code = 0;
        exitCode_ = GetExitCodeProcess(process_, &code) ? static_cast<int>(code) : -1;
        CloseHandle(process_);
        process_ = nullptr;
#else
        if (reaped_ || pid_ <= 0) {
            return exitCode_;
        }
        int status = 0;
        while (waitpid(static_cast<pid_t>(pid_), &status, 0) < 0 && errno == EINTR) {
        }
        reaped_ = true;
        exitCode_ = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
#endif
        return exitCode_;
    }

    // Everything the child wrote to stdout / stderr, once the stream has ended
    // (call after wait()).
    std::string stdoutText() { return whole(stdout_, stdoutEof_); }
    std::string stderrText() { return whole(stderr_, stderrEof_); }

    // Hard-kills the child if it still runs and reaps it.
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
        if (reaped_ || pid_ <= 0) {
            return;
        }
        ::kill(static_cast<pid_t>(pid_), SIGKILL);
        int status = 0;
        while (waitpid(static_cast<pid_t>(pid_), &status, 0) < 0 && errno == EINTR) {
        }
        reaped_ = true;
#endif
    }

private:
#if defined(_WIN32)
    void drain(HANDLE pipe, std::string& sink, bool& eof) {
        char buffer[4096];
        DWORD got = 0;
        while (ReadFile(pipe, buffer, sizeof(buffer), &got, nullptr) && got > 0) {
            std::lock_guard lock(mutex_);
            sink.append(buffer, got);
            changed_.notify_all();
        }
        std::lock_guard lock(mutex_);
        eof = true;
        changed_.notify_all();
    }

    void closeAll() {
        closeStdin();
        for (HANDLE* h : {&stdoutRead_, &stderrRead_, &process_}) {
            if (*h != nullptr) {
                CloseHandle(*h);
                *h = nullptr;
            }
        }
    }

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
    HANDLE stdin_ = nullptr;
    HANDLE stdoutRead_ = nullptr;
    HANDLE stderrRead_ = nullptr;
#else
    void drain(int fd, std::string& sink, bool& eof) {
        char buffer[4096];
        for (;;) {
            const ssize_t got = ::read(fd, buffer, sizeof(buffer));
            if (got > 0) {
                std::lock_guard lock(mutex_);
                sink.append(buffer, static_cast<std::size_t>(got));
                changed_.notify_all();
                continue;
            }
            if (got < 0 && errno == EINTR) {
                continue;
            }
            break;
        }
        std::lock_guard lock(mutex_);
        eof = true;
        changed_.notify_all();
    }

    void closeAll() {
        closeStdin();
        for (int* fd : {&stdoutRead_, &stderrRead_}) {
            if (*fd >= 0) {
                ::close(*fd);
                *fd = -1;
            }
        }
    }

    int stdin_ = -1;
    int stdoutRead_ = -1;
    int stderrRead_ = -1;
    bool reaped_ = false;
#endif

    std::string whole(const std::string& sink, const bool& eof) {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, kTimeout, [&eof] { return eof; });
        return sink;
    }

    long pid_ = -1;
    int exitCode_ = -1;
    std::mutex mutex_;
    std::condition_variable changed_;
    std::string stdout_;
    std::string stderr_;
    bool stdoutEof_ = false;
    bool stderrEof_ = false;
    std::thread stdoutReader_;
    std::thread stderrReader_;
};

}  // namespace siann::engine_app::test
