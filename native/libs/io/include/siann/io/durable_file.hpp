#pragma once

// Durable file primitives (architecture spec, "Journal as write-ahead log").
// Non-realtime code only. Every function either completes durably or throws
// IoError; a throw leaves earlier durable content intact.

#include <filesystem>
#include <stdexcept>
#include <string>
#include <string_view>

namespace siann::io {

class IoError : public std::runtime_error {
public:
    IoError(const std::filesystem::path& path, const std::string& message);
    const std::filesystem::path& path() const noexcept { return path_; }

private:
    std::filesystem::path path_;
};

// Whole file as bytes.
std::string readFile(const std::filesystem::path& path);

// Appends bytes and flushes them to stable storage before returning. Creates
// the file if it does not exist (and flushes its directory on POSIX).
void appendDurable(const std::filesystem::path& path, std::string_view data);

// Replaces a file atomically: writes "<name>.tmp" in the same directory,
// flushes it, renames it over the target (ReplaceFileW / MoveFileExW with
// write-through on Windows, rename plus a directory flush on POSIX).
void writeFileAtomic(const std::filesystem::path& path, std::string_view data);

// Suffix used for the temporary file of writeFileAtomic.
inline constexpr std::string_view kTempSuffix = ".tmp";

// Flushes a directory entry table on POSIX; no-op on Windows, where metadata
// updates of MoveFileExW with MOVEFILE_WRITE_THROUGH are already durable.
void flushDirectory(const std::filesystem::path& directory);

// Creates a directory and its parents, flushing each new entry's parent.
void createDirectoriesDurable(const std::filesystem::path& directory);

}  // namespace siann::io
