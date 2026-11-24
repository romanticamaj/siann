// m5b-engine-markers (architecture spec, "siann-model", M5b marker): position and
// cycle markers as document entities of type marker, and format v4.

#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "siann/hash/jcs.hpp"
#include "siann/model/document.hpp"

using siann::hash::formatHash;
using siann::hash::sha256;
using siann::json::Value;
using siann::model::DiffEntry;
using siann::model::Document;
using siann::model::EntityRef;
using siann::model::EntityType;
using siann::model::Marker;
using siann::model::ModelError;

namespace {

Value readFixture(const std::string& relativePath) {
    std::ifstream in(std::string(SIANN_FIXTURES_DIR) + "/" + relativePath, std::ios::binary);
    REQUIRE(in.good());
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return siann::json::parse(buffer.str());
}

Value markersFixture() {
    return readFixture("model/session-document-v4-markers.json");
}

EntityType typeOf(const std::string& type) {
    if (type == "root") return EntityType::root;
    if (type == "media") return EntityType::media;
    if (type == "track") return EntityType::track;
    if (type == "clip") return EntityType::clip;
    if (type == "plugin_slot") return EntityType::plugin_slot;
    if (type == "locators") return EntityType::locators;
    if (type == "master") return EntityType::master;
    if (type == "bus") return EntityType::bus;
    if (type == "send") return EntityType::send;
    if (type == "marker") return EntityType::marker;
    FAIL("unknown entity type " << type);
    return EntityType::root;
}

std::string errorCode(const Value& json) {
    try {
        (void)Document::fromJson(json);
    } catch (const ModelError& error) {
        return error.code();
    }
    return "no error";
}

// The JCS text of a fixture document with the first `from` replaced by `to`.
Value fixtureWith(const std::string& file, const std::string& from, const std::string& to) {
    std::string text = siann::jcs::canonicalize(*readFixture(file).find("document"));
    const auto pos = text.find(from);
    REQUIRE(pos != std::string::npos);
    text.replace(pos, from.size(), to);
    return siann::json::parse(text);
}

Value markersWith(const std::string& from, const std::string& to) {
    return fixtureWith("model/session-document-v4-markers.json", from, to);
}

std::vector<std::string> codes(const Document& doc) {
    std::vector<std::string> out;
    for (const auto& issue : doc.validate()) {
        out.push_back(issue.code);
    }
    return out;
}

Marker positionMarker(std::string id, std::int32_t number, std::int64_t position, std::string name = "") {
    Marker m;
    m.id = std::move(id);
    m.number = number;
    m.name = std::move(name);
    m.position = position;
    return m;
}

Marker cycleMarker(std::string id, std::int32_t number, std::int64_t position, std::int64_t length) {
    Marker m = positionMarker(std::move(id), number, position);
    m.length = length;
    return m;
}

EntityRef ref(const std::string& id) {
    return EntityRef{EntityType::marker, id};
}

constexpr std::int64_t kMax = siann::time::kMaxPositionMagnitude;

}  // namespace

