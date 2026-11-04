#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <random>
#include <string>

#include "siann/io/durable_file.hpp"
#include "siann/session/media_import.hpp"
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

TEST_CASE("A plan applied through Session writes one journal record with cause plan whose diff equals the plan's writeSet",
          "[session][plan]") {
    TempDir dir;
    Session session = newSession(dir.bundle());
    session.commit({addTrack("trk_1"), addTrack("trk_3")}, "user", "t1");
    const std::string hash = *session.submitPlan({setGain("trk_1", -600), addTrack("trk_2")}, {}, "r2").hashText;
    session.commit({setGain("trk_3", -900)}, "user", "t2");  // unrelated to the plan
    session.approvePlan(hash, "user", "t3");

    const std::int64_t before = session.lastSeq();
    const auto& revision = session.applyPlan(hash, "agent", "t4");
    CHECK(revision.envelope.cause == Cause::plan);
    CHECK(session.lastSeq() == before + 1);
    CHECK(session.plans().find(hash)->appliedRevision == std::optional{revision.envelope.id});

    const auto scan = scanJournal(journalOf(dir.bundle()));
    REQUIRE(scan.records.size() == static_cast<std::size_t>(before + 1));
    const JournalRecord& record = scan.records.back();
    CHECK(record.envelope.cause == Cause::plan);
    CHECK(record.envelope.id == revision.envelope.id);
    CHECK(record.commands.size() == 2);
    const auto& writeSet = session.plans().find(hash)->writeSet;
    REQUIRE(writeSet.size() == 3);  // root, trk_1, trk_2
    REQUIRE(record.diff.size() == writeSet.size());
    for (std::size_t i = 0; i < writeSet.size(); ++i) {
        CHECK(record.diff[i].entity == writeSet[i].ref);
    }
}

TEST_CASE("Reopen replays the plan revision with identical documentHash", "[session][plan]") {
    TempDir dir;
    siann::hash::Digest headHash{};
    {
        Session session = newSession(dir.bundle());
        session.commit({addTrack("trk_1"), addTrack("trk_2"), addTrack("trk_3")}, "user", "t1");
        const std::string original =
            *session.submitPlan({setGain("trk_1", -600), setGain("trk_2", -1200), setGain("trk_3", -300)}, {}, "r2")
                 .hashText;
        const auto& sub = session.approvePlanPartial(original, {0, 2}, "user", "t2");
        session.applyPlan(*sub.hashText, "agent", "t3");
        CHECK(session.plans().find(original)->state == siann::command::PlanState::rejected);
        headHash = session.history().head().envelope.documentHash;
    }
    Session reopened = Session::open(dir.bundle());
    CHECK(reopened.history().head().envelope.cause == Cause::plan);
    CHECK(reopened.history().head().envelope.documentHash == headHash);
    CHECK(reopened.history().head().document.track("trk_2")->gain.milliDb == 0);
    CHECK(reopened.plans().size() == 0);  // plans are in-memory engine state in M3
}

TEST_CASE("Journal records for rollback carry the target", "[journal][rollback]") {
    TempDir dir;
    Session session = newSession(dir.bundle());
    session.commit({addTrack("trk_1")}, "agent", "t1", Cause::plan);
    const auto& revision = session.rollback("r2", "user", "t2");
    JournalRecord record = recordFromRevision(3, revision);
    const std::string line = encodeRecord(record);
    CHECK(line.find(R"("cause":"rollback")") != std::string::npos);
    CHECK(line.find(R"("target":"r2")") != std::string::npos);

    const JournalRecord decoded = decodeRecord(line);
    CHECK(decoded.envelope.cause == Cause::rollback);
    CHECK(decoded.target == std::optional<std::string>{"r2"});
    CHECK(decoded.commands.empty());
    CHECK(encodeRecord(decoded) == line);

    record.target.reset();
    try {
        (void)decodeRecord(encodeRecord(record));
        FAIL("expected corrupt_record");
    } catch (const SessionError& error) {
        CHECK(error.code() == "corrupt_record");
    }
}

