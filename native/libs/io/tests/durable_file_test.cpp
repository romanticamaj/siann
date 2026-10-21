#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <random>
#include <string>

#include "siann/io/durable_file.hpp"

namespace fs = std::filesystem;
using siann::io::IoError;
using siann::io::appendDurable;
using siann::io::createDirectoriesDurable;
using siann::io::readFile;
using siann::io::writeFileAtomic;

namespace {

// A fresh directory under the system temp directory, removed at scope exit.
class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-io-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    const fs::path& path() const { return path_; }

private:
    fs::path path_;
};

}  // namespace

TEST_CASE("appendDurable creates and appends", "[io]") {
    TempDir dir;
    const fs::path file = dir.path() / "journal.ndjson";
    appendDurable(file, "one\n");
    appendDurable(file, "two\n");
    CHECK(readFile(file) == "one\ntwo\n");
}

TEST_CASE("writeFileAtomic replaces content and leaves no temp file", "[io]") {
    TempDir dir;
    const fs::path file = dir.path() / "session.json";
    writeFileAtomic(file, "first");
    writeFileAtomic(file, "second, longer content");
    CHECK(readFile(file) == "second, longer content");
    CHECK_FALSE(fs::exists(dir.path() / "session.json.tmp"));
}

TEST_CASE("Binary content round-trips unchanged", "[io]") {
    TempDir dir;
    const fs::path file = dir.path() / "blob";
    std::string bytes;
    for (int i = 0; i < 256; ++i) {
        bytes.push_back(static_cast<char>(i));
    }
    bytes += "\r\n\n\r";
    writeFileAtomic(file, bytes);
    CHECK(readFile(file) == bytes);
}

TEST_CASE("Paths with non-ASCII characters work", "[io]") {
    TempDir dir;
    const fs::path file = dir.path() / fs::path(u8"聲 song.siann") / "session.json";
    createDirectoriesDurable(file.parent_path());
    writeFileAtomic(file, "ok");
    appendDurable(file.parent_path() / "journal.ndjson", "x\n");
    CHECK(readFile(file) == "ok");
}

TEST_CASE("Reading a missing file throws IoError", "[io]") {
    TempDir dir;
    CHECK_THROWS_AS(readFile(dir.path() / "missing"), IoError);
}

TEST_CASE("createDirectoriesDurable creates nested directories", "[io]") {
    TempDir dir;
    const fs::path nested = dir.path() / "a" / "b" / "c";
    createDirectoriesDurable(nested);
    CHECK(fs::is_directory(nested));
    CHECK_NOTHROW(createDirectoriesDurable(nested));
}
