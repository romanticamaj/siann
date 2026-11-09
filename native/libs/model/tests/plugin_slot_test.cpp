#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>

#include "siann/hash/jcs.hpp"
#include "siann/model/document.hpp"

// M4 plugin slots (architecture spec, "siann-model", M4 plugin_slot).

using siann::hash::formatHash;
using siann::json::Value;
using siann::model::DiffEntry;
using siann::model::Document;
using siann::model::EntityRef;
using siann::model::EntityType;
using siann::model::ModelError;
using siann::model::PluginSlot;
using siann::model::Track;

namespace {

Value readFixture(const std::string& relativePath) {
    std::ifstream in(std::string(SIANN_FIXTURES_DIR) + "/" + relativePath, std::ios::binary);
    REQUIRE(in.good());
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return siann::json::parse(buffer.str());
}

Track track(std::string id) {
    Track t;
    t.id = id;
    t.name = "Track " + id;
    return t;
}

Document addTrack(const Document& doc, Track t) {
    auto root = doc.root();
    root.trackOrder.push_back(t.id);
    return doc.withTrack(std::move(t)).withRoot(std::move(root));
}

PluginSlot slot(std::string id, std::string trackId) {
    PluginSlot p;
    p.id = std::move(id);
    p.trackId = std::move(trackId);
    p.format = "clap";
    p.uid = "com.siann.test-plugin";
    p.name = "Test";
    return p;
}

// A slot must also be listed in its track's inserts.
Document addSlot(const Document& doc, PluginSlot p) {
    Track t = *doc.track(p.trackId);
    t.inserts.push_back(p.id);
    return doc.withPluginSlot(std::move(p)).withTrack(std::move(t));
}

std::vector<std::string> codes(const Document& doc) {
    std::vector<std::string> out;
    for (const auto& issue : doc.validate()) {
        out.push_back(issue.code);
    }
    return out;
}

bool hasCode(const Document& doc, const std::string& code) {
    const auto all = codes(doc);
    return std::find(all.begin(), all.end(), code) != all.end();
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

TEST_CASE("Tracks without inserts keep their M1 entity hashes", "[model][fixtures]") {
    // From the M1 fixture, before plugin slots existed (scripts/generate-model-fixtures.js).
    const Value fixture = readFixture("model/session-document-v1.json");
    const Document doc = Document::fromJson(*fixture.find("document"));
    CHECK(formatHash(doc.entityHash(EntityRef{EntityType::track, "trk-vox"})) ==
          "sha256:9ce55936e8015ecb36ee95f7fd2ac4e615e609185b4f085ff279c227b14dbec1");
    CHECK(formatHash(doc.entityHash(EntityRef{EntityType::track, "trk_drums"})) ==
          "sha256:6dd8852b81ea711a6e90c8ab1528024d52c6543eef3357e4bc36947b758ef426");
    CHECK(doc.track("trk-vox")->inserts.empty());
    CHECK(doc.track("trk_bass")->inserts == std::vector<std::string>{"slt_eq"});
    const PluginSlot* eq = doc.pluginSlot("slt_eq");
    REQUIRE(eq != nullptr);
    CHECK(eq->trackId == "trk_bass");
    CHECK(eq->format == "clap");
    CHECK(eq->uid == "com.siann.test-plugin");
    CHECK(eq->stateBlob.has_value());
    CHECK_FALSE(eq->bypass);
    CHECK(doc.slotsOnTrack("trk_bass") == std::vector<const PluginSlot*>{eq});
    CHECK(doc.slotsOnTrack("trk-vox").empty());
}

TEST_CASE("inserts and pluginSlots are omitted from JSON when empty", "[model]") {
    Document doc = Document::create("Song", 48'000);
    doc = addTrack(doc, track("trk_1"));
    const Value json = doc.toJson();
    CHECK(json.find("pluginSlots") == nullptr);
    CHECK(json.find("tracks")->asArray().front().find("inserts") == nullptr);
    CHECK(Document::fromJson(json).documentHash() == doc.documentHash());

    const Document withSlot = addSlot(doc, slot("slt_1", "trk_1"));
    REQUIRE(withSlot.validate().empty());
    const Value json2 = withSlot.toJson();
    REQUIRE(json2.find("pluginSlots") != nullptr);
    CHECK(json2.find("pluginSlots")->asArray().size() == 1);
    CHECK(json2.find("tracks")->asArray().front().find("inserts") != nullptr);
    const Document back = Document::fromJson(json2);
    CHECK(back.documentHash() == withSlot.documentHash());
    CHECK(back.track("trk_1")->inserts == std::vector<std::string>{"slt_1"});
    CHECK_FALSE(back.pluginSlot("slt_1")->stateBlob.has_value());
    CHECK(siann::jcs::canonicalize(back.toJson()) == siann::jcs::canonicalize(json2));
}

TEST_CASE("Plugin slots are validated against their track", "[model]") {
    Document doc = Document::create("Song", 48'000);
    doc = addTrack(doc, track("trk_1"));
    doc = addTrack(doc, track("trk_2"));
    const Document good = addSlot(doc, slot("slt_1", "trk_1"));
    REQUIRE(good.validate().empty());

    // A slot on a missing track (and so listed by no track).
    CHECK(hasCode(doc.withPluginSlot(slot("slt_1", "trk_missing")), "unknown_track"));
    // A slot that its track does not list.
    CHECK(codes(doc.withPluginSlot(slot("slt_1", "trk_1"))) == std::vector<std::string>{"insert_mismatch"});
    {  // listed twice
        Track t = *good.track("trk_1");
        t.inserts.push_back("slt_1");
        CHECK(codes(good.withTrack(t)) == std::vector<std::string>{"insert_mismatch"});
    }
    {  // listed on another track too
        Track t = *good.track("trk_2");
        t.inserts.push_back("slt_1");
        CHECK(codes(good.withTrack(t)) == std::vector<std::string>{"insert_mismatch"});
    }
    {  // an insert naming no slot
        Track t = *good.track("trk_1");
        t.inserts.push_back("slt_ghost");
        CHECK(codes(good.withTrack(t)) == std::vector<std::string>{"insert_mismatch"});
    }
    PluginSlot p = *good.pluginSlot("slt_1");
    p.stateBlob = "sha256:" + std::string(64, 'a');
    CHECK(codes(good.withPluginSlot(p)).empty());
    p.stateBlob = "sha256:" + std::string(63, 'a');
    CHECK(codes(good.withPluginSlot(p)) == std::vector<std::string>{"invalid_state_blob"});
    p.stateBlob = "sha256:" + std::string(64, 'A');
    CHECK(codes(good.withPluginSlot(p)) == std::vector<std::string>{"invalid_state_blob"});
    p.stateBlob = std::string(64, 'a');
    CHECK(codes(good.withPluginSlot(p)) == std::vector<std::string>{"invalid_state_blob"});
    p.stateBlob = std::nullopt;
    for (const char* format : {"clap", "vst3", "au", "lv2"}) {
        p.format = format;
        CHECK(codes(good.withPluginSlot(p)).empty());
    }
    p.format = "dx";
    CHECK(codes(good.withPluginSlot(p)) == std::vector<std::string>{"invalid_format"});

    Track t = *doc.track("trk_1");
    t.inserts.push_back("bad id");
    CHECK(hasCode(doc.withTrack(t).withPluginSlot(slot("bad id", "trk_1")), "invalid_id"));
}

TEST_CASE("fromJson rejects unknown plugin slot fields and bad values", "[model]") {
    const Value fixture = readFixture("model/session-document-v1.json");
    const std::string text = siann::jcs::canonicalize(*fixture.find("document"));
    auto mutated = [&](const std::string& from, const std::string& to) {
        std::string copy = text;
        const auto pos = copy.find(from);
        REQUIRE(pos != std::string::npos);
        copy.replace(pos, from.size(), to);
        return siann::json::parse(copy);
    };
    CHECK(errorCode(mutated("\"bypass\":false", "\"bypass\":false,\"extra\":1")) == "unknown_field");
    CHECK(errorCode(mutated("\"bypass\":false", "\"bypass\":0")) == "invalid_field");
    CHECK(errorCode(mutated("siann.entity.plugin_slot.v1", "siann.entity.plugin_slot.v2")) == "unsupported_version");
    CHECK(errorCode(mutated("\"inserts\":[\"slt_eq\"]", "\"inserts\":[1]")) == "invalid_field");
    CHECK(errorCode(mutated("\"inserts\":[\"slt_eq\"]", "\"inserts\":[]")) == "invalid_document");
    CHECK(errorCode(mutated("\"stateBlob\":\"sha256:", "\"stateBlob\":7,\"x\":\"")) == "invalid_field");
    CHECK(errorCode(mutated("\"format\":\"clap\"", "\"format\":\"dx\"")) == "invalid_document");
    CHECK(errorCode(mutated("\"trackId\":\"trk_bass\",\"uid\"", "\"trackId\":\"trk_drums\",\"uid\"")) == "invalid_document");
}

TEST_CASE("A null state blob round-trips", "[model]") {
    Document doc = Document::create("Song", 48'000);
    doc = addTrack(doc, track("trk_1"));
    doc = addSlot(doc, slot("slt_1", "trk_1"));
    const Value json = doc.toJson();
    const Value& entity = json.find("pluginSlots")->asArray().front();
    REQUIRE(entity.find("stateBlob") != nullptr);
    CHECK(entity.find("stateBlob")->kind() == Value::Kind::null);
    CHECK(entity.find("schema")->asString() == "siann.entity.plugin_slot.v1");
}

TEST_CASE("Diff and sharing cover plugin slots", "[model]") {
    CHECK(siann::model::entityTypeName(EntityType::plugin_slot) == "plugin_slot");
    CHECK(EntityRef{EntityType::clip, "z"} < EntityRef{EntityType::plugin_slot, "a"});

    Document a = Document::create("Song", 48'000);
    a = addTrack(a, track("trk_1"));
    a = addSlot(a, slot("slt_1", "trk_1"));
    a = addSlot(a, slot("slt_2", "trk_1"));
    REQUIRE(a.validate().empty());

    PluginSlot bypassed = *a.pluginSlot("slt_2");
    bypassed.bypass = true;
    const Document b = a.withPluginSlot(bypassed);
    CHECK(b.sharesEntity(a, EntityRef{EntityType::plugin_slot, "slt_1"}));
    CHECK_FALSE(b.sharesEntity(a, EntityRef{EntityType::plugin_slot, "slt_2"}));
    CHECK(b.sharesEntity(a, EntityRef{EntityType::track, "trk_1"}));
    auto changes = diff(a, b);
    REQUIRE(changes.size() == 1);
    CHECK(changes[0].entity == EntityRef{EntityType::plugin_slot, "slt_2"});
    CHECK(changes[0].change == DiffEntry::Change::modified);
    CHECK(b.findEntityHash(EntityRef{EntityType::plugin_slot, "slt_2"}).has_value());
    CHECK(a.documentHash() != b.documentHash());

    Track t = *b.track("trk_1");
    t.inserts = {"slt_1"};
    const Document c = b.withoutPluginSlot("slt_2").withTrack(t);
    REQUIRE(c.validate().empty());
    changes = diff(b, c);
    REQUIRE(changes.size() == 2);
    CHECK(changes[0].entity == EntityRef{EntityType::track, "trk_1"});
    CHECK(changes[1].entity == EntityRef{EntityType::plugin_slot, "slt_2"});
    CHECK(changes[1].change == DiffEntry::Change::removed);
    CHECK_THROWS_AS(c.withoutPluginSlot("slt_2"), ModelError);

    // Insert order is part of the track's hash.
    Track reordered = *a.track("trk_1");
    reordered.inserts = {"slt_2", "slt_1"};
    CHECK(a.withTrack(reordered).entityHash(EntityRef{EntityType::track, "trk_1"}) !=
          a.entityHash(EntityRef{EntityType::track, "trk_1"}));
}

// m5-plugin-registry: a slot's path is a hint, refused where it enters before any
// library opens (Protocol v0 item 21).
TEST_CASE("pluginPathRefusal names UNC paths and paths inside the bundle", "[model][plugin]") {
    using siann::model::pluginPathRefusal;
    namespace fs = std::filesystem;
    CHECK(pluginPathRefusal(R"(\\server\share\x.clap)") == std::optional<std::string>{"unc_path"});
    CHECK(pluginPathRefusal("//server/share/x.clap") == std::optional<std::string>{"unc_path"});
    CHECK(pluginPathRefusal(R"(\\?\UNC\server\share\x.clap)") == std::optional<std::string>{"unc_path"});
    CHECK(pluginPathRefusal(R"(\/server\share\x.clap)") == std::optional<std::string>{"unc_path"});
    CHECK_FALSE(pluginPathRefusal("").has_value());

    const fs::path bundle = fs::temp_directory_path() / "siann-refusal-test.siann";
    const fs::path normal = fs::temp_directory_path() / "siann-plugins" / "x.clap";
    CHECK_FALSE(pluginPathRefusal(normal.string()).has_value());
    CHECK_FALSE(pluginPathRefusal(normal.string(), bundle).has_value());
    CHECK_FALSE(pluginPathRefusal("", bundle).has_value());
    CHECK(pluginPathRefusal((bundle / "blobs" / "x.clap").string(), bundle) ==
          std::optional<std::string>{"inside_bundle"});
    CHECK(pluginPathRefusal((bundle / "a" / ".." / "x.clap").string(), bundle) ==
          std::optional<std::string>{"inside_bundle"});
    CHECK(pluginPathRefusal(bundle.string(), bundle) == std::optional<std::string>{"inside_bundle"});
    // A sibling whose name starts with the bundle's is not inside it.
    CHECK_FALSE(pluginPathRefusal(bundle.string() + "x/x.clap", bundle).has_value());
    // Out of the bundle and back through `..` is not inside it either.
    CHECK_FALSE(pluginPathRefusal((bundle / ".." / "x.clap").string(), bundle).has_value());
#if defined(_WIN32)
    std::string upper = (bundle / "blobs" / "x.clap").string();
    std::transform(upper.begin(), upper.end(), upper.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    CHECK(pluginPathRefusal(upper, bundle) == std::optional<std::string>{"inside_bundle"});
#endif
}