TEST_CASE("A rolled back plan is journaled and replays on reopen", "[session][rollback]") {
    TempDir dir;
    siann::hash::Digest headHash{};
    {
        Session session = newSession(dir.bundle());
        session.commit({addTrack("trk_1"), setGain("trk_1", -600)}, "agent", "t1", Cause::plan);  // r2
        session.commit({cmd(R"({"op":"media.add","mediaId":"m1","contentHash":"sha256:)" + std::string(64, 'd') +
                            R"(","format":"wav","channels":2,"sampleRate":48000,"frames":"48000"})")},
                       "user", "t2");  // r3, unrelated to the plan
        const auto& rolled = session.rollback("r2", "user", "t3");
        CHECK(rolled.document.track("trk_1") == nullptr);
        CHECK(rolled.document.media("m1") != nullptr);
        headHash = rolled.envelope.documentHash;
        const auto scan = scanJournal(journalOf(dir.bundle()));
        REQUIRE(scan.records.size() == 4);
        CHECK(scan.records.back().envelope.cause == Cause::rollback);
        CHECK(scan.records.back().target == std::optional<std::string>{"r2"});
        CHECK(journalOf(dir.bundle()).find(R"("cause":"rollback")") != std::string::npos);
    }
    OpenReport report;
    Session reopened = Session::open(dir.bundle(), &report);
    CHECK(report.recordsReplayed == 4);
    CHECK(reopened.history().head().envelope.documentHash == headHash);
    CHECK(reopened.history().head().envelope.cause == Cause::rollback);
    CHECK(reopened.history().head().target == std::optional<std::string>{"r2"});
}

TEST_CASE("Rollbacks, refused rollbacks and later edits replay on reopen", "[session][rollback]") {
    TempDir dir;
    siann::hash::Digest headHash{};
    {
        Session session = newSession(dir.bundle());
        session.commit({addTrack("trk_1"), setGain("trk_1", -600)}, "agent", "t1", Cause::plan);  // r2
        session.commit({addTrack("trk_2")}, "user", "t2");                                         // r3
        session.commit({setGain("trk_1", -300)}, "user", "t3");                                    // r4
        (void)session;
    }
    {
        // trk_1 (added by the plan) changed afterwards: this plan conflicts on
        // it, not on root, although trk_2 was added after the plan too.
        Session session = Session::open(dir.bundle());
        try {
            session.rollback("r2", "user", "t4");
            FAIL("expected rollback_conflict");
        } catch (const siann::command::RollbackError& error) {
            CHECK(error.conflictKeys() == std::vector<std::string>{"track:trk_1"});
        }
        CHECK(session.lastSeq() == 4);
        session.commit({setGain("trk_2", 0)}, "user", "t5");                                           // r5
        session.commit({addTrack("trk_3"), setGain("trk_3", -900)}, "agent", "t6", Cause::plan);  // r6
        session.commit({setGain("trk_1", -1200)}, "user", "t7");                                      // r7
        const std::int64_t before = session.lastSeq();
        const auto& rolled = session.rollback("r6", "user", "t8");  // r8
        CHECK(rolled.envelope.cause == Cause::rollback);
        CHECK(session.lastSeq() == before + 1);
        CHECK(rolled.document.track("trk_3") == nullptr);
        CHECK(rolled.document.track("trk_1")->gain.milliDb == -1200);
        headHash = rolled.envelope.documentHash;

        const std::string journal = journalOf(dir.bundle());
        const std::string last = journal.substr(journal.rfind('\n', journal.size() - 2) + 1);
        CHECK(last.find(R"("cause":"rollback")") != std::string::npos);
        CHECK(last.find(R"("target":"r6")") != std::string::npos);
    }
    OpenReport report;
    Session reopened = Session::open(dir.bundle(), &report);
    CHECK(report.recordsReplayed == 8);
    CHECK(reopened.history().head().envelope.documentHash == headHash);
    CHECK(reopened.history().head().envelope.cause == Cause::rollback);
    CHECK(reopened.history().head().target == std::optional<std::string>{"r6"});
    CHECK(reopened.history().canUndo());
}

