// m5-ui-engine-loop-click: the locators entity through the bundle (journal,
// checkpoint, document format v2 and its v1 migration) and the cycle flag kept
// in the checkpoint.

#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <random>
#include <string>
#include <utility>

#include "siann/hash/jcs.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/session/session.hpp"

namespace fs = std::filesystem;
using siann::command::Command;
using siann::json::Object;
using siann::json::Value;
using siann::model::DiffEntry;
using siann::model::Document;
using siann::model::EntityRef;
using siann::model::EntityType;
using siann::model::Locators;
using siann::session::OpenReport;
using siann::session::Session;
using siann::session::scanJournal;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-locators-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

Command cmd(const std::string& json) {
    return Command::fromJson(siann::json::parse(json));
}

Command setLocators(const std::string& left, const std::string& right) {
    return cmd(R"({"op":"session.set_locators","left":")" + left + R"(","right":")" + right + R"("})");
}

Command addTrack(const std::string& id) {
    return cmd(R"({"op":"track.add","trackId":")" + id + R"(","name":")" + id + R"(","channels":2})");
}

Session newSession(const fs::path& bundle) {
    return Session::create(bundle, Document::create("Song", 48'000), "tester", "2026-11-13T00:00:00Z");
}

void closeSession(Session& session) {
    const Session closing = std::move(session);
}

bool contains(const std::string& text, const std::string& part) {
    return text.find(part) != std::string::npos;
}

// Rewrites every "siann.session_document.v2" in a JCS text as v1, and the
// journal line's checksum to match: the bundle an M1 to M5 engine wrote.
std::string asV1(const std::string& text) {
    std::string out = text;
    const std::string from = "siann.session_document.v2";
    for (auto pos = out.find(from); pos != std::string::npos; pos = out.find(from, pos)) {
        out.replace(pos, from.size(), "siann.session_document.v1");
    }
    return out;
}

std::string journalAsV1(const std::string& journal) {
    std::string out;
    std::size_t pos = 0;
    while (pos < journal.size()) {
        const std::size_t end = journal.find('\n', pos);
        const Value line = siann::json::parse(asV1(journal.substr(pos, end - pos)));
        Object body;
        for (const auto& member : line.asObject()) {
            if (member.first != "checksum") {
                body.push_back(member);
            }
        }
        Object members = body;
        members.emplace_back("checksum", Value(siann::jcs::sha256Jcs(Value(std::move(body)))));
        out += siann::jcs::canonicalize(Value(std::move(members))) + "\n";
        pos = end + 1;
    }
    return out;
}

}  // namespace

TEST_CASE("Locators survive a checkpoint and a reopen", "[session][locators]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.commit({setLocators("96000", "480000")}, "a", "t1");
        session.checkpoint();
    }
    OpenReport report;
    const Session reopened = Session::open(dir.bundle(), &report);
    CHECK(report.checkpointVerified);
    const Locators* value = reopened.history().head().document.locators();
    REQUIRE(value != nullptr);
    CHECK(*value == Locators{96'000, 480'000});
    const Value checkpoint = siann::json::parse(siann::io::readFile(dir.bundle() / "session.json"));
    CHECK(checkpoint.find("document")->find("schemaVersion")->asString() == "siann.session_document.v2");
    CHECK(checkpoint.find("document")->find("locators") != nullptr);
}

TEST_CASE("Journal replay alone restores the locators", "[session][locators]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.commit({setLocators("10", "20")}, "a", "t1");
        session.commit({setLocators("30", "40")}, "a", "t2");
        session.undo("a", "t3");
    }
    fs::remove(dir.bundle() / "session.json");
    OpenReport report;
    const Session reopened = Session::open(dir.bundle(), &report);
    CHECK_FALSE(report.checkpointVerified);
    CHECK(report.recordsReplayed == 4);
    const Locators* value = reopened.history().head().document.locators();
    REQUIRE(value != nullptr);
    CHECK(*value == Locators{10, 20});
}

TEST_CASE("The journal record of a locators revision names locators:locators", "[session][locators][journal]") {
    TempDir dir;
    Session session = newSession(dir.bundle());
    session.commit({setLocators("96000", "480000")}, "a", "t1");
    const auto scan = scanJournal(siann::io::readFile(dir.bundle() / "journal.ndjson"));
    REQUIRE(scan.records.size() == 2);
    REQUIRE(scan.records[1].diff.size() == 1);
    CHECK(scan.records[1].diff[0].entity == EntityRef{EntityType::locators, "locators"});
    CHECK(scan.records[1].diff[0].change == DiffEntry::Change::added);
    CHECK(contains(siann::io::readFile(dir.bundle() / "journal.ndjson"),
                   R"({"change":"added","id":"locators","type":"locators"})"));
}

