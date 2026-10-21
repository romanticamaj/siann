#include "siann/io/durable_file.hpp"

#include <algorithm>
#include <fstream>
#include <sstream>
#include <system_error>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <unistd.h>
#endif

namespace siann::io {

namespace fs = std::filesystem;

IoError::IoError(const fs::path& path, const std::string& message)
    : std::runtime_error(message + ": " + path.string()), path_(path) {}

namespace {

#if defined(_WIN32)

std::string lastErrorText() {
    return "Windows error " + std::to_string(GetLastError());
}

class Handle {
public:
    explicit Handle(HANDLE h) : h_(h) {}
    ~Handle() {
        if (h_ != INVALID_HANDLE_VALUE) {
            CloseHandle(h_);
        }
    }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    HANDLE get() const noexcept { return h_; }

private:
    HANDLE h_;
};

void writeAll(HANDLE h, std::string_view data, const fs::path& path) {
    std::size_t offset = 0;
    while (offset < data.size()) {
        const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(data.size() - offset, 1u << 30));
        DWORD written = 0;
        if (!WriteFile(h, data.data() + offset, chunk, &written, nullptr)) {
            throw IoError(path, "write failed (" + lastErrorText() + ")");
        }
        offset += written;
    }
}

void writeAndFlush(const fs::path& path, std::string_view data, DWORD access, DWORD disposition) {
    Handle h(CreateFileW(path.c_str(), access, FILE_SHARE_READ, nullptr, disposition, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (h.get() == INVALID_HANDLE_VALUE) {
        throw IoError(path, "open failed (" + lastErrorText() + ")");
    }
    writeAll(h.get(), data, path);
    if (!FlushFileBuffers(h.get())) {
        throw IoError(path, "flush failed (" + lastErrorText() + ")");
    }
}

#else

std::string lastErrorText() {
    return std::strerror(errno);
}

class Fd {
public:
    explicit Fd(int fd) : fd_(fd) {}
    ~Fd() {
        if (fd_ >= 0) {
            ::close(fd_);
        }
    }
    Fd(const Fd&) = delete;
    Fd& operator=(const Fd&) = delete;
    int get() const noexcept { return fd_; }

private:
    int fd_;
};

void writeAll(int fd, std::string_view data, const fs::path& path) {
    std::size_t offset = 0;
    while (offset < data.size()) {
        const ssize_t written = ::write(fd, data.data() + offset, data.size() - offset);
        if (written < 0) {
            if (errno == EINTR) {
                continue;
            }
            throw IoError(path, "write failed (" + lastErrorText() + ")");
        }
        offset += static_cast<std::size_t>(written);
    }
}

void syncFd(int fd, const fs::path& path) {
#if defined(__APPLE__)
    // fsync on macOS does not flush the drive cache; F_FULLFSYNC does.
    if (::fcntl(fd, F_FULLFSYNC) == 0) {
        return;
    }
#endif
    if (::fsync(fd) != 0) {
        throw IoError(path, "fsync failed (" + lastErrorText() + ")");
    }
}

#endif

}  // namespace

std::string readFile(const fs::path& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        throw IoError(path, "cannot open for reading");
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    if (in.bad()) {
        throw IoError(path, "read failed");
    }
    return buffer.str();
}

void flushDirectory(const fs::path& directory) {
#if defined(_WIN32)
    (void)directory;
#else
    Fd fd(::open(directory.c_str(), O_RDONLY | O_DIRECTORY));
    if (fd.get() < 0) {
        throw IoError(directory, "cannot open directory (" + lastErrorText() + ")");
    }
    syncFd(fd.get(), directory);
#endif
}

void appendDurable(const fs::path& path, std::string_view data) {
    const bool existed = fs::exists(path);
#if defined(_WIN32)
    writeAndFlush(path, data, FILE_APPEND_DATA, OPEN_ALWAYS);
#else
    Fd fd(::open(path.c_str(), O_WRONLY | O_APPEND | O_CREAT, 0644));
    if (fd.get() < 0) {
        throw IoError(path, "open failed (" + lastErrorText() + ")");
    }
    writeAll(fd.get(), data, path);
    syncFd(fd.get(), path);
#endif
    if (!existed) {
        flushDirectory(path.parent_path());
    }
}

void writeFileAtomic(const fs::path& path, std::string_view data) {
    fs::path temp = path;
    temp += std::string(kTempSuffix);
#if defined(_WIN32)
    writeAndFlush(temp, data, GENERIC_WRITE, CREATE_ALWAYS);
    if (!MoveFileExW(temp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        throw IoError(path, "replace failed (" + lastErrorText() + ")");
    }
#else
    {
        Fd fd(::open(temp.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644));
        if (fd.get() < 0) {
            throw IoError(temp, "open failed (" + lastErrorText() + ")");
        }
        writeAll(fd.get(), data, temp);
        syncFd(fd.get(), temp);
    }
    if (::rename(temp.c_str(), path.c_str()) != 0) {
        throw IoError(path, "rename failed (" + lastErrorText() + ")");
    }
    flushDirectory(path.parent_path());
#endif
}

void createDirectoriesDurable(const fs::path& directory) {
    if (fs::exists(directory)) {
        return;
    }
    const fs::path parent = directory.parent_path();
    if (!parent.empty() && parent != directory) {
        createDirectoriesDurable(parent);
    }
    std::error_code ec;
    fs::create_directory(directory, ec);
    if (ec) {
        throw IoError(directory, "cannot create directory (" + ec.message() + ")");
    }
    if (!parent.empty()) {
        flushDirectory(parent);
    }
}

}  // namespace siann::io