TEST_CASE("Rolling back a plan through Session journals the inverse revision", "[session][plan][rollback]") {
    TempDir dir;
    Session session = newSession(dir.bundle());
    session.commit({addTrack("trk_1")}, "user", "t1");
    const std::string hash = *session.submitPlan({setGain("trk_1", -600)}, {}, "r2").hashText;
    session.approvePlan(hash, "user", "t2");
    const auto& applied = session.applyPlan(hash, "agent", "t3");
    const std::string appliedId = applied.envelope.id;
    session.commit({addTrack("trk_2")}, "user", "t4");  // unrelated to the plan's entities

    const std::int64_t before = session.lastSeq();
    const auto& rolled = session.rollbackPlan(hash, "user", "t5");
    CHECK(rolled.envelope.cause == Cause::rollback);
    CHECK(rolled.target == std::optional{appliedId});
    CHECK(rolled.document.track("trk_1")->gain.milliDb == 0);
    CHECK(rolled.document.track("trk_2") != nullptr);
    CHECK(session.lastSeq() == before + 1);
    CHECK(session.plans().find(hash)->state == siann::command::PlanState::rolled_back);

    try {
        session.rollbackPlan(hash, "user", "t6");
        FAIL("expected plan_not_applied");
    } catch (const CommandError& error) {
        CHECK(error.code() == "plan_not_applied");
    }
    CHECK(session.lastSeq() == before + 1);
}

TEST_CASE("Rollback never deletes media files or renders", "[session][rollback]") {
    TempDir dir;
    Session session = newSession(dir.bundle());
    const std::string hex(64, 'c');
    const auto digest = siann::hash::parseHash("sha256:" + hex);
    REQUIRE(digest.has_value());
    const fs::path media = siann::session::mediaPath(dir.bundle(), *digest);
    siann::io::writeFileAtomic(media, "RIFF not really a wav");
    fs::create_directories(dir.bundle() / "renders");
    const fs::path render = dir.bundle() / "renders" / "mix.wav";
    siann::io::writeFileAtomic(render, "rendered");

    session.commit({cmd(R"({"op":"media.add","mediaId":"m1","contentHash":"sha256:)" + hex +
                        R"(","format":"wav","channels":2,"sampleRate":48000,"frames":"48000"})")},
                   "agent", "t1", Cause::plan);  // r2
    REQUIRE(session.history().head().document.media("m1") != nullptr);

    const auto& rolled = session.rollback("r2", "user", "t2");
    CHECK(rolled.document.media("m1") == nullptr);
    CHECK(fs::exists(media));
    CHECK(siann::io::readFile(media) == "RIFF not really a wav");
    CHECK(fs::exists(render));

    Session reopened = Session::open(dir.bundle());
    CHECK(reopened.history().head().document.media("m1") == nullptr);
    CHECK(fs::exists(media));
    CHECK(fs::exists(render));
}

TEST_CASE("Rejecting a plan through Session leaves the journal unchanged", "[session][plan]") {
    TempDir dir;
    Session session = newSession(dir.bundle());
    session.commit({addTrack("trk_1")}, "user", "t1");
    const std::string hash = *session.submitPlan({setGain("trk_1", -600)}, {}, "r2").hashText;
    const std::string before = journalOf(dir.bundle());
    CHECK(session.rejectPlan(hash, "user", "t2", "no").state == siann::command::PlanState::rejected);
    CHECK_THROWS_AS(session.applyPlan(hash, "agent", "t3"), CommandError);
    CHECK(journalOf(dir.bundle()) == before);
}