TEST_CASE("A v1 bundle opens with no locators, takes set_locators and is written as v2", "[session][locators][migration]") {
    TempDir dir;
    std::string journal;
    std::string checkpoint;
    {
        Session session = newSession(dir.bundle());
        session.commit({addTrack("trk_1")}, "a", "t1");
        session.checkpoint();
        journal = siann::io::readFile(dir.bundle() / "journal.ndjson");
        checkpoint = siann::io::readFile(dir.bundle() / "session.json");
    }
    // The same bundle as an M1 to M5 engine wrote it: v1 documents only.
    siann::io::writeFileAtomic(dir.bundle() / "journal.ndjson", journalAsV1(journal));
    siann::io::writeFileAtomic(dir.bundle() / "session.json", asV1(checkpoint));
    REQUIRE(contains(siann::io::readFile(dir.bundle() / "journal.ndjson"), "siann.session_document.v1"));
    REQUIRE_FALSE(contains(siann::io::readFile(dir.bundle() / "journal.ndjson"), "siann.session_document.v2"));
    REQUIRE(contains(siann::io::readFile(dir.bundle() / "session.json"), "siann.session_document.v1"));
    REQUIRE_FALSE(contains(siann::io::readFile(dir.bundle() / "session.json"), "siann.session_document.v2"));

    {
        OpenReport report;
        Session session = Session::open(dir.bundle(), &report);
        CHECK(report.checkpointVerified);
        CHECK(report.recordsReplayed == 2);
        CHECK(session.history().head().document.locators() == nullptr);
        CHECK_FALSE(session.cycle());
        session.commit({setLocators("1000", "2000")}, "a", "t2");
        session.checkpoint();
        const std::string written = siann::io::readFile(dir.bundle() / "session.json");
        CHECK(contains(written, "siann.session_document.v2"));
        CHECK_FALSE(contains(written, "siann.session_document.v1"));
        // The journal is append-only: its v1 records stay as they were.
        CHECK(contains(siann::io::readFile(dir.bundle() / "journal.ndjson"), "siann.session_document.v1"));
    }
    OpenReport report;
    const Session reopened = Session::open(dir.bundle(), &report);
    CHECK(report.checkpointVerified);
    const Locators* value = reopened.history().head().document.locators();
    REQUIRE(value != nullptr);
    CHECK(*value == Locators{1'000, 2'000});
}

TEST_CASE("The cycle flag is kept in the checkpoint and comes back on reopen", "[session][cycle]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        CHECK_FALSE(session.cycle());
        session.setCycle(true);
        CHECK(session.cycle());
        session.checkpoint();
    }
    const Value checkpoint = siann::json::parse(siann::io::readFile(dir.bundle() / "session.json"));
    CHECK(checkpoint.find("schemaVersion")->asString() == "siann.checkpoint.v1");
    REQUIRE(checkpoint.find("transport") != nullptr);
    CHECK(checkpoint.find("transport")->find("cycle")->asBool());
    {
        Session session = Session::open(dir.bundle());
        CHECK(session.cycle());
        // A toggle alone writes nothing: the checkpoint still says true.
        session.setCycle(false);
        closeSession(session);
    }
    {
        Session session = Session::open(dir.bundle());
        CHECK(session.cycle());
        session.setCycle(false);
        session.checkpoint();
    }
    CHECK_FALSE(Session::open(dir.bundle()).cycle());
}

TEST_CASE("A checkpoint without the transport field means cycle off", "[session][cycle]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.setCycle(true);
        session.checkpoint();
    }
    // An older engine's checkpoint has no transport field.
    Value checkpoint = siann::json::parse(siann::io::readFile(dir.bundle() / "session.json"));
    Object members;
    for (const auto& member : checkpoint.asObject()) {
        if (member.first != "transport") {
            members.push_back(member);
        }
    }
    siann::io::writeFileAtomic(dir.bundle() / "session.json", siann::jcs::canonicalize(Value(std::move(members))) + "\n");
    OpenReport report;
    const Session reopened = Session::open(dir.bundle(), &report);
    CHECK(report.checkpointVerified);
    CHECK_FALSE(reopened.cycle());
}
