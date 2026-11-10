#pragma once

// <bundle>/lock (architecture spec, "Session bundle", lock): held exclusively
// while a Session is open on the bundle. Acquiring creates the file with
// O_CREAT | O_EXCL (CREATE_NEW on Windows) and writes {pid, startedAt}; a file
// that already exists is read, and taken over (removed, the create tried once
// more) when it cannot be parsed or names a pid that is not a live process.
// Otherwise acquiring throws SessionError("session_locked"). The destructor
// removes the file; a moved-from lock removes nothing.

#include <filesystem>

namespace siann::session::detail {

class BundleLock {
public:
    // Throws SessionError session_locked, or io_error when the file cannot be
    // created or written.
    explicit BundleLock(const std::filesystem::path& bundle);
    ~BundleLock();
    BundleLock(BundleLock&& other) noexcept;
    BundleLock& operator=(BundleLock&&) = delete;
    BundleLock(const BundleLock&) = delete;
    BundleLock& operator=(const BundleLock&) = delete;

private:
    std::filesystem::path file_;  // empty once released or moved from
};

}  // namespace siann::session::detail
