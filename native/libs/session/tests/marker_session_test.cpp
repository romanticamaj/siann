// m5b-engine-markers: markers through the bundle (journal, checkpoint and replay),
// and a literal v3 bundle, which has none, read through the empty migration.

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
using siann::model::Document;
using siann::session::OpenReport;
using siann::session::Session;
using siann::session::scanJournal;

namespace {

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-markers-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

Session newSession(const fs::path& bundle) {
    return Session::create(bundle, Document::create("Song", 48'000), "tester", "2026-11-15T00:00:00Z");
}

bool contains(const std::string& text, const std::string& part) {
    return text.find(part) != std::string::npos;
}

std::vector<Command> markerEdits() {
    return {cmd(R"({"op":"marker.add","markerId":"mk_a","position":"48000","name":"Intro"})"),
            cmd(R"({"op":"marker.add","markerId":"mk_b","position":"96000","length":"48000"})"),
            cmd(R"({"op":"marker.add","markerId":"mk_c","position":"0","number":5,"length":"10"})"),
            cmd(R"({"op":"marker.move","markerId":"mk_b","position":"144000","length":"24000"})"),
            cmd(R"({"op":"marker.rename","markerId":"mk_a","name":"Verse"})"),
            cmd(R"({"op":"marker.remove","markerId":"mk_c"})")};
}

// A bundle the build at origin/main before this branch wrote (commit beefbbc3,
// format siann.session_document.v3): siann-cli create Old.siann --name Old, then
// five siann-cli exec (track.add trk_1, session.set_locators 48000..96000,
// master.set_gain -3000, bus.add bus_a, track.set_notes trk_1), checked there with
// siann-cli verify (checkpointVerified, 6 records). The checkpoint is the one
// create wrote at r1. session.json and journal.ndjson are embedded verbatim.
const std::string kOldCheckpoint =
    R"({"coversSeq":"1","document":{"clips":[],"media":[],"root":{"id":"root","name":"Old","sampleRate":48000,"schema":"siann.entity.root.v1","tempo":[{"milliBpm":120000,"ticks":"0"}],"trackOrder":[]},"schemaVersion":"siann.session_document.v3","tracks":[]},"head":{"actor":"cli","cause":"create","documentHash":"sha256:f1167836d0358b52011ea28f7ca94ffaad99995dcbb183cc50ee9b1610776a8c","id":"r1","parents":[],"time":"2026-11-24T00:00:00Z"},"schemaVersion":"siann.checkpoint.v1","transport":{"cycle":false,"punch":{"in":false,"out":false}}})";
const std::string kOldJournal =
        std::string(R"({"checksum":"sha256:3e4090b13b3f4cccdcc48ac6b5f6de7cc52e4470eed3facced49f1e117a6a978","commands":[],"diff":[],"document":{"clips":[],"media":[],"root":{"id":"root","name":"Old","sampleRate":48000,"schema":"siann.entity.root.v1","tempo":[{"milliBpm":120000,"ticks":"0"}],"trackOrder":[]},"schemaVersion":"siann.session_document.v3","tracks":[]},"revision":{"actor":"cli","cause":"create","documentHash":"sha256:f1167836d0358b52011ea28f7ca94ffaad99995dcbb183cc50ee9b1610776a8c","id":"r1","parents":[],"time":"2026-11-24T00:00:00Z"},"schema":"siann.journal_record.v1","seq":"1"})") + "\n" +
        R"({"checksum":"sha256:3da7cb84f1335a7337803943d9b2814165c050beba3e9c830b55d4877401ddcd","commands":[{"channels":2,"name":"Drums","op":"track.add","trackId":"trk_1"}],"diff":[{"change":"modified","id":"root","type":"root"},{"change":"added","id":"trk_1","type":"track"}],"revision":{"actor":"tester","cause":"command","documentHash":"sha256:cd160ccaf794bf7358663f24d15ea01abfc483c716eb470634066173df714d32","id":"r2","parents":["r1"],"time":"2026-11-24T00:00:01Z"},"schema":"siann.journal_record.v1","seq":"2"})" + "\n" +
        R"({"checksum":"sha256:32ae957c4d63f4168b6c09ceb04a683efa9c80fec1343523cf3e391a1470ae78","commands":[{"left":"48000","op":"session.set_locators","right":"96000"}],"diff":[{"change":"added","id":"locators","type":"locators"}],"revision":{"actor":"tester","cause":"command","documentHash":"sha256:1409f2c676c6b39bd4b35d3b51351f51fbb1d5659fd764d85c799e3853f2fd1d","id":"r3","parents":["r2"],"time":"2026-11-24T00:00:02Z"},"schema":"siann.journal_record.v1","seq":"3"})" + "\n" +
        R"({"checksum":"sha256:f556b4f51f7ed7199eec27f987dd4c2332063fe826070b79c0e59e25aba58584","commands":[{"gainMilliDb":-3000,"op":"master.set_gain"}],"diff":[{"change":"added","id":"master","type":"master"}],"revision":{"actor":"tester","cause":"command","documentHash":"sha256:894b972bbbba3f6e0e1a31989bddd23ea29a6470332ed8f5cfa9a1972a589995","id":"r4","parents":["r3"],"time":"2026-11-24T00:00:03Z"},"schema":"siann.journal_record.v1","seq":"4"})" + "\n" +
        R"({"checksum":"sha256:13e6ca7ca5836454e88e5c51b343196a75dddf4cbb14972afafc7155164e362c","commands":[{"busId":"bus_a","name":"Reverb","op":"bus.add"}],"diff":[{"change":"modified","id":"root","type":"root"},{"change":"added","id":"bus_a","type":"bus"}],"revision":{"actor":"tester","cause":"command","documentHash":"sha256:387b4d7692696f50ca936d49c99b31d7920985c2ee827d82e741c577db9e5069","id":"r5","parents":["r4"],"time":"2026-11-24T00:00:04Z"},"schema":"siann.journal_record.v1","seq":"5"})" + "\n" +
        R"({"checksum":"sha256:276c5ce48f48dbb04979b072a9c0b0f494b5b8145eed15ddb32f7fca3e4c0be5","commands":[{"notes":"Kick and snare","op":"track.set_notes","trackId":"trk_1"}],"diff":[{"change":"modified","id":"trk_1","type":"track"}],"revision":{"actor":"tester","cause":"command","documentHash":"sha256:869a08538a7214221509008936f0421d8da089b6589f675f5ebb47e4b0754783","id":"r6","parents":["r5"],"time":"2026-11-24T00:00:05Z"},"schema":"siann.journal_record.v1","seq":"6"})" + "\n";
const std::string kOldHead = "sha256:869a08538a7214221509008936f0421d8da089b6589f675f5ebb47e4b0754783";
const std::vector<std::string> kOldHashes{
    "sha256:f1167836d0358b52011ea28f7ca94ffaad99995dcbb183cc50ee9b1610776a8c",
    "sha256:cd160ccaf794bf7358663f24d15ea01abfc483c716eb470634066173df714d32",
    "sha256:1409f2c676c6b39bd4b35d3b51351f51fbb1d5659fd764d85c799e3853f2fd1d",
    "sha256:894b972bbbba3f6e0e1a31989bddd23ea29a6470332ed8f5cfa9a1972a589995",
    "sha256:387b4d7692696f50ca936d49c99b31d7920985c2ee827d82e741c577db9e5069",
    kOldHead,
};

}  // namespace

TEST_CASE("Markers survive a checkpoint and reopen, and journal-only replay", "[session][markers]") {
    TempDir dir;
    std::vector<siann::hash::Digest> hashes;
    {
        Session session = newSession(dir.bundle());
        for (const Command& command : markerEdits()) {
            session.commit({command}, "a", "t");
            hashes.push_back(session.history().head().envelope.documentHash);
        }
        session.checkpoint();
    }
    const std::string journal = siann::io::readFile(dir.bundle() / "journal.ndjson");
    CHECK(contains(journal, R"({"change":"added","id":"mk_a","type":"marker"})"));
    CHECK(contains(journal, R"({"change":"modified","id":"mk_b","type":"marker"})"));
    CHECK(contains(journal, R"({"change":"removed","id":"mk_c","type":"marker"})"));
    const auto scan = scanJournal(journal);
    REQUIRE(scan.records.size() == hashes.size() + 1);
    for (std::size_t i = 1; i < scan.records.size(); ++i) {
        CHECK(scan.records[i].diff.size() == 1);  // each marker command touches its marker only
    }
    const Value checkpoint = siann::json::parse(siann::io::readFile(dir.bundle() / "session.json"));
    CHECK(checkpoint.find("document")->find("schemaVersion")->asString() == "siann.session_document.v4");
    REQUIRE(checkpoint.find("document")->find("markers") != nullptr);
    CHECK(checkpoint.find("document")->find("markers")->asArray().size() == 2);

    auto checkReplay = [&](const Session& reopened) {
        const auto& revisions = reopened.history().revisions();
        REQUIRE(revisions.size() == hashes.size() + 1);
        for (std::size_t i = 0; i < hashes.size(); ++i) {
            INFO("revision " << i + 1);
            CHECK(revisions[i + 1].envelope.documentHash == hashes[i]);
            CHECK(revisions[i + 1].document.documentHash() == hashes[i]);
        }
        const Document& head = reopened.history().head().document;
        REQUIRE(head.marker("mk_a") != nullptr);
        CHECK(head.marker("mk_a")->name == "Verse");
        CHECK(head.marker("mk_a")->number == 1);
        REQUIRE(head.marker("mk_b") != nullptr);
        CHECK(head.marker("mk_b")->position == 144'000);
        CHECK(head.marker("mk_b")->length == std::optional<std::int64_t>(24'000));
        CHECK(head.marker("mk_b")->number == 1);
        CHECK(head.marker("mk_c") == nullptr);
    };
    {
        OpenReport report;
        const Session reopened = Session::open(dir.bundle(), &report);
        CHECK(report.checkpointVerified);
        checkReplay(reopened);
    }
    // Without the checkpoint: the journal alone.
    fs::remove(dir.bundle() / "session.json");
    OpenReport report;
    const Session replayed = Session::open(dir.bundle(), &report);
    CHECK_FALSE(report.checkpointVerified);
    checkReplay(replayed);
}

TEST_CASE("A literal v3 bundle opens with its recorded hashes, has no markers and is written as v4",
          "[session][markers][migration]") {
    TempDir dir;
    const fs::path bundle = dir.bundle();
    fs::create_directories(bundle);
    REQUIRE(contains(kOldCheckpoint, R"("schemaVersion":"siann.session_document.v3")"));
    REQUIRE_FALSE(contains(kOldJournal, "siann.session_document.v4"));
    siann::io::writeFileAtomic(bundle / "session.json", kOldCheckpoint);
    siann::io::writeFileAtomic(bundle / "journal.ndjson", kOldJournal);

    {
        OpenReport report;
        Session session = Session::open(bundle, &report);
        CHECK(report.checkpointVerified);
        CHECK(report.recordsReplayed == 6);
        CHECK_FALSE(report.quarantinedTail.has_value());
        const auto& revisions = session.history().revisions();
        REQUIRE(revisions.size() == kOldHashes.size());
        for (std::size_t i = 0; i < kOldHashes.size(); ++i) {
            INFO("revision " << i + 1);
            CHECK(siann::hash::formatHash(revisions[i].envelope.documentHash) == kOldHashes[i]);
            CHECK(siann::hash::formatHash(revisions[i].document.documentHash()) == kOldHashes[i]);
        }
        const auto& head = session.history().head();
        CHECK(head.envelope.id == "r6");
        CHECK(siann::hash::formatHash(head.envelope.documentHash) == kOldHead);
        CHECK(head.document.allMarkers().empty());
        REQUIRE(head.document.track("trk_1") != nullptr);
        REQUIRE(head.document.locators() != nullptr);
        CHECK(head.document.locators()->left == 48'000);
        REQUIRE(head.document.master() != nullptr);
        CHECK(head.document.master()->gain.milliDb == -3000);
        CHECK(head.document.bus("bus_a") != nullptr);
        CHECK(head.document.track("trk_1")->notes == "Kick and snare");

        // A marker now is a revision; the earlier ones keep their hashes.
        session.commit({cmd(R"({"op":"marker.add","markerId":"mk_1","position":"0","name":"Start"})")}, "tester",
                       "2026-11-24T00:00:06Z");
        CHECK(session.history().head().document.marker("mk_1")->number == 1);
        session.checkpoint();
        const std::string written = siann::io::readFile(bundle / "session.json");
        CHECK(contains(written, "siann.session_document.v4"));
        CHECK_FALSE(contains(written, "siann.session_document.v3"));
        CHECK(contains(written, R"("markers":[)"));
        // The journal is append-only: its v3 records stay as they were.
        const std::string journal = siann::io::readFile(bundle / "journal.ndjson");
        CHECK(journal.substr(0, kOldJournal.size()) == kOldJournal);
        CHECK(contains(journal, R"({"change":"added","id":"mk_1","type":"marker"})"));
    }
    OpenReport report;
    const Session reopened = Session::open(bundle, &report);
    CHECK(report.checkpointVerified);
    const auto& revisions = reopened.history().revisions();
    REQUIRE(revisions.size() == kOldHashes.size() + 1);
    for (std::size_t i = 0; i < kOldHashes.size(); ++i) {
        CHECK(siann::hash::formatHash(revisions[i].envelope.documentHash) == kOldHashes[i]);
    }
    CHECK(reopened.history().head().document.marker("mk_1") != nullptr);
}
