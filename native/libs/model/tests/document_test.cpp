#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <fstream>
#include <sstream>
#include <string>

#include "siann/hash/jcs.hpp"
#include "siann/model/document.hpp"

using siann::hash::formatHash;
using siann::hash::sha256;
using siann::json::Value;
using siann::model::Clip;
using siann::model::DiffEntry;
using siann::model::Document;
using siann::model::EntityRef;
using siann::model::EntityType;
using siann::model::Gain;
using siann::model::Media;
using siann::model::ModelError;
using siann::model::Track;
using siann::time::Position;

namespace {

Value readFixture(const std::string& relativePath) {
    std::ifstream in(std::string(SIANN_FIXTURES_DIR) + "/" + relativePath, std::ios::binary);
    REQUIRE(in.good());
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return siann::json::parse(buffer.str());
}

Media media(std::string id, std::int64_t frames = 48'000) {
    Media m;
    m.id = std::move(id);
    m.contentHash = sha256(m.id);
    m.channels = 2;
    m.sampleRate = 48'000;
    m.frames = frames;
    return m;
}

Track track(std::string id) {
    Track t;
    t.id = id;
    t.name = "Track " + id;
    return t;
}

Clip clip(std::string id, std::string trackId, std::string mediaId, std::int64_t length = 48'000) {
    Clip c;
    c.id = std::move(id);
    c.trackId = std::move(trackId);
    c.mediaId = std::move(mediaId);
    c.position = Position::audio(0);
    c.length = length;
    return c;
}

// A track must also be listed in root.trackOrder.
Document addTrack(const Document& doc, Track t) {
    auto root = doc.root();
    root.trackOrder.push_back(t.id);
    return doc.withTrack(std::move(t)).withRoot(std::move(root));
}

std::vector<std::string> codes(const Document& doc) {
    std::vector<std::string> out;
    for (const auto& issue : doc.validate()) {
        out.push_back(issue.code);
    }
    return out;
}

std::string errorCode(const Value& json) {
    try {
        (void)Document::fromJson(json);
    } catch (const ModelError& error) {
        return error.code();
    }
    return "no error";
}

}  // namespace

TEST_CASE("The shared fixture document gives the Node bridge's hashes", "[model][fixtures]") {
    const Value fixture = readFixture("model/session-document-v1.json");
    REQUIRE(fixture.find("schemaVersion")->asString() == "siann.model_fixtures.v1");
    const Document doc = Document::fromJson(*fixture.find("document"));
    CHECK(doc.validate().empty());

    for (const Value& leaf : fixture.find("entityHashes")->asArray()) {
        const std::string& type = leaf.find("type")->asString();
        const std::string& id = leaf.find("id")->asString();
        const EntityType entityType = type == "root"    ? EntityType::root
                                      : type == "media" ? EntityType::media
                                      : type == "track" ? EntityType::track
                                                        : EntityType::clip;
        INFO(type << ":" << id);
        CHECK(formatHash(doc.entityHash(EntityRef{entityType, id})) == leaf.find("entityHash")->asString());
    }
    CHECK(formatHash(doc.documentHash()) == fixture.find("documentHash")->asString());
}

TEST_CASE("JSON round trip is byte-identical under JCS", "[model]") {
    const Value fixture = readFixture("model/session-document-v1.json");
    const Value& original = *fixture.find("document");
    const Document doc = Document::fromJson(original);
    CHECK(siann::jcs::canonicalize(doc.toJson()) == siann::jcs::canonicalize(original));
    CHECK(Document::fromJson(doc.toJson()).documentHash() == doc.documentHash());
}

