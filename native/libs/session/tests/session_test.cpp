#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <random>
#include <string>

#include "siann/io/durable_file.hpp"
#include "siann/session/session.hpp"

namespace fs = std::filesystem;
using siann::command::Cause;
using siann::command::Command;
using siann::command::CommandError;
using siann::model::Document;
using siann::session::JournalRecord;
using siann::session::OpenReport;
using siann::session::Session;
using siann::session::SessionError;
using siann::session::decodeRecord;
using siann::session::encodeRecord;
using siann::session::recordFromRevision;
using siann::session::scanJournal;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-session-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

Command addTrack(const std::string& id) {
    return cmd(R"({"op":"track.add","trackId":")" + id + R"(","name":")" + id + R"(","channels":2})");
}

Command setGain(const std::string& id, int milliDb) {
    return cmd(R"({"op":"track.set_gain","trackId":")" + id + R"(","gainMilliDb":)" + std::to_string(milliDb) + "}");
}

Session newSession(const fs::path& bundle) {
    return Session::create(bundle, Document::create("Song", 48'000), "tester", "2026-10-21T00:00:00Z");
}

std::string journalOf(const fs::path& bundle) {
    return siann::io::readFile(bundle / "journal.ndjson");
}

void writeJournal(const fs::path& bundle, const std::string& content) {
    siann::io::writeFileAtomic(bundle / "journal.ndjson", content);
}

void expectSameHistory(const Session& a, const Session& b) {
    const auto& ra = a.history().revisions();
    const auto& rb = b.history().revisions();
    REQUIRE(ra.size() == rb.size());
    for (std::size_t i = 0; i < ra.size(); ++i) {
        INFO("revision " << i);
        CHECK(ra[i].envelope.id == rb[i].envelope.id);
        CHECK(ra[i].envelope.parents == rb[i].envelope.parents);
        CHECK(ra[i].envelope.documentHash == rb[i].envelope.documentHash);
        CHECK(ra[i].envelope.cause == rb[i].envelope.cause);
        CHECK(ra[i].envelope.actor == rb[i].envelope.actor);
        CHECK(ra[i].envelope.time == rb[i].envelope.time);
        CHECK(ra[i].target == rb[i].target);
    }
}

}  // namespace

TEST_CASE("Journal records round-trip and carry a checksum", "[journal]") {
    TempDir dir;
    Session session = newSession(dir.bundle());
    const auto& revision = session.commit({addTrack("trk_1")}, "agent", "t1");
    const JournalRecord record = recordFromRevision(2, revision);
    const std::string line = encodeRecord(record);
    CHECK(line.find('\n') == std::string::npos);

    const JournalRecord decoded = decodeRecord(line);
    CHECK(decoded.seq == 2);
    CHECK(decoded.envelope.id == "r2");
    CHECK(decoded.envelope.documentHash == revision.envelope.documentHash);
    REQUIRE(decoded.commands.size() == 1);
    CHECK(decoded.commands[0].op() == "track.add");
    CHECK(decoded.diff.size() == 2);
    CHECK(encodeRecord(decoded) == line);

    std::string tampered = line;
    tampered.replace(tampered.find("trk_1"), 5, "trk_2");
    try {
        (void)decodeRecord(tampered);
        FAIL("expected checksum_mismatch");
    } catch (const SessionError& error) {
        CHECK(error.code() == "checksum_mismatch");
    }
}

TEST_CASE("A new bundle has a checkpoint and a create record", "[session]") {
    TempDir dir;
    const Session session = newSession(dir.bundle());
    CHECK(fs::is_regular_file(dir.bundle() / "session.json"));
    CHECK(fs::is_directory(dir.bundle() / "media"));
    CHECK(fs::is_directory(dir.bundle() / "blobs"));
    const auto scan = scanJournal(journalOf(dir.bundle()));
    REQUIRE(scan.records.size() == 1);
    CHECK(scan.records[0].envelope.cause == Cause::create);
    CHECK(scan.records[0].document.has_value());
    CHECK(session.lastSeq() == 1);
}

TEST_CASE("Creating over a non-empty directory is refused", "[session]") {
    TempDir dir;
    newSession(dir.bundle());
    try {
        newSession(dir.bundle());
        FAIL("expected bundle_exists");
    } catch (const SessionError& error) {
        CHECK(error.code() == "bundle_exists");
    }
}

TEST_CASE("Reopening replays every revision, including undo state", "[session]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.commit({addTrack("trk_1")}, "a", "t1");
        session.commit({addTrack("trk_2"), setGain("trk_2", -300)}, "a", "t2", Cause::plan);
        session.undo("a", "t3");
        session.commit({setGain("trk_1", -900)}, "a", "t4");
        session.undo("a", "t5");
    }
    OpenReport report;
    Session reopened = Session::open(dir.bundle(), &report);
    CHECK(report.recordsReplayed == 6);
    CHECK(report.checkpointVerified);
    CHECK_FALSE(report.quarantinedTail.has_value());
    CHECK(reopened.history().head().envelope.id == "r6");
    CHECK(reopened.history().canRedo());

    // Undo and redo keep working across the reopen.
    const auto& redone = reopened.redo("a", "t6");
    CHECK(redone.document.track("trk_1")->gain.milliDb == -900);
    CHECK(reopened.lastSeq() == 7);

    Session again = Session::open(dir.bundle());
    expectSameHistory(reopened, again);
}

TEST_CASE("A failed command writes nothing to the journal", "[session]") {
    TempDir dir;
    Session session = newSession(dir.bundle());
    const std::string before = journalOf(dir.bundle());
    CHECK_THROWS_AS(session.commit({setGain("trk_missing", 0)}, "a", "t"), CommandError);
    CHECK(journalOf(dir.bundle()) == before);
    CHECK(session.lastSeq() == 1);
}

