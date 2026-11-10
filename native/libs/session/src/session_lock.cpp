#include "session_lock.hpp"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <ctime>
#include <exception>
#include <fstream>
#include <iterator>
#include <optional>
#include <sstream>
#include <string>
#include <system_error>
#include <utility>

#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/session/journal.hpp"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <climits>
#include <csignal>
#include <fcntl.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace siann::session::detail {

namespace fs = std::filesystem;

namespace {

constexpr const char* kLockFile = "lock";

std::int64_t currentPid() {
#if defined(_WIN32)
    return static_cast<std::int64_t>(GetCurrentProcessId());
#else
    return static_cast<std::int64_t>(getpid());
#endif
}

std::string utcNow() {
    const std::time_t t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buffer;
}

std::string lockText() {
    return jcs::canonicalize(json::Value(json::Object{{"pid", json::Value(static_cast<double>(currentPid()))},
                                                      {"startedAt", json::Value(utcNow())}})) +
           "\n";
}

[[noreturn]] void lockFailed(const fs::path& file, const std::string& why) {
    throw SessionError("lock_failed", "cannot create the session lock " + file.string() + ": " + why);
}

// Creates `file` exclusively with `text`: false when it already exists.
bool createExclusive(const fs::path& file, const std::string& text) {
#if defined(_WIN32)
    // No sharing while it is written: a reader meanwhile cannot open it and
    // treats the bundle as held.
    HANDLE handle = CreateFileW(file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        const DWORD error = GetLastError();
        if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS) {
            return false;
        }
        lockFailed(file, std::system_category().message(static_cast<int>(error)));
    }
    DWORD written = 0;
    const BOOL ok = WriteFile(handle, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
    CloseHandle(handle);
    if (!ok || written != text.size()) {
        std::error_code ignored;
        fs::remove(file, ignored);
        lockFailed(file, "the write failed");
    }
    return true;
#else
    const int fd = ::open(file.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    if (fd < 0) {
        if (errno == EEXIST) {
            return false;
        }
        lockFailed(file, std::generic_category().message(errno));
    }
    std::size_t done = 0;
    while (done < text.size()) {
        const ssize_t n = ::write(fd, text.data() + done, text.size() - done);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            ::close(fd);
            std::error_code ignored;
            fs::remove(file, ignored);
            lockFailed(file, "the write failed");
        }
        done += static_cast<std::size_t>(n);
    }
    ::close(fd);
    return true;
#endif
}

// The file's bytes, or nothing when it cannot be opened (gone, or being written).
std::optional<std::string> readLock(const fs::path& file) {
    std::ifstream in(file, std::ios::binary);
    if (!in) {
        return std::nullopt;
    }
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

// The pid a lock names, or nothing when it names none a process could have.
std::optional<std::int64_t> pidOf(const std::string& text) {
    try {
        const json::Value lock = json::parse(text);
        if (lock.kind() != json::Value::Kind::object) {
            return std::nullopt;
        }
        const json::Value* pid = lock.find("pid");
        if (pid == nullptr || pid->kind() != json::Value::Kind::number) {
            return std::nullopt;
        }
        const double value = pid->asNumber();
#if defined(_WIN32)
        constexpr double kMaxPid = 4'294'967'295.0;
#else
        constexpr double kMaxPid = static_cast<double>(INT_MAX);
#endif
        if (!(value >= 1.0 && value <= kMaxPid) || std::floor(value) != value) {
            return std::nullopt;
        }
        return static_cast<std::int64_t>(value);
    } catch (const std::exception&) {
        return std::nullopt;
    }
}

bool processAlive(std::int64_t pid) {
#if defined(_WIN32)
    const auto id = static_cast<DWORD>(pid);
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, id);
    if (process == nullptr) {
        // Denied: it exists. Otherwise (ERROR_INVALID_PARAMETER) no such process.
        return GetLastError() == ERROR_ACCESS_DENIED;
    }
    DWORD exitCode = 0;
    // The kernel ignores a pid's low two bits: the handle must be this pid's.
    const bool alive = GetExitCodeProcess(process, &exitCode) && exitCode == STILL_ACTIVE && GetProcessId(process) == id;
    CloseHandle(process);
    return alive;
#else
    if (::kill(static_cast<pid_t>(pid), 0) == 0) {
        return true;
    }
    return errno != ESRCH;  // EPERM: it exists, another user's
#endif
}

[[noreturn]] void locked(const fs::path& bundle, const std::string& holder) {
    throw SessionError("session_locked", "the session bundle " + bundle.string() + " is in use by " + holder +
                                             " (its lock file names a live process)");
}

}  // namespace

BundleLock::BundleLock(const fs::path& bundle) {
    const fs::path file = bundle / kLockFile;
    const std::string text = lockText();
    for (int attempt = 0; attempt < 2; ++attempt) {
        if (createExclusive(file, text)) {
            file_ = file;
            return;
        }
        const std::optional<std::string> held = readLock(file);
        if (!held) {
            std::error_code ec;
            if (fs::exists(file, ec)) {
                locked(bundle, "a process that is writing its lock");
            }
            continue;  // released meanwhile
        }
        const std::optional<std::int64_t> pid = pidOf(*held);
        if (pid && processAlive(*pid)) {
            locked(bundle, "process " + std::to_string(*pid));
        }
        // A crashed holder's lock, or one no process wrote completely: take it over.
        std::error_code ec;
        fs::remove(file, ec);
    }
    locked(bundle, "another process");
}

BundleLock::~BundleLock() {
    if (!file_.empty()) {
        std::error_code ignored;
        fs::remove(file_, ignored);
    }
}

BundleLock::BundleLock(BundleLock&& other) noexcept : file_(std::move(other.file_)) {
    other.file_.clear();
}

}  // namespace siann::session::detail
