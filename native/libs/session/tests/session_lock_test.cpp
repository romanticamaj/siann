// The session bundle lock (architecture spec, "Session bundle", lock;
// m5-engine-sessions-devices): Session::create and Session::open hold
// <bundle>/lock exclusively with {pid, startedAt}, release it when destroyed,
// and take over a lock whose pid is dead or that cannot be read.

#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <optional>
#include <random>
#include <string>
#include <utility>

#include "siann/hash/json.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/model/document.hpp"
#include "siann/session/session.hpp"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace fs = std::filesystem;
using siann::model::Document;
using siann::session::Session;
using siann::session::SessionError;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-lock-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    fs::path bundle() const { return path_ / "Song.siann"; }

private:
    fs::path path_;
};

std::int64_t thisPid() {
#if defined(_WIN32)
    return static_cast<std::int64_t>(GetCurrentProcessId());
#else
    return static_cast<std::int64_t>(getpid());
#endif
}

// A pid no process can have. Windows pids are multiples of 4 (an odd one names
// none); a POSIX pid above pid_max never exists.
std::int64_t deadPid() {
#if defined(_WIN32)
    return 1'000'001;
#else
    std::int64_t pidMax = std::int64_t{1} << 22;
    std::ifstream file("/proc/sys/kernel/pid_max");
    std::int64_t read = 0;
    if (file >> read && read > 0) {
        pidMax = read;
    }
    return pidMax + 1;
#endif
}

Session newSession(const fs::path& bundle) {
    return Session::create(bundle, Document::create("Song", 48'000, 120'000), "test", "2026-11-09T00:00:00Z");
}

fs::path lockOf(const fs::path& bundle) {
    return bundle / "lock";
}

void writeLock(const fs::path& bundle, const std::string& text) {
    std::ofstream file(lockOf(bundle), std::ios::binary | std::ios::trunc);
    file << text;
}

std::string codeOf(const fs::path& bundle) {
    try {
        Session second = Session::open(bundle);
    } catch (const SessionError& error) {
        return error.code();
    }
    return "";
}

}  // namespace

TEST_CASE("Session::create holds the bundle's lock with this process's pid", "[session][lock]") {
    TempDir dir;
    const Session session = newSession(dir.bundle());
    REQUIRE(fs::exists(lockOf(dir.bundle())));
    const siann::json::Value lock = siann::json::parse(siann::io::readFile(lockOf(dir.bundle())));
    const siann::json::Value* pid = lock.find("pid");
    REQUIRE(pid != nullptr);
    REQUIRE(pid->kind() == siann::json::Value::Kind::number);
    CHECK(static_cast<std::int64_t>(pid->asNumber()) == thisPid());
    const siann::json::Value* startedAt = lock.find("startedAt");
    REQUIRE(startedAt != nullptr);
    REQUIRE(startedAt->kind() == siann::json::Value::Kind::string);
    CHECK(startedAt->asString().size() >= 20);  // 2026-11-09T00:00:00Z
    CHECK(startedAt->asString().back() == 'Z');
}

TEST_CASE("A second open of a locked bundle is session_locked", "[session][lock]") {
    TempDir dir;
    const Session first = newSession(dir.bundle());
    CHECK(codeOf(dir.bundle()) == "session_locked");
    // The first session's lock survives the refused open.
    CHECK(fs::exists(lockOf(dir.bundle())));
    CHECK(codeOf(dir.bundle()) == "session_locked");
}

TEST_CASE("Destroying the session releases the lock", "[session][lock]") {
    TempDir dir;
    {
        const Session first = newSession(dir.bundle());
    }
    CHECK_FALSE(fs::exists(lockOf(dir.bundle())));
    {
        const Session reopened = Session::open(dir.bundle());
        CHECK(fs::exists(lockOf(dir.bundle())));
        CHECK(codeOf(dir.bundle()) == "session_locked");
    }
    CHECK_FALSE(fs::exists(lockOf(dir.bundle())));
    CHECK(codeOf(dir.bundle()).empty());
}

TEST_CASE("A lock whose pid is dead is taken over", "[session][lock]") {
    TempDir dir;
    {
        const Session first = newSession(dir.bundle());
    }
    writeLock(dir.bundle(),
              R"({"pid":)" + std::to_string(deadPid()) + R"(,"startedAt":"2026-01-01T00:00:00Z"})");
    const Session reopened = Session::open(dir.bundle());
    const siann::json::Value lock = siann::json::parse(siann::io::readFile(lockOf(dir.bundle())));
    REQUIRE(lock.find("pid") != nullptr);
    CHECK(static_cast<std::int64_t>(lock.find("pid")->asNumber()) == thisPid());
    CHECK(codeOf(dir.bundle()) == "session_locked");
}

TEST_CASE("An empty or unparseable lock is taken over", "[session][lock]") {
    TempDir dir;
    {
        const Session first = newSession(dir.bundle());
    }
    for (const std::string text : {std::string(), std::string("{\"pid\":"), std::string("[]"),
                                   std::string(R"({"pid":"12"})"), std::string(R"({"pid":0})"),
                                   std::string(R"({"pid":-4})")}) {
        INFO("lock text: " << text);
        writeLock(dir.bundle(), text);
        {
            const Session reopened = Session::open(dir.bundle());
            const siann::json::Value lock = siann::json::parse(siann::io::readFile(lockOf(dir.bundle())));
            REQUIRE(lock.find("pid") != nullptr);
            CHECK(static_cast<std::int64_t>(lock.find("pid")->asNumber()) == thisPid());
        }
        CHECK_FALSE(fs::exists(lockOf(dir.bundle())));
    }
}

TEST_CASE("A lock naming this live process is held", "[session][lock]") {
    TempDir dir;
    {
        const Session first = newSession(dir.bundle());
    }
    writeLock(dir.bundle(), R"({"pid":)" + std::to_string(thisPid()) + R"(,"startedAt":"2026-01-01T00:00:00Z"})");
    CHECK(codeOf(dir.bundle()) == "session_locked");
    // A refused open leaves another holder's lock in place.
    CHECK(fs::exists(lockOf(dir.bundle())));
}

TEST_CASE("A moved-from session keeps no lock; the moved-to one releases it", "[session][lock]") {
    TempDir dir;
    std::optional<Session> target;
    {
        Session source = newSession(dir.bundle());
        target.emplace(std::move(source));
    }
    // The moved-from session's destructor did not release the lock.
    CHECK(fs::exists(lockOf(dir.bundle())));
    CHECK(codeOf(dir.bundle()) == "session_locked");
    target.reset();
    CHECK_FALSE(fs::exists(lockOf(dir.bundle())));

    // Move assignment releases the replaced session's lock.
    TempDir other;
    Session a = Session::open(dir.bundle());
    Session b = newSession(other.bundle());
    a = std::move(b);
    CHECK_FALSE(fs::exists(lockOf(dir.bundle())));
    CHECK(fs::exists(lockOf(other.bundle())));
    CHECK(a.bundlePath() == other.bundle());
}