TEST_CASE("A torn last record is moved aside and earlier revisions survive", "[session][recovery]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.commit({addTrack("trk_1")}, "a", "t1");
        session.commit({addTrack("trk_2")}, "a", "t2");
    }
    std::string journal = journalOf(dir.bundle());
    const std::string torn = journal.substr(0, journal.size() - 25);  // crash mid-append
    writeJournal(dir.bundle(), torn);

    OpenReport report;
    Session session = Session::open(dir.bundle(), &report);
    CHECK(report.recordsReplayed == 2);
    REQUIRE(report.quarantinedTail.has_value());
    CHECK(fs::exists(*report.quarantinedTail));
    CHECK(report.tailError.has_value());
    CHECK(session.history().head().document.track("trk_1") != nullptr);
    CHECK(session.history().head().document.track("trk_2") == nullptr);

    // The tail bytes are preserved for diagnosis.
    const std::string tail = siann::io::readFile(*report.quarantinedTail);
    CHECK(torn.substr(torn.size() - tail.size()) == tail);

    // New work continues the sequence cleanly and survives another reopen.
    session.commit({addTrack("trk_3")}, "a", "t3");
    CHECK(session.lastSeq() == 3);
    OpenReport second;
    const Session again = Session::open(dir.bundle(), &second);
    CHECK_FALSE(second.quarantinedTail.has_value());
    CHECK(again.history().head().document.track("trk_3") != nullptr);
}

TEST_CASE("Garbage after the last record is moved aside", "[session][recovery]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.commit({addTrack("trk_1")}, "a", "t1");
    }
    siann::io::appendDurable(dir.bundle() / "journal.ndjson", "{\"schema\":\"siann.journ");
    OpenReport report;
    const Session session = Session::open(dir.bundle(), &report);
    CHECK(report.recordsReplayed == 2);
    CHECK(report.quarantinedTail.has_value());
}

TEST_CASE("A corrupted record stops replay at that record", "[session][recovery]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.commit({addTrack("trk_1")}, "a", "t1");
        session.commit({addTrack("trk_2")}, "a", "t2");
        session.commit({addTrack("trk_3")}, "a", "t3");
    }
    std::string journal = journalOf(dir.bundle());
    const auto pos = journal.find("trk_2");
    journal.replace(pos, 5, "trk_X");  // flips bytes inside record 3
    writeJournal(dir.bundle(), journal);

    OpenReport report;
    const Session session = Session::open(dir.bundle(), &report);
    CHECK(report.recordsReplayed == 2);
    CHECK(report.quarantinedTail.has_value());
    CHECK(session.history().head().document.track("trk_2") == nullptr);
    CHECK(session.history().head().document.track("trk_3") == nullptr);
}

TEST_CASE("A temp file from an interrupted checkpoint is removed", "[session][recovery]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.commit({addTrack("trk_1")}, "a", "t1");
        session.checkpoint();
    }
    siann::io::appendDurable(dir.bundle() / "session.json.tmp", "{\"partial");
    OpenReport report;
    const Session session = Session::open(dir.bundle(), &report);
    CHECK(report.checkpointVerified);
    REQUIRE(report.removedTempFiles.size() == 1);
    CHECK_FALSE(fs::exists(dir.bundle() / "session.json.tmp"));
}

TEST_CASE("A checkpoint that disagrees with the journal is an error", "[session][recovery]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.commit({addTrack("trk_1")}, "a", "t1");
        session.checkpoint();
    }
    std::string checkpoint = siann::io::readFile(dir.bundle() / "session.json");
    checkpoint.replace(checkpoint.find("\"name\":\"trk_1\""), 14, "\"name\":\"trk_9\"");
    siann::io::writeFileAtomic(dir.bundle() / "session.json", checkpoint);
    try {
        (void)Session::open(dir.bundle());
        FAIL("expected checkpoint_mismatch");
    } catch (const SessionError& error) {
        CHECK(error.code() == "checkpoint_mismatch");
    }
}

TEST_CASE("A journal shorter than its checkpoint is reported", "[session][recovery]") {
    TempDir dir;
    {
        Session session = newSession(dir.bundle());
        session.commit({addTrack("trk_1")}, "a", "t1");
        session.commit({addTrack("trk_2")}, "a", "t2");
        session.checkpoint();
    }
    const std::string journal = journalOf(dir.bundle());
    const auto firstEnd = journal.find('\n') + 1;
    writeJournal(dir.bundle(), journal.substr(0, firstEnd));
    try {
        (void)Session::open(dir.bundle());
        FAIL("expected journal_behind_checkpoint");
    } catch (const SessionError& error) {
        CHECK(error.code() == "journal_behind_checkpoint");
    }
}

TEST_CASE("Checkpoints are written automatically", "[session]") {
    TempDir dir;
    Session session = newSession(dir.bundle());
    for (int i = 0; i < Session::kCheckpointInterval; ++i) {
        session.commit({addTrack("trk_" + std::to_string(i))}, "a", "t");
    }
    const auto checkpoint = siann::json::parse(siann::io::readFile(dir.bundle() / "session.json"));
    CHECK(checkpoint.find("coversSeq")->asString() == std::to_string(Session::kCheckpointInterval));
}

TEST_CASE("Opening something that is not a bundle fails clearly", "[session]") {
    TempDir dir;
    fs::create_directories(dir.bundle());
    try {
        (void)Session::open(dir.bundle());
        FAIL("expected not_a_bundle");
    } catch (const SessionError& error) {
        CHECK(error.code() == "not_a_bundle");
    }
}
