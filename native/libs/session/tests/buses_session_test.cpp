// m5b-engine-buses-sends: buses and sends through the bundle (journal, checkpoint
// and replay), and a v2 bundle, which has none, read through the empty migration.

#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <random>
#include <string>
#include <utility>
#include <vector>

#include "siann/hash/jcs.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/session/session.hpp"

namespace fs = std::filesystem;
using siann::command::Command;
using siann::json::Object;
using siann::json::Value;
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
        path_ = fs::temp_directory_path() / ("siann-buses-test-" + std::to_string(rd()) + "-" + std::to_string(rd()));
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

Session newSession(const fs::path& bundle) {
    return Session::create(bundle, Document::create("Song", 48'000), "tester", "2026-11-15T00:00:00Z");
}

bool contains(const std::string& text, const std::string& part) {
    return text.find(part) != std::string::npos;
}

// Rewrites every "siann.session_document.v4" (what the engine writes since
// m5b-engine-markers) in a JCS text as v2: the bundle an
// engine before m5b-engine-buses-sends wrote (it has no bus or send field).
std::string asV2(const std::string& text) {
    std::string out = text;
    const std::string from = "siann.session_document.v4";
    for (auto pos = out.find(from); pos != std::string::npos; pos = out.find(from, pos)) {
        out.replace(pos, from.size(), "siann.session_document.v2");
    }
    return out;
}

// The journal with each line rewritten as v2 and its checksum recomputed.
std::string journalAsV2(const std::string& journal) {
    std::string out;
    std::size_t pos = 0;
    while (pos < journal.size()) {
        const std::size_t end = journal.find('\n', pos);
        const Value line = siann::json::parse(asV2(journal.substr(pos, end - pos)));
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

std::vector<Command> routing() {
    return {addTrack("trk_1"),
            addTrack("trk_2"),
            cmd(R"({"op":"bus.add","busId":"bus_a","name":"Reverb"})"),
            cmd(R"({"op":"bus.add","busId":"bus_b","name":"Group"})"),
            cmd(R"({"op":"send.add","sendId":"snd_1","trackId":"trk_1","busId":"bus_a","levelMilliDb":-6000})"),
            cmd(R"({"op":"track.set_output","trackId":"trk_2","output":{"busId":"bus_b"}})"),
            cmd(R"({"op":"bus.set_output","busId":"bus_b","output":{"busId":"bus_a"}})")};
}

}  // namespace

TEST_CASE("A v2 bundle opens with every recorded hash, has no buses and is written as v4 at its next checkpoint",
          "[session][buses][migration]") {
    TempDir dir;
    std::vector<siann::hash::Digest> hashes;
    std::string journal;
    std::string checkpoint;
    {
        Session session = newSession(dir.bundle());
        hashes.push_back(session.history().head().envelope.documentHash);
        session.commit({addTrack("trk_1")}, "a", "t1");
        hashes.push_back(session.history().head().envelope.documentHash);
        session.commit({cmd(R"({"op":"master.set_gain","gainMilliDb":-3000})")}, "a", "t2");
        hashes.push_back(session.history().head().envelope.documentHash);
        session.checkpoint();
        session.commit({cmd(R"({"op":"track.set_gain","trackId":"trk_1","gainMilliDb":-600})")}, "a", "t3");
        hashes.push_back(session.history().head().envelope.documentHash);
        journal = siann::io::readFile(dir.bundle() / "journal.ndjson");
        checkpoint = siann::io::readFile(dir.bundle() / "session.json");
    }
    // The bundle as an engine before this feature wrote it: v2 documents only.
    siann::io::writeFileAtomic(dir.bundle() / "journal.ndjson", journalAsV2(journal));
    siann::io::writeFileAtomic(dir.bundle() / "session.json", asV2(checkpoint));
    REQUIRE(contains(siann::io::readFile(dir.bundle() / "journal.ndjson"), "siann.session_document.v2"));
    REQUIRE_FALSE(contains(siann::io::readFile(dir.bundle() / "journal.ndjson"), "siann.session_document.v4"));
    REQUIRE(contains(siann::io::readFile(dir.bundle() / "session.json"), "siann.session_document.v2"));
    REQUIRE_FALSE(contains(siann::io::readFile(dir.bundle() / "session.json"), "siann.session_document.v4"));

    {
        OpenReport report;
        Session session = Session::open(dir.bundle(), &report);
        CHECK(report.checkpointVerified);
        const auto& revisions = session.history().revisions();
        REQUIRE(revisions.size() == hashes.size());
        for (std::size_t i = 0; i < hashes.size(); ++i) {
            INFO("revision " << i);
            CHECK(revisions[i].envelope.documentHash == hashes[i]);
            CHECK(revisions[i].document.documentHash() == hashes[i]);
        }
        const Document& head = session.history().head().document;
        CHECK(head.allBuses().empty());
        CHECK(head.allSends().empty());
        CHECK(head.root().busOrder.empty());
        session.checkpoint();
        const std::string written = siann::io::readFile(dir.bundle() / "session.json");
        CHECK(contains(written, "siann.session_document.v4"));
        CHECK_FALSE(contains(written, "siann.session_document.v2"));
        CHECK_FALSE(contains(written, R"("buses")"));
        // The journal is append-only: its v2 records stay as they were.
        CHECK(contains(siann::io::readFile(dir.bundle() / "journal.ndjson"), "siann.session_document.v2"));
    }
    OpenReport report;
    const Session reopened = Session::open(dir.bundle(), &report);
    CHECK(report.checkpointVerified);
    CHECK(reopened.history().head().envelope.documentHash == hashes.back());
}

TEST_CASE("A bundle with buses and sends replays to identical hashes", "[session][buses]") {
    TempDir dir;
    std::vector<siann::hash::Digest> hashes;
    {
        Session session = newSession(dir.bundle());
        for (const Command& command : routing()) {
            session.commit({command}, "a", "t");
            hashes.push_back(session.history().head().envelope.documentHash);
        }
        session.checkpoint();
        session.commit({cmd(R"({"op":"bus.remove","busId":"bus_a"})")}, "a", "t");
        hashes.push_back(session.history().head().envelope.documentHash);
        session.undo("a", "t");
        hashes.push_back(session.history().head().envelope.documentHash);
    }
    CHECK(hashes.back() == hashes[hashes.size() - 3]);
    const std::string journal = siann::io::readFile(dir.bundle() / "journal.ndjson");
    CHECK(contains(journal, R"({"change":"added","id":"bus_a","type":"bus"})"));
    CHECK(contains(journal, R"({"change":"added","id":"snd_1","type":"send"})"));
    const auto scan = scanJournal(journal);
    REQUIRE(scan.records.size() == hashes.size() + 1);
    CHECK(scan.records[5].diff.size() == 2);  // send.add: the send and its track

    auto checkReplay = [&](const Session& reopened) {
        const auto& revisions = reopened.history().revisions();
        REQUIRE(revisions.size() == hashes.size() + 1);
        for (std::size_t i = 0; i < hashes.size(); ++i) {
            INFO("revision " << i + 1);
            CHECK(revisions[i + 1].envelope.documentHash == hashes[i]);
            CHECK(revisions[i + 1].document.documentHash() == hashes[i]);
        }
        const Document& head = reopened.history().head().document;
        REQUIRE(head.bus("bus_a") != nullptr);
        REQUIRE(head.send("snd_1") != nullptr);
        CHECK(head.send("snd_1")->level.milliDb == -6000);
        CHECK(head.bus("bus_b")->output == std::optional<std::string>("bus_a"));
        CHECK(head.track("trk_2")->output == std::optional<std::string>("bus_b"));
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