TEST_CASE("Edits return new documents and share unchanged entities", "[model]") {
    Document a = Document::create("Song", 48'000);
    a = addTrack(a, track("trk_1"));
    a = addTrack(a, track("trk_2"));
    a = a.withMedia(media("med_1"));
    a = a.withClip(clip("clp_1", "trk_1", "med_1"));
    REQUIRE(a.validate().empty());

    Track changed = *a.track("trk_2");
    changed.gain = Gain{-3'000};
    const Document b = a.withTrack(changed);

    CHECK(a.track("trk_2")->gain.milliDb == 0);
    CHECK(b.track("trk_2")->gain.milliDb == -3'000);
    CHECK(b.sharesEntity(a, EntityRef{EntityType::track, "trk_1"}));
    CHECK(b.sharesEntity(a, EntityRef{EntityType::clip, "clp_1"}));
    CHECK(b.sharesEntity(a, EntityRef{EntityType::root, "root"}));
    CHECK_FALSE(b.sharesEntity(a, EntityRef{EntityType::track, "trk_2"}));
    CHECK(a.documentHash() != b.documentHash());

    // Reverting the change restores the document hash (undo identity).
    CHECK(b.withTrack(*a.track("trk_2")).documentHash() == a.documentHash());
}

TEST_CASE("Diff lists added, removed and modified entities in order", "[model]") {
    Document a = Document::create("Song", 48'000);
    a = addTrack(a, track("trk_1"));
    a = a.withMedia(media("med_1"));
    a = a.withClip(clip("clp_1", "trk_1", "med_1"));

    Track renamed = *a.track("trk_1");
    renamed.name = "Renamed";
    const Document b = a.withoutClip("clp_1").withTrack(renamed).withMedia(media("med_2"));

    const auto changes = diff(a, b);
    REQUIRE(changes.size() == 3);
    CHECK(changes[0].entity == EntityRef{EntityType::media, "med_2"});
    CHECK(changes[0].change == DiffEntry::Change::added);
    CHECK(changes[1].entity == EntityRef{EntityType::track, "trk_1"});
    CHECK(changes[1].change == DiffEntry::Change::modified);
    CHECK(changes[2].entity == EntityRef{EntityType::clip, "clp_1"});
    CHECK(changes[2].change == DiffEntry::Change::removed);
    CHECK(diff(a, a).empty());
}

TEST_CASE("Validation reports referential and range problems", "[model]") {
    Document doc = Document::create("Song", 48'000);
    doc = addTrack(doc, track("trk_1"));
    doc = doc.withMedia(media("med_1", 1'000));

    CHECK(codes(doc.withClip(clip("clp_1", "trk_missing", "med_1", 10))) ==
          std::vector<std::string>{"unknown_track"});
    CHECK(codes(doc.withClip(clip("clp_1", "trk_1", "med_missing", 10))) ==
          std::vector<std::string>{"unknown_media"});
    CHECK(codes(doc.withClip(clip("clp_1", "trk_1", "med_1", 1'001))) ==
          std::vector<std::string>{"clip_exceeds_media"});
    CHECK(codes(doc.withClip(clip("clp_1", "trk_1", "med_1", 0))) ==
          std::vector<std::string>{"invalid_clip_length"});

    Track loud = *doc.track("trk_1");
    loud.gain = Gain{24'001};
    CHECK(codes(doc.withTrack(loud)) == std::vector<std::string>{"invalid_gain"});
    loud.gain = Gain::minusInfinity();
    CHECK(codes(doc.withTrack(loud)).empty());

    Track panned = *doc.track("trk_1");
    panned.pan = 10'001;
    CHECK(codes(doc.withTrack(panned)) == std::vector<std::string>{"invalid_pan"});

    // A track that is not in trackOrder, and an order entry with no track.
    CHECK(codes(doc.withTrack(track("trk_2"))) == std::vector<std::string>{"track_order_mismatch"});
    auto root = doc.root();
    root.trackOrder.push_back("trk_ghost");
    CHECK(codes(doc.withRoot(root)) == std::vector<std::string>{"track_order_mismatch"});

    CHECK(codes(doc.withTrack(track("bad id"))).size() >= 1);
}

TEST_CASE("Removing a media file that clips use is reported", "[model]") {
    Document doc = Document::create("Song", 48'000);
    doc = addTrack(doc, track("trk_1"));
    doc = doc.withMedia(media("med_1")).withClip(clip("clp_1", "trk_1", "med_1"));
    CHECK(codes(doc.withoutMedia("med_1")) == std::vector<std::string>{"unknown_media"});
}

TEST_CASE("fromJson rejects unknown versions, unknown fields and bad values", "[model]") {
    const Value fixture = readFixture("model/session-document-v1.json");
    const Value& original = *fixture.find("document");
    const std::string text = siann::jcs::canonicalize(original);

    auto mutated = [&](const std::string& from, const std::string& to) {
        std::string copy = text;
        const auto pos = copy.find(from);
        REQUIRE(pos != std::string::npos);
        copy.replace(pos, from.size(), to);
        return siann::json::parse(copy);
    };

    CHECK(errorCode(mutated("siann.session_document.v1", "siann.session_document.v9")) == "unsupported_version");
    CHECK(errorCode(mutated("siann.entity.track.v1", "siann.entity.track.v2")) == "unsupported_version");
    CHECK(errorCode(mutated("\"solo\":true", "\"solo\":true,\"extra\":1")) == "unknown_field");
    CHECK(errorCode(mutated("\"frames\":\"24000\"", "\"frames\":24000")) == "invalid_field");
    CHECK(errorCode(mutated("\"frames\":\"24000\"", "\"frames\":\"024000\"")) == "invalid_field");
    CHECK(errorCode(mutated("\"kind\":\"audio\"", "\"kind\":\"video\"")) == "invalid_field");
    CHECK(errorCode(mutated("\"trackId\":\"trk_drums\"", "\"trackId\":\"nope\"")) == "invalid_document");
    CHECK(errorCode(mutated("\"sampleRate\":48000,\"schema\":\"siann.entity.root.v1\"",
                            "\"sampleRate\":7,\"schema\":\"siann.entity.root.v1\"")) == "invalid_document");
}

TEST_CASE("Entities with the same id cannot be duplicated in JSON", "[model]") {
    const Value fixture = readFixture("model/session-document-v1.json");
    std::string text = siann::jcs::canonicalize(*fixture.find("document"));
    const std::string clipsKey = "\"clips\":[";
    const auto start = text.find(clipsKey) + clipsKey.size();
    // The first clip ends where the second begins; nested objects close with "},\"".
    const auto end = text.find("},{", start) + 1;
    const std::string firstClip = text.substr(start, end - start);
    text.insert(start, firstClip + ",");
    CHECK(errorCode(siann::json::parse(text)) == "duplicate_entity");
}

TEST_CASE("A large document stays consistent across many edits", "[model][scale]") {
    Document doc = Document::create("Big", 48'000);
    auto root = doc.root();
    for (int t = 0; t < 500; ++t) {
        const std::string trackId = "trk_" + std::to_string(t);
        doc = doc.withTrack(track(trackId));
        root.trackOrder.push_back(trackId);
    }
    doc = doc.withRoot(root).withMedia(media("med_1", 48'000'000));
    for (int c = 0; c < 5'000; ++c) {
        doc = doc.withClip(clip("clp_" + std::to_string(c), "trk_" + std::to_string(c % 500), "med_1"));
    }
    REQUIRE(doc.validate().empty());
    REQUIRE(doc.clipCount() == 5'000);

    const auto before = doc.documentHash();
    Document edited = doc;
    for (int i = 0; i < 100; ++i) {
        Track t = *edited.track("trk_" + std::to_string(i));
        t.gain = Gain{-i * 100};
        edited = edited.withTrack(t);
    }
    CHECK(diff(doc, edited).size() == 99);  // trk_0 keeps gain 0
    CHECK(edited.documentHash() != before);
    CHECK(doc.documentHash() == before);
}
