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
        const EntityType entityType = type == "root"          ? EntityType::root
                                      : type == "media"       ? EntityType::media
                                      : type == "track"       ? EntityType::track
                                      : type == "plugin_slot" ? EntityType::plugin_slot
                                                              : EntityType::clip;
        INFO(type << ":" << id);
        CHECK(formatHash(doc.entityHash(EntityRef{entityType, id})) == leaf.find("entityHash")->asString());
    }
    CHECK(formatHash(doc.documentHash()) == fixture.find("documentHash")->asString());
}

TEST_CASE("findEntityHash returns the entity hash or nothing for an absent entity", "[model]") {
    Document doc = Document::create("Song", 48'000);
    doc = addTrack(doc, track("trk_1"));
    const EntityRef present{EntityType::track, "trk_1"};
    CHECK(doc.findEntityHash(present) == std::optional{doc.entityHash(present)});
    CHECK(doc.findEntityHash(EntityRef{EntityType::root, "root"}).has_value());
    CHECK_FALSE(doc.findEntityHash(EntityRef{EntityType::track, "trk_9"}).has_value());
    CHECK_FALSE(doc.findEntityHash(EntityRef{EntityType::root, "other"}).has_value());
    CHECK_FALSE(doc.findEntityHash(EntityRef{EntityType::clip, "trk_1"}).has_value());
}

TEST_CASE("JSON round trip is byte-identical under JCS", "[model]") {
    const Value fixture = readFixture("model/session-document-v2.json");
    const Value& original = *fixture.find("document");
    const Document doc = Document::fromJson(original);
    CHECK(siann::jcs::canonicalize(doc.toJson()) == siann::jcs::canonicalize(original));
    CHECK(Document::fromJson(doc.toJson()).documentHash() == doc.documentHash());
}

TEST_CASE("The v2 fixture with locators gives the Node bridge's hashes", "[model][fixtures][locators]") {
    const Value fixture = readFixture("model/session-document-v2.json");
    const Document doc = Document::fromJson(*fixture.find("document"));
    CHECK(doc.validate().empty());
    REQUIRE(doc.locators() != nullptr);
    CHECK(doc.locators()->left == 96'000);
    CHECK(doc.locators()->right == 4'800'001);

    bool sawLocators = false;
    for (const Value& leaf : fixture.find("entityHashes")->asArray()) {
        const std::string& type = leaf.find("type")->asString();
        const std::string& id = leaf.find("id")->asString();
        const EntityType entityType = type == "root"          ? EntityType::root
                                      : type == "media"       ? EntityType::media
                                      : type == "track"       ? EntityType::track
                                      : type == "plugin_slot" ? EntityType::plugin_slot
                                      : type == "locators"    ? EntityType::locators
                                                              : EntityType::clip;
        sawLocators = sawLocators || entityType == EntityType::locators;
        INFO(type << ":" << id);
        CHECK(formatHash(doc.entityHash(EntityRef{entityType, id})) == leaf.find("entityHash")->asString());
    }
    CHECK(sawLocators);
    CHECK(formatHash(doc.documentHash()) == fixture.find("documentHash")->asString());
    CHECK(siann::model::entityTypeName(EntityType::locators) == "locators");
    CHECK(siann::jcs::canonicalize(siann::model::toJson(*doc.locators())) ==
          siann::jcs::canonicalize(*fixture.find("document")->find("locators")));
}

TEST_CASE("A v1 document reads through the migration with no locators and its v1 hash", "[model][locators]") {
    const Value v1 = readFixture("model/session-document-v1.json");
    const Document doc = Document::fromJson(*v1.find("document"));
    CHECK(doc.locators() == nullptr);
    CHECK_FALSE(doc.findEntityHash(EntityRef{EntityType::locators, "locators"}).has_value());
    CHECK(formatHash(doc.documentHash()) == v1.find("documentHash")->asString());

    // Written as v2, with locators omitted while absent; otherwise the same JSON.
    const Value written = doc.toJson();
    CHECK(written.find("schemaVersion")->asString() == "siann.session_document.v2");
    CHECK(written.find("locators") == nullptr);
    std::string expected = siann::jcs::canonicalize(*v1.find("document"));
    const std::string from = "siann.session_document.v1";
    expected.replace(expected.find(from), from.size(), "siann.session_document.v2");
    CHECK(siann::jcs::canonicalize(written) == expected);
    CHECK(Document::fromJson(written).documentHash() == doc.documentHash());

    // The v2 fixture minus its locators is the v1 document.
    const Value v2 = readFixture("model/session-document-v2.json");
    CHECK(Document::fromJson(*v2.find("document")).withoutLocators().documentHash() == doc.documentHash());
}

TEST_CASE("A v1 document that carries locators is rejected", "[model][locators]") {
    const Value v2 = readFixture("model/session-document-v2.json");
    std::string text = siann::jcs::canonicalize(*v2.find("document"));
    const std::string from = "siann.session_document.v2";
    text.replace(text.find(from), from.size(), "siann.session_document.v1");
    CHECK(errorCode(siann::json::parse(text)) == "unknown_field");
}

TEST_CASE("Locators reject a malformed entity in JSON", "[model][locators]") {
    const Value v2 = readFixture("model/session-document-v2.json");
    const std::string text = siann::jcs::canonicalize(*v2.find("document"));
    auto mutated = [&](const std::string& from, const std::string& to) {
        std::string copy = text;
        const auto pos = copy.find(from);
        REQUIRE(pos != std::string::npos);
        copy.replace(pos, from.size(), to);
        return siann::json::parse(copy);
    };
    CHECK(errorCode(mutated(R"("left":"96000")", R"("left":96000)")) == "invalid_field");
    CHECK(errorCode(mutated(R"("id":"locators")", R"("id":"loc")")) == "invalid_field");
    CHECK(errorCode(mutated("siann.entity.locators.v1", "siann.entity.locators.v2")) == "unsupported_version");
    CHECK(errorCode(mutated(R"("left":"96000")", R"("extra":1,"left":"96000")")) == "unknown_field");
    CHECK(errorCode(mutated(R"("left":"96000")", R"("left":"4800001")")) == "invalid_document");
}

TEST_CASE("Locators out of order or out of range are invalid_locators", "[model][locators]") {
    using siann::model::Locators;
    const Document doc = Document::create("Song", 48'000);
    CHECK(codes(doc.withLocators(Locators{0, 1})).empty());
    CHECK(codes(doc.withLocators(Locators{0, siann::time::kMaxPositionMagnitude})).empty());
    CHECK(codes(doc.withLocators(Locators{10, 10})) == std::vector<std::string>{"invalid_locators"});
    CHECK(codes(doc.withLocators(Locators{11, 10})) == std::vector<std::string>{"invalid_locators"});
    CHECK(codes(doc.withLocators(Locators{-1, 10})) == std::vector<std::string>{"invalid_locators"});
    CHECK(codes(doc.withLocators(Locators{0, siann::time::kMaxPositionMagnitude + 1})) ==
          std::vector<std::string>{"invalid_locators"});
    const auto issues = doc.withLocators(Locators{5, 1}).validate();
    REQUIRE(issues.size() == 1);
    CHECK(issues.front().entity == EntityRef{EntityType::locators, "locators"});
}

TEST_CASE("Locators are added, modified and removed like any entity", "[model][locators]") {
    using siann::model::Locators;
    const Document a = Document::create("Song", 48'000);
    const Document b = a.withLocators(Locators{100, 200});
    const Document c = b.withLocators(Locators{100, 300});
    const Document d = c.withoutLocators();
    const EntityRef ref{EntityType::locators, "locators"};

    REQUIRE(b.locators() != nullptr);
    CHECK(*b.locators() == Locators{100, 200});
    CHECK(a.locators() == nullptr);
    CHECK(d.locators() == nullptr);

    auto only = [&](const Document& before, const Document& after, DiffEntry::Change change) {
        const auto changes = diff(before, after);
        REQUIRE(changes.size() == 1);
        CHECK(changes[0].entity == ref);
        CHECK(changes[0].change == change);
    };
    only(a, b, DiffEntry::Change::added);
    only(b, c, DiffEntry::Change::modified);
    only(c, d, DiffEntry::Change::removed);
    CHECK(diff(b, b.withLocators(Locators{100, 200})).empty());

    CHECK(b.findEntityHash(ref).has_value());
    CHECK(c.sharesEntity(c, ref));
    CHECK(addTrack(c, track("trk_x")).sharesEntity(c, ref));
    CHECK_FALSE(c.sharesEntity(b, ref));
    CHECK_FALSE(a.sharesEntity(a, ref));
    CHECK(b.documentHash() != a.documentHash());
    CHECK(d.documentHash() == a.documentHash());
    CHECK(c.withLocators(Locators{100, 200}).documentHash() == b.documentHash());
    CHECK_THROWS_AS(a.withoutLocators(), ModelError);
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
