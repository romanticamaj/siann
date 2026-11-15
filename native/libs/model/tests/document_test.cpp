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

// A v2 fixture as the engine writes it: format v3 (m5b-engine-buses-sends),
// otherwise the same JCS text, since every v3 field is omitted when empty.
std::string writtenAsV3(const Value& document) {
    std::string text = siann::jcs::canonicalize(document);
    const std::string from = "siann.session_document.v2";
    if (const auto pos = text.find(from); pos != std::string::npos) {
        text.replace(pos, from.size(), "siann.session_document.v3");
    }
    return text;
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
    CHECK(siann::jcs::canonicalize(doc.toJson()) == writtenAsV3(original));
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

    // Written as v3 (m5b-engine-buses-sends), with locators omitted while absent; otherwise the same JSON.
    const Value written = doc.toJson();
    CHECK(written.find("schemaVersion")->asString() == "siann.session_document.v3");
    CHECK(written.find("locators") == nullptr);
    std::string expected = siann::jcs::canonicalize(*v1.find("document"));
    const std::string from = "siann.session_document.v1";
    expected.replace(expected.find(from), from.size(), "siann.session_document.v3");
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

// Follow-up to #123: a name the document stores (the session's, a track's, a
// media's, a plugin slot's) is well-formed UTF-8 without a control character,
// a bidi formatting character or a line or paragraph separator. A document
// that holds one is refused on open (invalid_document, "invalid_name: ..."),
// not repaired: stripping would change the recorded hashes the journal and
// the checkpoint are checked against.
TEST_CASE("Validation refuses display-unsafe names as invalid_name", "[model][names]") {
    Document doc = Document::create("Song", 48'000);
    doc = addTrack(doc, track("trk_1"));
    doc = doc.withMedia(media("med_1"));
    CHECK(codes(doc).empty());

    for (const std::string& bad : {std::string("Vox \xE2\x80\xAE" "6-"), std::string("a\xE2\x81\xA7" "b"),
                                  std::string("a\xE2\x80\xA9" "b"), std::string("a\tb"), std::string("a\xC2\x9B" "b")}) {
        INFO(bad);
        Track t = *doc.track("trk_1");
        t.name = bad;
        CHECK(codes(doc.withTrack(t)) == std::vector<std::string>{"invalid_name"});
        auto root = doc.root();
        root.name = bad;
        CHECK(codes(doc.withRoot(root)) == std::vector<std::string>{"invalid_name"});
        Media m = *doc.media("med_1");
        m.name = bad;
        CHECK(codes(doc.withMedia(m)) == std::vector<std::string>{"invalid_name"});
        CHECK_THROWS_AS(Document::create(bad, 48'000), ModelError);
        siann::model::Bus bus;
        bus.id = "bus_a";
        bus.name = bad;
        auto withBus = doc.root();
        withBus.busOrder.push_back("bus_a");
        CHECK(codes(doc.withBus(bus).withRoot(withBus)) == std::vector<std::string>{"invalid_name"});
    }
    // Malformed UTF-8 never reaches validate: hashing an entity refuses it
    // first (JCS, invalid_utf8), and the commands refuse it as invalid_name.
    Track world = *doc.track("trk_1");
    world.name = "שירה 主唱 🎸";
    CHECK(codes(doc.withTrack(world)).empty());
}

TEST_CASE("Opening a document with a display-unsafe name is invalid_document", "[model][names]") {
    const Value fixture = readFixture("model/session-document-v1.json");
    const std::string text = siann::jcs::canonicalize(*fixture.find("document"));
    auto mutated = [&](const std::string& from, const std::string& to) {
        std::string copy = text;
        const auto pos = copy.find(from);
        REQUIRE(pos != std::string::npos);
        copy.replace(pos, from.size(), to);
        return siann::json::parse(copy);
    };
    auto openMessage = [](const Value& json) -> std::string {
        try {
            (void)Document::fromJson(json);
        } catch (const ModelError& error) {
            return error.code() + " " + error.what();
        }
        return "no error";
    };
    const std::string rlo = "\u202e";
    // A track, the session, a plugin slot and a media name (the v1 fixture's media has none; v2's media-name does).
    for (const auto& [from, to] : std::vector<std::pair<std::string, std::string>>{
             {"\"name\":\"Vox\"", "\"name\":\"Vox" + rlo + "\""},
             {"\"name\":\"Fixture Song", "\"name\":\"" + rlo + "Fixture Song"},
             {"\"name\":\"SIANN Test Plugin\"", "\"name\":\"SIANN \u2066Test Plugin\""},
             {"\"name\":\"Bass\"", "\"name\":\"Bass\u0085\""},
         }) {
        INFO(to);
        const std::string message = openMessage(mutated(from, to));
        CHECK(message.rfind("invalid_document invalid_name: ", 0) == 0);
    }
    const Value named = readFixture("model/session-document-v2-media-name.json");
    std::string mediaText = siann::jcs::canonicalize(*named.find("document"));
    const auto at = mediaText.find("\"format\":\"wav\",\"frames\"");
    REQUIRE(at != std::string::npos);
    const auto nameAt = mediaText.find("\"name\":\"", at);
    REQUIRE(nameAt != std::string::npos);
    mediaText.insert(nameAt + 8, "\u2028");
    CHECK(openMessage(siann::json::parse(mediaText)).rfind("invalid_document invalid_name: ", 0) == 0);
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

// m5b-engine-record: a track's input ({port, channels}, an IoPort of "Channels
// and I/O") is part of the track entity, omitted while absent.
TEST_CASE("A track's input round-trips and is omitted while absent", "[model][input]") {
    Document doc = addTrack(Document::create("Song", 48'000), track("trk_1"));
    // The literal JSON of this track before the input existed, and its hash.
    const std::string before =
        R"({"channels":2,"gainMilliDb":0,"id":"trk_1","kind":"audio","mute":false,"name":"Track trk_1","pan":0,)"
        R"("schema":"siann.entity.track.v1","solo":false})";
    CHECK(siann::jcs::canonicalize(siann::model::toJson(*doc.track("trk_1"))) == before);
    CHECK(doc.entityHash(EntityRef{EntityType::track, "trk_1"}) == sha256(before));

    Track withInput = *doc.track("trk_1");
    withInput.input = siann::model::TrackInput{3, 1};
    const Document recorded = doc.withTrack(withInput);
    CHECK(recorded.validate().empty());
    const std::string json = siann::jcs::canonicalize(siann::model::toJson(*recorded.track("trk_1")));
    CHECK(json.find(R"("input":{"channels":1,"port":3})") != std::string::npos);
    const Document back = Document::fromJson(recorded.toJson());
    REQUIRE(back.track("trk_1")->input.has_value());
    CHECK(*back.track("trk_1")->input == siann::model::TrackInput{3, 1});
    CHECK(back.documentHash() == recorded.documentHash());
    CHECK(recorded.documentHash() != doc.documentHash());

    // Cleared again, the track is byte-identical to before.
    Track cleared = withInput;
    cleared.input.reset();
    CHECK(siann::jcs::canonicalize(siann::model::toJson(cleared)) == before);
}

TEST_CASE("The input fixture gives the Node bridge's hashes and v2 keeps its own", "[model][fixtures][input]") {
    const Value fixture = readFixture("model/session-document-v2-input.json");
    const Document doc = Document::fromJson(*fixture.find("document"));
    CHECK(doc.validate().empty());
    REQUIRE(doc.track("trk-vox")->input.has_value());
    CHECK(doc.track("trk-vox")->input->port == 3);
    CHECK(doc.track("trk-vox")->input->channels == 1);
    CHECK_FALSE(doc.track("trk_bass")->input.has_value());
    for (const Value& leaf : fixture.find("entityHashes")->asArray()) {
        if (leaf.find("type")->asString() == "track") {
            const std::string& id = leaf.find("id")->asString();
            INFO(id);
            CHECK(formatHash(doc.entityHash(EntityRef{EntityType::track, id})) == leaf.find("entityHash")->asString());
        }
    }
    CHECK(formatHash(doc.documentHash()) == fixture.find("documentHash")->asString());
    CHECK(siann::jcs::canonicalize(doc.toJson()) == writtenAsV3(*fixture.find("document")));

    // The pre-feature document reads and writes exactly as before.
    const Value v2 = readFixture("model/session-document-v2.json");
    const Document old = Document::fromJson(*v2.find("document"));
    CHECK(siann::jcs::canonicalize(old.toJson()) == writtenAsV3(*v2.find("document")));
    CHECK(formatHash(old.documentHash()) == v2.find("documentHash")->asString());
}

TEST_CASE("A malformed track input is rejected", "[model][input]") {
    const Value fixture = readFixture("model/session-document-v2-input.json");
    const std::string text = siann::jcs::canonicalize(*fixture.find("document"));
    auto mutated = [&](const std::string& from, const std::string& to) {
        std::string copy = text;
        const auto pos = copy.find(from);
        REQUIRE(pos != std::string::npos);
        copy.replace(pos, from.size(), to);
        return siann::json::parse(copy);
    };
    const std::string input = R"("input":{"channels":1,"port":3})";
    CHECK(errorCode(mutated(input, R"("input":{"channels":3,"port":3})")) != "no error");
    CHECK(errorCode(mutated(input, R"("input":{"channels":1,"port":-1})")) != "no error");
    CHECK(errorCode(mutated(input, R"("input":{"channels":1,"port":3,"x":1})")) == "unknown_field");
    CHECK(errorCode(mutated(input, R"("input":null)")) != "no error");
}

// ---- m5b-engine-project-media: the media entity's optional name -------------

namespace {

EntityType entityTypeOf(const std::string& type) {
    return type == "root"          ? EntityType::root
           : type == "media"       ? EntityType::media
           : type == "track"       ? EntityType::track
           : type == "plugin_slot" ? EntityType::plugin_slot
           : type == "locators"    ? EntityType::locators
                                   : EntityType::clip;
}

// The v2 fixture's document with med_kick's `name` set to the given value.
Value kickWithName(const Value& name) {
    const Value v2 = readFixture("model/session-document-v2.json");
    siann::json::Object out = v2.find("document")->asObject();
    for (auto& [key, value] : out) {
        if (key != "media") {
            continue;
        }
        siann::json::Array media = value.asArray();
        for (Value& entity : media) {
            if (entity.find("id")->asString() == "med_kick") {
                siann::json::Object fields = entity.asObject();
                fields.emplace_back("name", name);
                entity = Value(std::move(fields));
            }
        }
        value = Value(std::move(media));
    }
    return Value(std::move(out));
}

}  // namespace

TEST_CASE("The media-name fixture gives the Node bridge's hashes and round-trips under JCS",
          "[model][fixtures][media]") {
    const Value fixture = readFixture("model/session-document-v2-media-name.json");
    const Value& original = *fixture.find("document");
    const Document doc = Document::fromJson(original);
    CHECK(doc.validate().empty());
    REQUIRE(doc.media("med_kick") != nullptr);
    REQUIRE(doc.media("med_kick")->name.has_value());
    CHECK(*doc.media("med_kick")->name == "kick.wav");
    REQUIRE(doc.media("med_loop")->name.has_value());
    CHECK(*doc.media("med_loop")->name == "Loop \xE8\x81\xB2 44k.flac");
    for (const Value& leaf : fixture.find("entityHashes")->asArray()) {
        const std::string& type = leaf.find("type")->asString();
        const std::string& id = leaf.find("id")->asString();
        INFO(type << ":" << id);
        CHECK(formatHash(doc.entityHash(EntityRef{entityTypeOf(type), id})) == leaf.find("entityHash")->asString());
    }
    CHECK(formatHash(doc.documentHash()) == fixture.find("documentHash")->asString());
    CHECK(siann::jcs::canonicalize(doc.toJson()) == writtenAsV3(original));
}

TEST_CASE("A media without a name serializes as before and keeps the v1 and v2 hashes", "[model][media]") {
    for (const char* file : {"model/session-document-v1.json", "model/session-document-v2.json"}) {
        INFO(file);
        const Value fixture = readFixture(file);
        const Document doc = Document::fromJson(*fixture.find("document"));
        for (const Media* m : doc.allMedia()) {
            CHECK_FALSE(m->name.has_value());
            CHECK(siann::model::toJson(*m).find("name") == nullptr);
        }
        CHECK(formatHash(doc.documentHash()) == fixture.find("documentHash")->asString());
    }
    // Removing the names gives back the unnamed document's hash.
    const Document named =
        Document::fromJson(*readFixture("model/session-document-v2-media-name.json").find("document"));
    const Document plain = Document::fromJson(*readFixture("model/session-document-v2.json").find("document"));
    Media kick = *named.media("med_kick");
    kick.name.reset();
    Media loop = *named.media("med_loop");
    loop.name.reset();
    CHECK(named.withMedia(kick).withMedia(loop).documentHash() == plain.documentHash());
}

TEST_CASE("A media name must be a string of 1 to 255 UTF-8 bytes", "[model][media]") {
    CHECK(errorCode(kickWithName(Value(std::string(255, 'a')))) == "no error");
    // 85 three-byte code points: 255 bytes of multi-byte text.
    std::string multi;
    for (int i = 0; i < 85; ++i) {
        multi += "\xE8\x81\xB2";
    }
    REQUIRE(multi.size() == 255);
    const Document accepted = Document::fromJson(kickWithName(Value(multi)));
    CHECK(*accepted.media("med_kick")->name == multi);

    CHECK(errorCode(kickWithName(Value(std::string()))) == "invalid_field");
    CHECK(errorCode(kickWithName(Value(std::string(256, 'a')))) == "invalid_field");
    CHECK(errorCode(kickWithName(Value(multi + "a"))) == "invalid_field");
    CHECK(errorCode(kickWithName(Value(std::string("bad \xC3\x28 byte")))) == "invalid_field");
    CHECK(errorCode(kickWithName(Value(42))) == "invalid_field");
    CHECK(errorCode(kickWithName(Value(nullptr))) == "invalid_field");
}

// ---- m5b-engine-master: the singleton master entity -------------------------

namespace {

using siann::model::Master;

const EntityRef kMasterRef{EntityType::master, "master"};

EntityType leafType(const std::string& type) {
    return type == "master" ? EntityType::master : entityTypeOf(type);
}

// The master fixture's document text, with the first occurrence of `from` at or
// after the master entity replaced (the schemaVersion precedes it in JCS order,
// so that one is found from the start).
Value masterFixtureWith(const std::string& from, const std::string& to) {
    std::string text = siann::jcs::canonicalize(*readFixture("model/session-document-v2-master.json").find("document"));
    const auto start = from.rfind("siann.session_document", 0) == 0 ? 0 : text.find(R"("master":{)");
    REQUIRE(start != std::string::npos);
    const auto pos = text.find(from, start);
    REQUIRE(pos != std::string::npos);
    text.replace(pos, from.size(), to);
    return siann::json::parse(text);
}

}  // namespace

TEST_CASE("The master fixture gives the Node bridge's hashes and round-trips under JCS", "[model][fixtures][master]") {
    const Value fixture = readFixture("model/session-document-v2-master.json");
    const Value& original = *fixture.find("document");
    const Document doc = Document::fromJson(original);
    CHECK(doc.validate().empty());
    REQUIRE(doc.master() != nullptr);
    CHECK(doc.master()->gain == Gain{-6000});
    bool sawMaster = false;
    for (const Value& leaf : fixture.find("entityHashes")->asArray()) {
        const std::string& type = leaf.find("type")->asString();
        const std::string& id = leaf.find("id")->asString();
        sawMaster = sawMaster || type == "master";
        INFO(type << ":" << id);
        CHECK(formatHash(doc.entityHash(EntityRef{leafType(type), id})) == leaf.find("entityHash")->asString());
    }
    CHECK(sawMaster);
    CHECK(formatHash(doc.documentHash()) == fixture.find("documentHash")->asString());
    CHECK(siann::model::entityTypeName(EntityType::master) == "master");
    CHECK(siann::model::kMasterId == "master");
    CHECK(siann::jcs::canonicalize(doc.toJson()) == writtenAsV3(original));
    CHECK(siann::jcs::canonicalize(siann::model::toJson(*doc.master())) ==
          siann::jcs::canonicalize(*original.find("master")));
    CHECK(Document::fromJson(doc.toJson()).documentHash() == doc.documentHash());
}

TEST_CASE("A v2 document without the master reads with its hash unchanged and writes no master", "[model][master]") {
    const Value v2 = readFixture("model/session-document-v2.json");
    const Document doc = Document::fromJson(*v2.find("document"));
    CHECK(doc.master() == nullptr);
    CHECK_FALSE(doc.findEntityHash(kMasterRef).has_value());
    CHECK(formatHash(doc.documentHash()) == v2.find("documentHash")->asString());
    CHECK(doc.toJson().find("master") == nullptr);
    CHECK(siann::jcs::canonicalize(doc.toJson()) == writtenAsV3(*v2.find("document")));
    // The master fixture minus its master is the v2 document.
    const Document withMaster =
        Document::fromJson(*readFixture("model/session-document-v2-master.json").find("document"));
    CHECK(withMaster.withoutMaster().documentHash() == doc.documentHash());
    CHECK(withMaster.withoutMaster().toJson().find("master") == nullptr);
}

TEST_CASE("The master entity rejects 0 dB, a wrong id or schema and unknown fields in JSON", "[model][master]") {
    CHECK(errorCode(masterFixtureWith(R"("gainMilliDb":-6000)", R"("gainMilliDb":-144000)")) == "no error");
    CHECK(errorCode(masterFixtureWith(R"("gainMilliDb":-6000)", R"("gainMilliDb":24000)")) == "no error");
    CHECK(errorCode(masterFixtureWith(R"("gainMilliDb":-6000)", R"("gainMilliDb":-2147483648)")) == "no error");
    // Present only while the gain is not 0 dB.
    CHECK(errorCode(masterFixtureWith(R"("gainMilliDb":-6000)", R"("gainMilliDb":0)")) == "invalid_document");
    CHECK(errorCode(masterFixtureWith(R"("gainMilliDb":-6000)", R"("gainMilliDb":24001)")) == "invalid_document");
    CHECK(errorCode(masterFixtureWith(R"("gainMilliDb":-6000)", R"("gainMilliDb":-144001)")) == "invalid_document");
    CHECK(errorCode(masterFixtureWith(R"("gainMilliDb":-6000)", R"("gainMilliDb":"-6000")")) == "invalid_field");
    CHECK(errorCode(masterFixtureWith(R"("gainMilliDb":-6000)", R"("gainMilliDb":-6000.5)")) == "invalid_field");
    CHECK(errorCode(masterFixtureWith(R"("id":"master")", R"("id":"main")")) == "invalid_field");
    CHECK(errorCode(masterFixtureWith("siann.entity.master.v1", "siann.entity.master.v2")) == "unsupported_version");
    CHECK(errorCode(masterFixtureWith(R"("gainMilliDb":-6000)", R"("extra":1,"gainMilliDb":-6000)")) ==
          "unknown_field");
    // A v1 document has no master.
    CHECK(errorCode(masterFixtureWith("siann.session_document.v2", "siann.session_document.v1")) == "unknown_field");
}

TEST_CASE("A master gain out of range is invalid_gain on master:master", "[model][master]") {
    const Document doc = Document::create("Song", 48'000);
    CHECK(codes(doc.withMaster(Master{Gain{-144'000}})).empty());
    CHECK(codes(doc.withMaster(Master{Gain{24'000}})).empty());
    CHECK(codes(doc.withMaster(Master{Gain::minusInfinity()})).empty());
    CHECK(codes(doc.withMaster(Master{Gain{24'001}})) == std::vector<std::string>{"invalid_gain"});
    CHECK(codes(doc.withMaster(Master{Gain{-144'001}})) == std::vector<std::string>{"invalid_gain"});
    const auto issues = doc.withMaster(Master{Gain{30'000}}).validate();
    REQUIRE(issues.size() == 1);
    CHECK(issues.front().entity == kMasterRef);
    // A stored master at 0 dB is not a valid document.
    CHECK_FALSE(codes(doc.withMaster(Master{Gain{0}})).empty());
}

TEST_CASE("The master is added, modified and removed like any entity", "[model][master]") {
    const Document a = Document::create("Song", 48'000);
    const Document b = a.withMaster(Master{Gain{-6000}});
    const Document c = b.withMaster(Master{Gain{-3000}});
    const Document d = c.withoutMaster();

    REQUIRE(b.master() != nullptr);
    CHECK(*b.master() == Master{Gain{-6000}});
    CHECK(a.master() == nullptr);
    CHECK(d.master() == nullptr);

    auto only = [&](const Document& before, const Document& after, DiffEntry::Change change) {
        const auto changes = diff(before, after);
        REQUIRE(changes.size() == 1);
        CHECK(changes[0].entity == kMasterRef);
        CHECK(changes[0].change == change);
    };
    only(a, b, DiffEntry::Change::added);
    only(b, c, DiffEntry::Change::modified);
    only(c, d, DiffEntry::Change::removed);
    CHECK(diff(b, b.withMaster(Master{Gain{-6000}})).empty());

    CHECK(b.findEntityHash(kMasterRef).has_value());
    CHECK_FALSE(b.findEntityHash(EntityRef{EntityType::master, "other"}).has_value());
    CHECK(c.entityHash(kMasterRef) == sha256(siann::jcs::canonicalize(siann::model::toJson(*c.master()))));
    CHECK_THROWS_AS(a.entityHash(kMasterRef), ModelError);
    CHECK(c.sharesEntity(c, kMasterRef));
    CHECK(addTrack(c, track("trk_x")).sharesEntity(c, kMasterRef));
    CHECK_FALSE(c.sharesEntity(b, kMasterRef));
    CHECK_FALSE(a.sharesEntity(a, kMasterRef));
    CHECK_FALSE(c.sharesEntity(c, EntityRef{EntityType::master, "other"}));
    CHECK(b.documentHash() != a.documentHash());
    CHECK(d.documentHash() == a.documentHash());
    CHECK(c.withMaster(Master{Gain{-6000}}).documentHash() == b.documentHash());
    CHECK_THROWS_AS(a.withoutMaster(), ModelError);

    // The master and the locators are independent singletons, diffed in type order.
    const Document both = b.withLocators(siann::model::Locators{0, 10});
    const auto changes = diff(a, both);
    REQUIRE(changes.size() == 2);
    CHECK(changes[0].entity == EntityRef{EntityType::locators, "locators"});
    CHECK(changes[1].entity == kMasterRef);
    CHECK(Document::fromJson(both.toJson()).documentHash() == both.documentHash());
}

// ---- m5b-engine-buses-sends: buses, sends and format v3 ----------------------

namespace {

using siann::model::Bus;
using siann::model::PluginSlot;
using siann::model::Send;

EntityType anyType(const std::string& type) {
    if (type == "bus") return EntityType::bus;
    if (type == "send") return EntityType::send;
    if (type == "locators") return EntityType::locators;
    return leafType(type);
}

Value busesFixture() {
    return readFixture("model/session-document-v3-buses.json");
}

// The buses fixture's document text with the first `from` replaced by `to`.
Value busesFixtureWith(const std::string& from, const std::string& to) {
    std::string text = siann::jcs::canonicalize(*busesFixture().find("document"));
    const auto pos = text.find(from);
    REQUIRE(pos != std::string::npos);
    text.replace(pos, from.size(), to);
    return siann::json::parse(text);
}

// The v2 fixture's document text with the first `from` replaced by `to`.
Value v2With(const std::string& from, const std::string& to) {
    std::string text = siann::jcs::canonicalize(*readFixture("model/session-document-v2.json").find("document"));
    const auto pos = text.find(from);
    REQUIRE(pos != std::string::npos);
    text.replace(pos, from.size(), to);
    return siann::json::parse(text);
}

Bus bus(std::string id) {
    Bus b;
    b.id = id;
    b.name = "Bus " + id;
    return b;
}

Send send(std::string id, std::string trackId, std::string busId) {
    Send s;
    s.id = std::move(id);
    s.trackId = std::move(trackId);
    s.busId = std::move(busId);
    return s;
}

// A bus must also be listed in root.busOrder.
Document addBus(const Document& doc, Bus b) {
    auto root = doc.root();
    root.busOrder.push_back(b.id);
    return doc.withBus(std::move(b)).withRoot(std::move(root));
}

// A send must also be listed in its track's sends.
Document addSend(const Document& doc, Send s) {
    Track t = *doc.track(s.trackId);
    t.sends.push_back(s.id);
    return doc.withSend(std::move(s)).withTrack(std::move(t));
}

Document routed() {
    Document doc = Document::create("Song", 48'000);
    doc = addTrack(doc, track("trk_1"));
    doc = addTrack(doc, track("trk_2"));
    doc = addBus(doc, bus("bus_a"));
    doc = addBus(doc, bus("bus_b"));
    doc = addBus(doc, bus("bus_c"));
    return doc;
}

Document withBusOutput(const Document& doc, const std::string& busId, std::optional<std::string> output) {
    Bus b = *doc.bus(busId);
    b.output = std::move(output);
    return doc.withBus(std::move(b));
}

bool allAre(const std::vector<std::string>& found, const std::string& code) {
    return !found.empty() && std::all_of(found.begin(), found.end(), [&](const std::string& c) { return c == code; });
}

}  // namespace

TEST_CASE("The buses fixture gives the Node bridge's hashes and round-trips under JCS", "[model][fixtures][buses]") {
    const Value fixture = busesFixture();
    const Value& original = *fixture.find("document");
    const Document doc = Document::fromJson(original);
    CHECK(doc.validate().empty());
    bool sawBus = false;
    bool sawSend = false;
    for (const Value& leaf : fixture.find("entityHashes")->asArray()) {
        const std::string& type = leaf.find("type")->asString();
        const std::string& id = leaf.find("id")->asString();
        sawBus = sawBus || type == "bus";
        sawSend = sawSend || type == "send";
        INFO(type << ":" << id);
        CHECK(formatHash(doc.entityHash(EntityRef{anyType(type), id})) == leaf.find("entityHash")->asString());
    }
    CHECK(sawBus);
    CHECK(sawSend);
    CHECK(formatHash(doc.documentHash()) == fixture.find("documentHash")->asString());
    CHECK(siann::model::entityTypeName(EntityType::bus) == "bus");
    CHECK(siann::model::entityTypeName(EntityType::send) == "send");
    CHECK(siann::jcs::canonicalize(doc.toJson()) == siann::jcs::canonicalize(original));
    CHECK(Document::fromJson(doc.toJson()).documentHash() == doc.documentHash());

    // The shapes, entity by entity.
    const Bus* drums = doc.bus("bus-drums");
    REQUIRE(drums != nullptr);
    CHECK(drums->name == "Drum Bus");
    CHECK(drums->channels == 2);
    CHECK(drums->gain == Gain{-3000});
    CHECK(drums->inserts == std::vector<std::string>{"slt_comp"});
    CHECK(drums->output == std::optional<std::string>("bus_fx"));
    const Bus* fx = doc.bus("bus_fx");
    REQUIRE(fx != nullptr);
    CHECK(fx->pan == -1000);
    CHECK_FALSE(fx->output.has_value());
    CHECK(fx->inserts.empty());
    const Send* pre = doc.send("snd_drums");
    REQUIRE(pre != nullptr);
    CHECK(pre->trackId == "trk_drums");
    CHECK(pre->busId == "bus_fx");
    CHECK(pre->level == Gain{-12000});
    CHECK(pre->pre);
    CHECK_FALSE(pre->enabled);
    CHECK(doc.track("trk_drums")->output == std::optional<std::string>("bus-drums"));
    CHECK(doc.track("trk_drums")->sends == std::vector<std::string>{"snd_drums"});
    CHECK_FALSE(doc.track("trk_bass")->output.has_value());
    CHECK(doc.root().busOrder == std::vector<std::string>{"bus_fx", "bus-drums"});
    const PluginSlot* comp = doc.pluginSlot("slt_comp");
    REQUIRE(comp != nullptr);
    CHECK(comp->busId == "bus-drums");
    CHECK(comp->trackId.empty());

    // The helpers.
    const auto order = doc.busesInOrder();
    REQUIRE(order.size() == 2);
    CHECK(order[0]->id == "bus_fx");
    CHECK(order[1]->id == "bus-drums");
    const auto onVox = doc.sendsOnTrack("trk-vox");
    REQUIRE(onVox.size() == 1);
    CHECK(onVox[0]->id == "snd_vox");
    CHECK(doc.sendsOnTrack("trk_bass").empty());
    const auto onBus = doc.slotsOnBus("bus-drums");
    REQUIRE(onBus.size() == 1);
    CHECK(onBus[0]->id == "slt_comp");
    CHECK(doc.slotsOnTrack("trk_bass").size() == 1);
    CHECK(doc.allBuses().size() == 2);
    CHECK(doc.allSends().size() == 2);
    CHECK(siann::jcs::canonicalize(siann::model::toJson(*drums)) ==
          siann::jcs::canonicalize(original.find("buses")->asArray()[0]));
}

TEST_CASE("Empty bus and send fields are omitted, so a v2 document keeps every hash", "[model][buses]") {
    const Value v2 = readFixture("model/session-document-v2.json");
    const Document doc = Document::fromJson(*v2.find("document"));
    for (const Value& leaf : v2.find("entityHashes")->asArray()) {
        const std::string& type = leaf.find("type")->asString();
        const std::string& id = leaf.find("id")->asString();
        INFO(type << ":" << id);
        CHECK(formatHash(doc.entityHash(EntityRef{anyType(type), id})) == leaf.find("entityHash")->asString());
    }
    CHECK(formatHash(doc.documentHash()) == v2.find("documentHash")->asString());
    const Value written = doc.toJson();
    CHECK(written.find("schemaVersion")->asString() == "siann.session_document.v3");
    CHECK(written.find("buses") == nullptr);
    CHECK(written.find("sends") == nullptr);
    CHECK(written.find("root")->find("busOrder") == nullptr);
    for (const Value& t : written.find("tracks")->asArray()) {
        CHECK(t.find("sends") == nullptr);
        CHECK(t.find("output") == nullptr);
    }
    for (const Value& s : written.find("pluginSlots")->asArray()) {
        CHECK(s.find("busId") == nullptr);
        CHECK(s.find("trackId") != nullptr);
    }
    // Otherwise the same JSON as the v2 input.
    std::string expected = siann::jcs::canonicalize(*v2.find("document"));
    const std::string from = "siann.session_document.v2";
    expected.replace(expected.find(from), from.size(), "siann.session_document.v3");
    CHECK(siann::jcs::canonicalize(written) == expected);
    CHECK(Document::fromJson(written).documentHash() == doc.documentHash());
    // v1 reads too, with its hash.
    const Value v1 = readFixture("model/session-document-v1.json");
    CHECK(formatHash(Document::fromJson(*v1.find("document")).documentHash()) == v1.find("documentHash")->asString());
}

TEST_CASE("A v1 or v2 document that carries a v3 field is rejected", "[model][buses]") {
    // The buses fixture read as v2 or v1 carries buses, sends and their fields.
    CHECK(errorCode(busesFixtureWith("siann.session_document.v3", "siann.session_document.v2")) == "unknown_field");
    CHECK(errorCode(busesFixtureWith("siann.session_document.v3", "siann.session_document.v1")) == "unknown_field");
    // One field at a time on the v2 fixture.
    CHECK(errorCode(v2With(R"("clips":[)", R"("buses":[],"clips":[)")) == "unknown_field");
    CHECK(errorCode(v2With(R"("tracks":[)", R"("sends":[],"tracks":[)")) == "unknown_field");
    CHECK(errorCode(v2With(R"("trackOrder":[)", R"("busOrder":[],"trackOrder":[)")) == "unknown_field");
    CHECK(errorCode(v2With(R"("solo":false)", R"("sends":[],"solo":false)")) == "unknown_field");
    CHECK(errorCode(v2With(R"("solo":false)", R"("output":{"busId":"bus_x"},"solo":false)")) == "unknown_field");
    CHECK(errorCode(v2With(R"("bypass":false)", R"("busId":"bus_x","bypass":false)")) == "unknown_field");
    // A newer version is unsupported.
    CHECK(errorCode(busesFixtureWith("siann.session_document.v3", "siann.session_document.v4")) ==
          "unsupported_version");
    // The same fields are accepted in v3.
    CHECK(errorCode(busesFixtureWith("siann.session_document.v3", "siann.session_document.v3")) == "no error");
}

TEST_CASE("Bus, send and slot JSON reject malformed fields", "[model][buses]") {
    CHECK(errorCode(busesFixtureWith("siann.entity.bus.v1", "siann.entity.bus.v2")) == "unsupported_version");
    CHECK(errorCode(busesFixtureWith("siann.entity.send.v1", "siann.entity.send.v2")) == "unsupported_version");
    CHECK(errorCode(busesFixtureWith(R"("channels":2,"gainMilliDb":0)", R"("channels":2,"extra":1,"gainMilliDb":0)")) ==
          "unknown_field");
    CHECK(errorCode(busesFixtureWith(R"("output":{"busId":"bus_fx"})", R"("output":{"busId":"bus_fx","x":1})")) ==
          "unknown_field");
    CHECK(errorCode(busesFixtureWith(R"("output":{"busId":"bus_fx"})", R"("output":null)")) == "invalid_field");
    CHECK(errorCode(busesFixtureWith(R"("pre":true)", R"("pre":1)")) == "invalid_field");
    CHECK(errorCode(busesFixtureWith(R"("levelMilliDb":-12000)", R"("levelMilliDb":"-12000")")) == "invalid_field");
    // A slot carries exactly one of trackId or busId.
    CHECK(errorCode(busesFixtureWith(R"("busId":"bus-drums","bypass":true)",
                                     R"("busId":"bus-drums","bypass":true,"trackId":"trk_bass")")) == "invalid_field");
    CHECK(errorCode(busesFixtureWith(R"("busId":"bus-drums","bypass":true)", R"("bypass":true)")) == "invalid_field");
    // Ranges are the document's.
    CHECK(errorCode(busesFixtureWith(R"("gainMilliDb":-3000)", R"("gainMilliDb":24001)")) == "invalid_document");
    CHECK(errorCode(busesFixtureWith(R"("pan":-1000)", R"("pan":10001)")) == "invalid_document");
    CHECK(errorCode(busesFixtureWith(R"("levelMilliDb":-12000)", R"("levelMilliDb":-144001)")) == "invalid_document");
}

TEST_CASE("validate() checks bus and send references, order and ranges", "[model][buses]") {
    const Document doc = routed();
    CHECK(codes(doc).empty());
    CHECK(codes(addSend(doc, send("snd_1", "trk_1", "bus_a"))).empty());

    // A send naming an unknown bus or track.
    CHECK(codes(addSend(doc, send("snd_1", "trk_1", "bus_x"))) == std::vector<std::string>{"unknown_bus"});
    CHECK(codes(doc.withSend(send("snd_1", "trk_x", "bus_a"))) == std::vector<std::string>{"unknown_track"});
    // A send its track does not list, and a track listing a send twice or one it does not own.
    CHECK(codes(doc.withSend(send("snd_1", "trk_1", "bus_a"))) == std::vector<std::string>{"send_mismatch"});
    {
        const Document twice = addSend(doc, send("snd_1", "trk_1", "bus_a"));
        Track t = *twice.track("trk_1");
        t.sends.push_back("snd_1");
        CHECK(codes(twice.withTrack(t)) == std::vector<std::string>{"send_mismatch"});
        Track other = *twice.track("trk_2");
        other.sends.push_back("snd_1");
        CHECK(codes(twice.withTrack(other)) == std::vector<std::string>{"send_mismatch"});
    }
    // Outputs naming an unknown bus.
    {
        Track t = *doc.track("trk_1");
        t.output = "bus_x";
        CHECK(codes(doc.withTrack(t)) == std::vector<std::string>{"unknown_bus"});
        t.output = "bus_a";
        CHECK(codes(doc.withTrack(t)).empty());
        CHECK(codes(withBusOutput(doc, "bus_a", "bus_x")) == std::vector<std::string>{"unknown_bus"});
    }
    // busOrder: a duplicate, a missing bus, an unknown id.
    {
        auto root = doc.root();
        root.busOrder.push_back("bus_a");
        CHECK(codes(doc.withRoot(root)) == std::vector<std::string>{"bus_order_mismatch"});
        root = doc.root();
        root.busOrder.pop_back();
        CHECK(codes(doc.withRoot(root)) == std::vector<std::string>{"bus_order_mismatch"});
        root = doc.root();
        root.busOrder.back() = "bus_x";
        CHECK(codes(doc.withRoot(root)) == std::vector<std::string>{"bus_order_mismatch"});
    }
    // Ranges.
    {
        Bus b = *doc.bus("bus_a");
        b.gain = Gain{24'001};
        CHECK(codes(doc.withBus(b)) == std::vector<std::string>{"invalid_gain"});
        b.gain = Gain::minusInfinity();
        CHECK(codes(doc.withBus(b)).empty());
        b.pan = -10'001;
        CHECK(codes(doc.withBus(b)) == std::vector<std::string>{"invalid_pan"});
        b.pan = 0;
        b.channels = 1;
        CHECK(codes(doc.withBus(b)) == std::vector<std::string>{"invalid_channels"});
        Send s = send("snd_1", "trk_1", "bus_a");
        s.level = Gain{-144'001};
        CHECK(codes(addSend(doc, s)) == std::vector<std::string>{"invalid_gain"});
        s.level = Gain::minusInfinity();
        CHECK(codes(addSend(doc, s)).empty());
    }
    // A slot carries exactly one owner.
    {
        PluginSlot slot;
        slot.id = "slt_1";
        slot.format = "clap";
        slot.uid = "x";
        slot.busId = "bus_a";
        Bus b = *doc.bus("bus_a");
        b.inserts.push_back("slt_1");
        const Document onBus = doc.withPluginSlot(slot).withBus(b);
        CHECK(codes(onBus).empty());
        slot.trackId = "trk_1";
        CHECK(codes(onBus.withPluginSlot(slot)) == std::vector<std::string>{"invalid_field"});
        slot.trackId.clear();
        slot.busId.clear();
        const auto neither = codes(onBus.withPluginSlot(slot));
        CHECK(std::find(neither.begin(), neither.end(), "invalid_field") != neither.end());
        // A bus listing a slot it does not own, a slot on an unknown bus.
        slot.busId = "bus_b";
        CHECK_FALSE(codes(onBus.withPluginSlot(slot)).empty());
        slot.busId = "bus_x";
        CHECK_FALSE(codes(doc.withPluginSlot(slot)).empty());
    }
}

TEST_CASE("A cyclic bus output chain is routing_cycle", "[model][buses]") {
    const Document doc = routed();
    // A chain is fine.
    CHECK(codes(withBusOutput(withBusOutput(doc, "bus_a", "bus_b"), "bus_b", "bus_c")).empty());
    // Self, a 2-cycle and a 3-cycle.
    CHECK(allAre(codes(withBusOutput(doc, "bus_a", "bus_a")), "routing_cycle"));
    CHECK(allAre(codes(withBusOutput(withBusOutput(doc, "bus_a", "bus_b"), "bus_b", "bus_a")), "routing_cycle"));
    CHECK(allAre(codes(withBusOutput(withBusOutput(withBusOutput(doc, "bus_a", "bus_b"), "bus_b", "bus_c"), "bus_c",
                                     "bus_a")),
                 "routing_cycle"));
    // A bus feeding into a cycle is not itself flagged as the cycle's member, but the document is invalid.
    CHECK_FALSE(codes(withBusOutput(withBusOutput(withBusOutput(doc, "bus_a", "bus_b"), "bus_b", "bus_c"), "bus_c",
                                    "bus_b"))
                    .empty());
    // And the JSON reader rejects it.
    CHECK(errorCode(withBusOutput(doc, "bus_a", "bus_a").toJson()) == "invalid_document");
}

TEST_CASE("Buses and sends are added, modified and removed like any entity", "[model][buses]") {
    const Document a = routed();
    const Document b = addSend(a, send("snd_1", "trk_1", "bus_a"));
    const auto changes = diff(a, b);
    REQUIRE(changes.size() == 2);
    CHECK(changes[0].entity == EntityRef{EntityType::track, "trk_1"});
    CHECK(changes[1].entity == EntityRef{EntityType::send, "snd_1"});
    CHECK(changes[1].change == DiffEntry::Change::added);
    const EntityRef busRef{EntityType::bus, "bus_a"};
    const Document c = withBusOutput(b, "bus_a", "bus_b");
    const auto modified = diff(b, c);
    REQUIRE(modified.size() == 1);
    CHECK(modified[0].entity == busRef);
    CHECK(modified[0].change == DiffEntry::Change::modified);
    CHECK(c.entityHash(busRef) == sha256(siann::jcs::canonicalize(siann::model::toJson(*c.bus("bus_a")))));
    CHECK(c.sharesEntity(b, EntityRef{EntityType::send, "snd_1"}));
    CHECK_FALSE(c.sharesEntity(b, busRef));
    CHECK(c.sharesEntity(b, EntityRef{EntityType::bus, "bus_b"}));
    const Document d = c.withoutSend("snd_1");
    CHECK(d.send("snd_1") == nullptr);
    CHECK(diff(c, d).back().change == DiffEntry::Change::removed);
    CHECK_THROWS_AS(d.withoutSend("snd_1"), ModelError);
    auto root = a.root();
    root.busOrder.erase(root.busOrder.begin());
    const Document e = a.withoutBus("bus_a").withRoot(root);
    CHECK(codes(e).empty());
    CHECK(e.bus("bus_a") == nullptr);
    CHECK_THROWS_AS(e.withoutBus("bus_a"), ModelError);
    CHECK(Document::fromJson(c.toJson()).documentHash() == c.documentHash());
    // Removing what was added gives the same document hash.
    Track t = *b.track("trk_1");
    t.sends.clear();
    CHECK(b.withoutSend("snd_1").withTrack(t).documentHash() == a.documentHash());
}

// ---- m5b-engine-clip-fades: optional fadeIn and fadeOut on a clip ------------

namespace {

using siann::model::Fade;
using siann::model::FadeCurve;

// A v2 document written before fades existed, as literal text, with the clip's
// entity hash and the document hash computed by the Node bridge's src/hash.
constexpr const char* kPreFadeDocument =
    R"({"schemaVersion":"siann.session_document.v2","root":{"schema":"siann.entity.root.v1","id":"root",)"
    R"("name":"Old","sampleRate":48000,"tempo":[{"ticks":"0","milliBpm":120000}],"trackOrder":["trk_1"]},)"
    R"("media":[{"schema":"siann.entity.media.v1","id":"med_1","contentHash":)"
    R"("sha256:abababababababababababababababababababababababababababababababab","format":"wav","channels":2,)"
    R"("sampleRate":48000,"frames":"48000"}],"tracks":[{"schema":"siann.entity.track.v1","id":"trk_1",)"
    R"("name":"Drums","kind":"audio","channels":2,"gainMilliDb":0,"pan":0,"mute":false,"solo":false}],)"
    R"("clips":[{"schema":"siann.entity.clip.v1","id":"clp_old","trackId":"trk_1","mediaId":"med_1",)"
    R"("position":{"domain":"audio","value":"1000"},"sourceStart":"0","length":"24000","gainMilliDb":-3000}]})";
constexpr const char* kPreFadeClip =
    R"({"schema":"siann.entity.clip.v1","id":"clp_old","trackId":"trk_1","mediaId":"med_1",)"
    R"("position":{"domain":"audio","value":"1000"},"sourceStart":"0","length":"24000","gainMilliDb":-3000})";
constexpr const char* kPreFadeClipHash = "sha256:ab34d227f4a633fe90e343370f2cc0b920136fb80ecb14dc8cbe2a2e266a233b";
constexpr const char* kPreFadeDocumentHash = "sha256:be8f0096dba523f6a66c79e771dbddaa390faf5f351f57a5d965c3df51811bbc";

const EntityRef kOldClip{EntityType::clip, "clp_old"};

// The pre-fade document with clp_old's closing `"gainMilliDb":-3000}` replaced.
Value preFadeWith(const std::string& tail) {
    std::string text = kPreFadeDocument;
    const std::string from = R"("gainMilliDb":-3000})";
    const auto pos = text.find(from);
    REQUIRE(pos != std::string::npos);
    text.replace(pos, from.size(), R"("gainMilliDb":-3000)" + tail + "}");
    return siann::json::parse(text);
}

}  // namespace

TEST_CASE("A clip without fades keeps its literal pre-fade JSON and hash", "[model][fades]") {
    const Document doc = Document::fromJson(siann::json::parse(kPreFadeDocument));
    const Clip* c = doc.clip("clp_old");
    REQUIRE(c != nullptr);
    CHECK(c->fadeIn == Fade{});
    CHECK(c->fadeOut == Fade{});
    CHECK(formatHash(doc.entityHash(kOldClip)) == kPreFadeClipHash);
    CHECK(formatHash(doc.documentHash()) == kPreFadeDocumentHash);
    CHECK(siann::jcs::canonicalize(siann::model::toJson(*c)) ==
          siann::jcs::canonicalize(siann::json::parse(kPreFadeClip)));

    // Both lengths 0 (whatever the curve) write no fade key and keep the hash.
    Clip zero = *c;
    zero.fadeIn = Fade{0, FadeCurve::equal_power};
    zero.fadeOut = Fade{0, FadeCurve::linear};
    const Value json = siann::model::toJson(zero);
    CHECK(json.find("fadeIn") == nullptr);
    CHECK(json.find("fadeOut") == nullptr);
    const Document again = doc.withClip(zero);
    CHECK(again.clip("clp_old")->fadeIn == Fade{});  // normalised to linear
    CHECK(*again.clip("clp_old") == *c);
    CHECK(formatHash(again.entityHash(kOldClip)) == kPreFadeClipHash);
    CHECK(again.documentHash() == doc.documentHash());

    // The earlier fixtures keep their hashes.
    for (const char* name : {"model/session-document-v1.json", "model/session-document-v2.json",
                             "model/session-document-v2-input.json", "model/session-document-v2-media-name.json"}) {
        INFO(name);
        const Value fixture = readFixture(name);
        const Document d = Document::fromJson(*fixture.find("document"));
        CHECK(formatHash(d.documentHash()) == fixture.find("documentHash")->asString());
        CHECK(siann::jcs::canonicalize(d.toJson()).find("fade") == std::string::npos);
    }
}

TEST_CASE("The fades fixture round-trips with the Node bridge's hashes", "[model][fixtures][fades]") {
    const Value fixture = readFixture("model/session-document-v2-fades.json");
    const Value& original = *fixture.find("document");
    const Document doc = Document::fromJson(original);
    CHECK(doc.validate().empty());
    for (const Value& leaf : fixture.find("entityHashes")->asArray()) {
        const std::string& type = leaf.find("type")->asString();
        const std::string& id = leaf.find("id")->asString();
        INFO(type << ":" << id);
        CHECK(formatHash(doc.entityHash(EntityRef{leafType(type), id})) == leaf.find("entityHash")->asString());
    }
    CHECK(formatHash(doc.documentHash()) == fixture.find("documentHash")->asString());
    // Written as v3 (m5b-engine-buses-sends writes every document in format v3);
    // otherwise the same JSON, fades included.
    std::string expected = siann::jcs::canonicalize(original);
    const std::string from = "siann.session_document.v2";
    expected.replace(expected.find(from), from.size(), "siann.session_document.v3");
    CHECK(siann::jcs::canonicalize(doc.toJson()) == expected);
    CHECK(Document::fromJson(doc.toJson()).documentHash() == doc.documentHash());

    REQUIRE(doc.clip("clp_1") != nullptr);
    CHECK(doc.clip("clp_1")->fadeIn == Fade{480, FadeCurve::linear});
    CHECK(doc.clip("clp_1")->fadeOut == Fade{960, FadeCurve::equal_power});
    CHECK(doc.clip("clp_2")->fadeIn == Fade{48'000, FadeCurve::equal_power});
    CHECK(doc.clip("clp_2")->fadeOut == Fade{});
    CHECK(doc.clip("clp_3")->fadeIn == Fade{});
    CHECK(doc.clip("clp_3")->fadeOut == Fade{});

    // Removing the fades gives the v2 fixture's clip hashes.
    const Value v2 = readFixture("model/session-document-v2.json");
    const Document plain = Document::fromJson(*v2.find("document"));
    Clip bare = *doc.clip("clp_1");
    bare.fadeIn = Fade{};
    bare.fadeOut = Fade{};
    CHECK(doc.withClip(bare).entityHash(EntityRef{EntityType::clip, "clp_1"}) ==
          plain.entityHash(EntityRef{EntityType::clip, "clp_1"}));
}

TEST_CASE("A malformed fade is rejected when the clip is read", "[model][fades]") {
    CHECK(errorCode(preFadeWith(R"(,"fadeIn":{"length":"480","curve":"linear"})")) == "no error");
    CHECK(errorCode(preFadeWith(R"(,"fadeOut":{"length":"1","curve":"equal_power"})")) == "no error");
    // Length 0 is written as no field, so "0" present is not canonical.
    CHECK(errorCode(preFadeWith(R"(,"fadeIn":{"length":"0","curve":"linear"})")) == "invalid_field");
    CHECK(errorCode(preFadeWith(R"(,"fadeIn":{"length":"-480","curve":"linear"})")) == "invalid_field");
    CHECK(errorCode(preFadeWith(R"(,"fadeIn":{"length":480,"curve":"linear"})")) == "invalid_field");
    CHECK(errorCode(preFadeWith(R"(,"fadeIn":{"length":"0480","curve":"linear"})")) == "invalid_field");
    CHECK(errorCode(preFadeWith(R"(,"fadeIn":{"length":"480","curve":"log"})")) == "invalid_field");
    CHECK(errorCode(preFadeWith(R"(,"fadeIn":{"length":"480"})")) == "missing_field");
    CHECK(errorCode(preFadeWith(R"(,"fadeIn":{"length":"480","curve":"linear","shape":1})")) == "unknown_field");
    CHECK(errorCode(preFadeWith(R"(,"fadeIn":null)")) == "invalid_field");
    // The two fades may meet (24000 frames) but not overlap.
    CHECK(errorCode(preFadeWith(R"(,"fadeIn":{"length":"12000","curve":"linear"},)"
                                R"("fadeOut":{"length":"12000","curve":"linear"})")) == "no error");
    CHECK(errorCode(preFadeWith(R"(,"fadeIn":{"length":"12000","curve":"linear"},)"
                                R"("fadeOut":{"length":"12001","curve":"linear"})")) == "invalid_document");
}

TEST_CASE("validate reports invalid_fade for a negative fade or fades longer than the clip", "[model][fades]") {
    const Document doc = Document::fromJson(siann::json::parse(kPreFadeDocument));
    Clip c = *doc.clip("clp_old");
    c.fadeIn = Fade{24'000, FadeCurve::linear};
    CHECK(codes(doc.withClip(c)).empty());
    c.fadeOut = Fade{1, FadeCurve::linear};
    CHECK(codes(doc.withClip(c)) == std::vector<std::string>{"invalid_fade"});
    c.fadeIn = Fade{-1, FadeCurve::linear};
    c.fadeOut = Fade{};
    CHECK(codes(doc.withClip(c)) == std::vector<std::string>{"invalid_fade"});
    const auto issues = doc.withClip(c).validate();
    REQUIRE(issues.size() == 1);
    CHECK(issues[0].entity == kOldClip);
}
