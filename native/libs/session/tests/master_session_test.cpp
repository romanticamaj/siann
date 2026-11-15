// m5b-engine-master: the master entity through the bundle (journal, checkpoint and
// replay), and a bundle whose master went back to 0 dB.

#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <random>
#include <string>
#include <utility>
#include <vector>

#include "siann/io/durable_file.hpp"
#include "siann/session/session.hpp"

namespace fs = std::filesystem;
using siann::command::Command;
using siann::json::Value;
using siann::model::DiffEntry;
using siann::model::Document;
using siann::model::EntityRef;
using siann::model::EntityType;
using siann::session::OpenReport;
using siann::session::Session;
using siann::session::scanJournal;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-master-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

Command setMaster(int milliDb) {
    return cmd(R"({"op":"master.set_gain","gainMilliDb":)" + std::to_string(milliDb) + "}");
}

Command addTrack(const std::string& id) {
    return cmd(R"({"op":"track.add","trackId":")" + id + R"(","name":")" + id + R"(","channels":2})");
}

Session newSession(const fs::path& bundle) {
    return Session::create(bundle, Document::create("Song", 48'000), "tester", "2026-11-15T00:00:00Z");
}

bool contains(const std::string& text, const std::string& part) {
    return text.find(part) != std::string::npos;
}

const EntityRef kMaster{EntityType::master, "master"};

}  // namespace

TEST_CASE("The master survives a checkpoint and a reopen", "[session][master]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.commit({setMaster(-6000)}, "a", "t1");
        session.checkpoint();
    }
    OpenReport report;
    const Session reopened = Session::open(dir.bundle(), &report);
    CHECK(report.checkpointVerified);
    const auto* value = reopened.history().head().document.master();
    REQUIRE(value != nullptr);
    CHECK(value->gain.milliDb == -6000);
    const Value checkpoint = siann::json::parse(siann::io::readFile(dir.bundle() / "session.json"));
    CHECK(checkpoint.find("document")->find("schemaVersion")->asString() == "siann.session_document.v2");
    REQUIRE(checkpoint.find("document")->find("master") != nullptr);
    CHECK(checkpoint.find("document")->find("master")->find("gainMilliDb")->asNumber() == -6000);
}

TEST_CASE("Journal replay alone restores the master", "[session][master]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.commit({setMaster(-6000)}, "a", "t1");
        session.commit({setMaster(-2000)}, "a", "t2");
        session.undo("a", "t3");
    }
    fs::remove(dir.bundle() / "session.json");
    OpenReport report;
    const Session reopened = Session::open(dir.bundle(), &report);
    CHECK_FALSE(report.checkpointVerified);
    CHECK(report.recordsReplayed == 4);
    const auto* value = reopened.history().head().document.master();
    REQUIRE(value != nullptr);
    CHECK(value->gain.milliDb == -6000);
}

TEST_CASE("The journal record of a master revision names master:master", "[session][master][journal]") {
    TempDir dir;
    Session session = newSession(dir.bundle());
    session.commit({setMaster(-6000)}, "a", "t1");
    session.commit({setMaster(0)}, "a", "t2");
    const std::string journal = siann::io::readFile(dir.bundle() / "journal.ndjson");
    const auto scan = scanJournal(journal);
    REQUIRE(scan.records.size() == 3);
    REQUIRE(scan.records[1].diff.size() == 1);
    CHECK(scan.records[1].diff[0].entity == kMaster);
    CHECK(scan.records[1].diff[0].change == DiffEntry::Change::added);
    REQUIRE(scan.records[2].diff.size() == 1);
    CHECK(scan.records[2].diff[0].entity == kMaster);
    CHECK(scan.records[2].diff[0].change == DiffEntry::Change::removed);
    CHECK(contains(journal, R"({"change":"added","id":"master","type":"master"})"));
    CHECK(contains(journal, R"({"change":"removed","id":"master","type":"master"})"));
}

TEST_CASE("A bundle after a set and a set back to 0 dB reopens with the recorded hashes", "[session][master]") {
    TempDir dir;
    std::vector<siann::hash::Digest> hashes;
    {
        Session session = newSession(dir.bundle());
        hashes.push_back(session.history().head().envelope.documentHash);
        session.commit({addTrack("trk_1")}, "a", "t1");
        hashes.push_back(session.history().head().envelope.documentHash);
        session.commit({setMaster(-6000)}, "a", "t2");
        hashes.push_back(session.history().head().envelope.documentHash);
        session.checkpoint();
        session.commit({setMaster(0)}, "a", "t3");
        hashes.push_back(session.history().head().envelope.documentHash);
    }
    CHECK(hashes[3] == hashes[1]);
    CHECK(hashes[2] != hashes[1]);

    {
        OpenReport report;
        const Session reopened = Session::open(dir.bundle(), &report);
        CHECK(report.checkpointVerified);
        const auto& revisions = reopened.history().revisions();
        REQUIRE(revisions.size() == hashes.size());
        for (std::size_t i = 0; i < hashes.size(); ++i) {
            INFO("revision " << i);
            CHECK(revisions[i].envelope.documentHash == hashes[i]);
            CHECK(revisions[i].document.documentHash() == hashes[i]);
        }
        CHECK(reopened.history().head().document.master() == nullptr);
    }

    // Checkpointed at 0 dB, the checkpoint carries no master.
    {
        Session session = Session::open(dir.bundle());
        session.checkpoint();
    }
    const Value checkpoint = siann::json::parse(siann::io::readFile(dir.bundle() / "session.json"));
    CHECK(checkpoint.find("document")->find("master") == nullptr);
    CHECK(Session::open(dir.bundle()).history().head().envelope.documentHash == hashes[1]);
}
