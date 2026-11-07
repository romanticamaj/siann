#pragma once

// A child process that a test can hard-kill: TerminateProcess on Windows,
// SIGKILL on POSIX. Nothing in the child runs after the kill, as after a
// crash or a power cut of the engine process. A test can also wait for it to
// exit, read its exit code or the signal that ended it, and read what it printed
// (stdout redirected to a file).

#include <filesystem>
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
#include <fcntl.h>
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
    // Starts `executable` with `args` (UTF-8, without the program name). With
    // `stdoutFile`, the child's stdout goes to that file (created or truncated).
    ChildProcess(const std::string& executable, const std::vector<std::string>& args,
                 const std::filesystem::path& stdoutFile = {}) {
#if defined(_WIN32)
        std::wstring commandLine = quote(widen(executable));
        for (const std::string& arg : args) {
            commandLine += L' ';
            commandLine += quote(widen(arg));
        }
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        HANDLE out = INVALID_HANDLE_VALUE;
        if (!stdoutFile.empty()) {
            SECURITY_ATTRIBUTES inherit{};
            inherit.nLength = sizeof(inherit);
            inherit.bInheritHandle = TRUE;
            out = CreateFileW(stdoutFile.c_str(), GENERIC_WRITE, FILE_SHARE_READ, &inherit, CREATE_ALWAYS,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
            if (out == INVALID_HANDLE_VALUE) {
                throw std::runtime_error("cannot create the child's stdout file: " + std::to_string(GetLastError()));
            }
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.hStdOutput = out;
            startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        }
        PROCESS_INFORMATION info{};
        const std::wstring exe = widen(executable);
        const BOOL created = CreateProcessW(exe.c_str(), commandLine.data(), nullptr, nullptr,
                                            out != INVALID_HANDLE_VALUE ? TRUE : FALSE, 0, nullptr, nullptr, &startup,
                                            &info);
        const DWORD error = GetLastError();
        if (out != INVALID_HANDLE_VALUE) {
            CloseHandle(out);  // the child holds its own copy
        }
        if (!created) {
            throw std::runtime_error("CreateProcessW failed: " + std::to_string(error));
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
        posix_spawn_file_actions_t actions;
        posix_spawn_file_actions_init(&actions);
        const std::string out = stdoutFile.string();
        if (!out.empty()) {
            posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, out.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
        }
        const int rc = posix_spawn(&pid_, executable.c_str(), &actions, nullptr, argv.data(), environ);
        posix_spawn_file_actions_destroy(&actions);
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
            record(status);
            return false;
        }
        return true;
#endif
    }

    // Waits until the child exits on its own and returns its exit code (-1 if
    // it did not exit normally).
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
        return exitCode_;
#else
        if (pid_ <= 0 || reaped_) {
            return exitCode_;
        }
        int status = 0;
        while (waitpid(pid_, &status, 0) < 0 && errno == EINTR) {
        }
        reaped_ = true;
        record(status);
        return exitCode_;
#endif
    }

    // The signal that ended the child, once wait() or running() saw it exit; 0 when
    // it exited normally, and always 0 on Windows (an abort there is exit code 3).
    int terminatingSignal() const { return terminatingSignal_; }

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
    void record(int status) {
        exitCode_ = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        terminatingSignal_ = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
    }

    pid_t pid_ = -1;
    bool reaped_ = false;
#endif
    int exitCode_ = -1;
    int terminatingSignal_ = 0;
};

}  // namespace siann::cli::test