TEST_CASE("The markers fixture gives the Node bridge's hashes and round-trips under JCS", "[model][fixtures][markers]") {
    const Value fixture = markersFixture();
    const Value& original = *fixture.find("document");
    REQUIRE(original.find("schemaVersion")->asString() == "siann.session_document.v4");
    const Document doc = Document::fromJson(original);
    CHECK(doc.validate().empty());
    int markerLeaves = 0;
    for (const Value& leaf : fixture.find("entityHashes")->asArray()) {
        const std::string& type = leaf.find("type")->asString();
        const std::string& id = leaf.find("id")->asString();
        markerLeaves += type == "marker" ? 1 : 0;
        INFO(type << ":" << id);
        CHECK(formatHash(doc.entityHash(EntityRef{typeOf(type), id})) == leaf.find("entityHash")->asString());
    }
    CHECK(markerLeaves == 3);
    CHECK(formatHash(doc.documentHash()) == fixture.find("documentHash")->asString());
    CHECK(siann::model::entityTypeName(EntityType::marker) == "marker");
    // toJson writes v4 and the same JCS text.
    CHECK(siann::jcs::canonicalize(doc.toJson()) == siann::jcs::canonicalize(original));
    CHECK(Document::fromJson(doc.toJson()).documentHash() == doc.documentHash());

    // The shapes.
    const Marker* verse = doc.marker("mrk_verse");
    REQUIRE(verse != nullptr);
    CHECK(verse->number == 1);
    CHECK(verse->name == "Verse \xE8\x81\xB2");
    CHECK(verse->position == 96'000);
    CHECK_FALSE(verse->length.has_value());
    const Marker* loop = doc.marker("mrk_loop");
    REQUIRE(loop != nullptr);
    CHECK(loop->number == 1);
    CHECK(loop->length == std::optional<std::int64_t>(192'000));
    const Marker* blank = doc.marker("mrk-blank");
    REQUIRE(blank != nullptr);
    CHECK(blank->name.empty());
    CHECK(blank->number == 9999);
    CHECK(doc.marker("mrk_none") == nullptr);
    const auto all = doc.allMarkers();
    REQUIRE(all.size() == 3);
    CHECK(all[0]->id == "mrk-blank");
    CHECK(all[1]->id == "mrk_loop");
    CHECK(all[2]->id == "mrk_verse");
    CHECK(siann::jcs::canonicalize(siann::model::toJson(*loop)) ==
          siann::jcs::canonicalize(original.find("markers")->asArray()[1]));
}

TEST_CASE("A document without markers writes v4 without a markers member", "[model][markers]") {
    const Document empty = Document::create("Song", 48'000);
    const Value written = empty.toJson();
    CHECK(written.find("schemaVersion")->asString() == "siann.session_document.v4");
    CHECK(written.find("markers") == nullptr);
    // Removing every marker gives back the v3 document's hash and JSON.
    const Value v3 = readFixture("model/session-document-v3-buses.json");
    Document doc = Document::fromJson(*markersFixture().find("document"));
    for (const char* id : {"mrk-blank", "mrk_loop", "mrk_verse"}) {
        doc = doc.withoutMarker(id);
    }
    CHECK(formatHash(doc.documentHash()) == v3.find("documentHash")->asString());
    CHECK(doc.toJson().find("markers") == nullptr);
}

TEST_CASE("v1, v2 and v3 fixtures read with every entity and document hash unchanged", "[model][markers]") {
    for (const char* file : {"model/session-document-v1.json", "model/session-document-v2.json",
                             "model/session-document-v2-master.json", "model/session-document-v3-buses.json"}) {
        INFO(file);
        const Value fixture = readFixture(file);
        const Document doc = Document::fromJson(*fixture.find("document"));
        CHECK(doc.allMarkers().empty());
        for (const Value& leaf : fixture.find("entityHashes")->asArray()) {
            const std::string& type = leaf.find("type")->asString();
            const std::string& id = leaf.find("id")->asString();
            INFO(type << ":" << id);
            CHECK(formatHash(doc.entityHash(EntityRef{typeOf(type), id})) == leaf.find("entityHash")->asString());
        }
        CHECK(formatHash(doc.documentHash()) == fixture.find("documentHash")->asString());
        const Value written = doc.toJson();
        CHECK(written.find("schemaVersion")->asString() == "siann.session_document.v4");
        CHECK(written.find("markers") == nullptr);
        CHECK(Document::fromJson(written).documentHash() == doc.documentHash());
    }
}

TEST_CASE("A v1, v2 or v3 document that carries markers is unknown_field", "[model][markers]") {
    CHECK(errorCode(markersWith("siann.session_document.v4", "siann.session_document.v3")) == "unknown_field");
    CHECK(errorCode(markersWith("siann.session_document.v4", "siann.session_document.v2")) == "unknown_field");
    CHECK(errorCode(markersWith("siann.session_document.v4", "siann.session_document.v1")) == "unknown_field");
    // An empty markers array is a v4 field too.
    CHECK(errorCode(fixtureWith("model/session-document-v2.json", R"("media":[)", R"("markers":[],"media":[)")) ==
          "unknown_field");
    CHECK(errorCode(fixtureWith("model/session-document-v3-buses.json", R"("media":[)", R"("markers":[],"media":[)")) ==
          "unknown_field");
    CHECK(errorCode(fixtureWith("model/session-document-v3-buses.json", "siann.session_document.v3",
                                "siann.session_document.v4")) == "no error");
    CHECK(errorCode(markersWith("siann.session_document.v4", "siann.session_document.v9")) == "unsupported_version");
    CHECK(errorCode(markersWith("siann.session_document.v4", "siann.session_document.v5")) == "unsupported_version");
}

TEST_CASE("Marker JSON rejects a wrong schema, unknown fields and wrong types", "[model][markers]") {
    CHECK(errorCode(markersWith("siann.entity.marker.v1", "siann.entity.marker.v2")) == "unsupported_version");
    CHECK(errorCode(markersWith(R"("name":"")", R"("extra":1,"name":"")")) == "unknown_field");
    CHECK(errorCode(markersWith(R"("number":9999)", R"("number":"9999")")) == "invalid_field");
    CHECK(errorCode(markersWith(R"("number":9999)", R"("number":1.5)")) == "invalid_field");
    CHECK(errorCode(markersWith(R"("position":"0")", R"("position":0)")) == "invalid_field");
    CHECK(errorCode(markersWith(R"("length":"192000")", R"("length":192000)")) == "invalid_field");
    CHECK(errorCode(markersWith(R"("length":"192000")", R"("length":null)")) == "invalid_field");
    CHECK(errorCode(markersWith(R"("name":"")", R"("name":null)")) == "invalid_field");
    CHECK(errorCode(markersWith(R"("name":"",)", "")) == "missing_field");
    // Ranges are the document's validate() (invalid_marker).
    CHECK(errorCode(markersWith(R"("length":"192000")", R"("length":"0")")) == "invalid_document");
    CHECK(errorCode(markersWith(R"("number":9999)", R"("number":10000)")) == "invalid_document");
    CHECK(errorCode(markersWith(R"("position":"0")", R"("position":"-1")")) == "invalid_document");
    // A duplicate number of one kind.
    CHECK(errorCode(markersWith(R"("number":9999)", R"("number":1)")) == "invalid_document");
}

TEST_CASE("validate() checks marker ranges with invalid_marker", "[model][markers]") {
    const Document doc = Document::create("Song", 48'000);
    const std::vector<std::string> bad{"invalid_marker"};
    // In range.
    CHECK(codes(doc.withMarker(positionMarker("m1", 1, 0))).empty());
    CHECK(codes(doc.withMarker(positionMarker("m1", 9999, kMax))).empty());
    CHECK(codes(doc.withMarker(cycleMarker("m1", 1, 0, 1))).empty());
    CHECK(codes(doc.withMarker(cycleMarker("m1", 1, kMax - 1, 1))).empty());
    CHECK(codes(doc.withMarker(cycleMarker("m1", 1, 0, kMax))).empty());
    // Position below 0 or above 2^42.
    CHECK(codes(doc.withMarker(positionMarker("m1", 1, -1))) == bad);
    CHECK(codes(doc.withMarker(positionMarker("m1", 1, kMax + 1))) == bad);
    // Length "0", negative, or past 2^42 with the position.
    CHECK(codes(doc.withMarker(cycleMarker("m1", 1, 100, 0))) == bad);
    CHECK(codes(doc.withMarker(cycleMarker("m1", 1, 100, -5))) == bad);
    CHECK(codes(doc.withMarker(cycleMarker("m1", 1, kMax, 1))) == bad);
    CHECK(codes(doc.withMarker(cycleMarker("m1", 1, 1, kMax))) == bad);
    CHECK(codes(doc.withMarker(cycleMarker("m1", 1, 1, INT64_MAX))) == bad);
    // Number 0 or 10000.
    CHECK(codes(doc.withMarker(positionMarker("m1", 0, 0))) == bad);
    CHECK(codes(doc.withMarker(positionMarker("m1", 10'000, 0))) == bad);
    CHECK(codes(doc.withMarker(positionMarker("m1", -1, 0))) == bad);
    // Name: 0 to 255 bytes of UTF-8.
    CHECK(codes(doc.withMarker(positionMarker("m1", 1, 0, std::string(255, 'a')))).empty());
    std::string multi;
    for (int i = 0; i < 85; ++i) {
        multi += "\xE8\x81\xB2";
    }
    CHECK(codes(doc.withMarker(positionMarker("m1", 1, 0, multi))).empty());
    CHECK(codes(doc.withMarker(positionMarker("m1", 1, 0, std::string(256, 'a')))) == bad);
    CHECK(codes(doc.withMarker(positionMarker("m1", 1, 0, multi + "a"))) == bad);
    // Malformed UTF-8 never enters a document: the entity's JCS hash refuses it.
    CHECK(siann::model::isValidMarkerName(""));
    CHECK_FALSE(siann::model::isValidMarkerName("bad \xC3\x28 byte"));
    CHECK_FALSE(siann::model::isValidMarkerName("\xED\xA0\x80"));
    CHECK_THROWS(doc.withMarker(positionMarker("m1", 1, 0, "bad \xC3\x28 byte")));
    CHECK_THROWS(doc.withMarker(positionMarker("m1", 1, 0, "\xED\xA0\x80")));
    // An invalid id.
    CHECK(codes(doc.withMarker(positionMarker("m 1", 1, 0))) == std::vector<std::string>{"invalid_id"});
    // The issue names the marker.
    const auto issues = doc.withMarker(positionMarker("m1", 0, 0)).validate();
    REQUIRE(issues.size() == 1);
    CHECK(issues.front().entity == ref("m1"));
}

TEST_CASE("validate() reports a stored display-unsafe marker name as invalid_name", "[model][markers][names]") {
    const Document doc = Document::create("Song", 48'000);
    const std::vector<std::string> unsafe{"Vox \xE2\x80\xAE" "6- ot", "Vox \xE2\x81\xA6" "x", "Vox\xE2\x80\xA8" "Bass",
                                          "Vox\nBass", "Vox\x01", "Vox\xC2\x85"};
    for (const std::string& name : unsafe) {
        INFO(name);
        const Document held = doc.withMarker(positionMarker("m1", 1, 0, name));
        CHECK(codes(held) == std::vector<std::string>{"invalid_name"});
        const auto issues = held.validate();
        REQUIRE(issues.size() == 1);
        CHECK(issues.front().entity == ref("m1"));
    }
    CHECK(codes(doc.withMarker(positionMarker("m1", 1, 0, "שירה 主唱"))).empty());
}

TEST_CASE("Marker numbers are unique per kind (marker_number_taken)", "[model][markers]") {
    const Document doc = Document::create("Song", 48'000)
                             .withMarker(positionMarker("p1", 1, 0))
                             .withMarker(cycleMarker("c1", 1, 0, 48'000));
    // A position marker 1 and a cycle marker 1 coexist.
    CHECK(codes(doc).empty());
    CHECK(codes(doc.withMarker(positionMarker("p2", 2, 10))).empty());
    CHECK(codes(doc.withMarker(cycleMarker("c2", 2, 10, 10))).empty());
    // The same number twice within a kind.
    CHECK(codes(doc.withMarker(positionMarker("p2", 1, 10))) == std::vector<std::string>{"marker_number_taken"});
    CHECK(codes(doc.withMarker(cycleMarker("c2", 1, 10, 10))) == std::vector<std::string>{"marker_number_taken"});
    // A marker turned into the other kind takes that kind's numbering.
    CHECK(codes(doc.withMarker(cycleMarker("p1", 1, 0, 10))) == std::vector<std::string>{"marker_number_taken"});
}

TEST_CASE("Markers are added, modified and removed like any entity", "[model][markers]") {
    const Document a = Document::create("Song", 48'000);
    const Document b = a.withMarker(positionMarker("m1", 1, 100, "Intro"));
    const Document c = b.withMarker(positionMarker("m1", 1, 200, "Intro"));
    const Document d = c.withoutMarker("m1");

    REQUIRE(b.marker("m1") != nullptr);
    CHECK(b.marker("m1")->position == 100);
    CHECK(a.marker("m1") == nullptr);
    CHECK(d.marker("m1") == nullptr);

    auto only = [&](const Document& before, const Document& after, DiffEntry::Change change) {
        const auto changes = diff(before, after);
        REQUIRE(changes.size() == 1);
        CHECK(changes[0].entity == ref("m1"));
        CHECK(changes[0].change == change);
    };
    only(a, b, DiffEntry::Change::added);
    only(b, c, DiffEntry::Change::modified);
    only(c, d, DiffEntry::Change::removed);
    CHECK(diff(b, b.withMarker(positionMarker("m1", 1, 100, "Intro"))).empty());

    CHECK(b.findEntityHash(ref("m1")).has_value());
    CHECK_FALSE(b.findEntityHash(ref("m2")).has_value());
    CHECK(c.entityHash(ref("m1")) == sha256(siann::jcs::canonicalize(siann::model::toJson(*c.marker("m1")))));
    CHECK_THROWS_AS(a.entityHash(ref("m1")), ModelError);
    CHECK_THROWS_AS(a.withoutMarker("m1"), ModelError);
    CHECK(c.sharesEntity(c, ref("m1")));
    CHECK(c.withMarker(positionMarker("m2", 2, 0)).sharesEntity(c, ref("m1")));
    CHECK_FALSE(c.sharesEntity(b, ref("m1")));
    CHECK_FALSE(a.sharesEntity(a, ref("m1")));
    CHECK(b.documentHash() != a.documentHash());
    CHECK(d.documentHash() == a.documentHash());
    // A marker edit leaves the root and every other entity shared.
    CHECK(c.sharesEntity(b, EntityRef{EntityType::root, "root"}));
    CHECK(c.entityHash(EntityRef{EntityType::root, "root"}) == a.entityHash(EntityRef{EntityType::root, "root"}));

    // The JSON shape: length only on a cycle marker, name always present.
    const Value position = siann::model::toJson(positionMarker("m1", 3, 100));
    CHECK(siann::jcs::canonicalize(position) ==
          R"({"id":"m1","name":"","number":3,"position":"100","schema":"siann.entity.marker.v1"})");
    const Value cycle = siann::model::toJson(cycleMarker("m2", 4, 100, 50));
    CHECK(siann::jcs::canonicalize(cycle) ==
          R"({"id":"m2","length":"50","name":"","number":4,"position":"100","schema":"siann.entity.marker.v1"})");
    // A document with markers round-trips with its hash.
    const Document both = c.withMarker(cycleMarker("m2", 1, 0, 10));
    CHECK(Document::fromJson(both.toJson()).documentHash() == both.documentHash());
    const Value bothJson = both.toJson();
    const Value* table = bothJson.find("markers");
    REQUIRE(table != nullptr);
    CHECK(table->asArray().size() == 2);
}
