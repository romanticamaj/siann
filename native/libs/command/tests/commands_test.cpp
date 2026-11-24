#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "siann/command/command.hpp"

using siann::command::Command;
using siann::command::CommandError;
using siann::command::DeclaredEffects;
using siann::command::checkDeclaredEffects;
using siann::command::commandNames;
using siann::command::prepare;
using siann::command::prepareTransaction;
using siann::model::Document;
using siann::model::EntityRef;
using siann::model::EntityType;

namespace {

Command cmd(const std::string& json) {
    return Command::fromJson(siann::json::parse(json));
}

std::string errorCode(const Document& doc, const std::string& json) {
    try {
        (void)prepare(doc, cmd(json));
    } catch (const CommandError& error) {
        return error.code();
    }
    return "no error";
}

const std::string kHash = "sha256:" + std::string(64, 'a');

Document base() {
    Document doc = Document::create("Song", 48'000);
    doc = prepare(doc, cmd(R"({"op":"track.add","trackId":"trk_1","name":"Drums","channels":2})")).result;
    doc = prepare(doc, cmd(R"({"op":"media.add","mediaId":"med_1","contentHash":")" + kHash +
                           R"(","format":"wav","channels":2,"sampleRate":48000,"frames":"48000"})"))
              .result;
    return doc;
}

EntityRef ref(EntityType type, std::string id) {
    return EntityRef{type, std::move(id)};
}

}  // namespace

TEST_CASE("track.add appends a track and declares track and root", "[command]") {
    const Document doc = Document::create("Song", 48'000);
    const auto prepared = prepare(doc, cmd(R"({"op":"track.add","trackId":"trk_1","name":"Drums","channels":2})"));
    CHECK(prepared.effects == DeclaredEffects{ref(EntityType::root, "root"), ref(EntityType::track, "trk_1")});
    REQUIRE(prepared.result.track("trk_1") != nullptr);
    CHECK(prepared.result.track("trk_1")->name == "Drums");
    CHECK(prepared.result.root().trackOrder == std::vector<std::string>{"trk_1"});
    CHECK(doc.track("trk_1") == nullptr);  // the input document is unchanged
}

TEST_CASE("track.add honours index and rejects duplicates", "[command]") {
    Document doc = base();
    doc = prepare(doc, cmd(R"({"op":"track.add","trackId":"trk_0","name":"First","channels":1,"index":0})")).result;
    CHECK(doc.root().trackOrder == std::vector<std::string>{"trk_0", "trk_1"});
    CHECK(errorCode(doc, R"({"op":"track.add","trackId":"trk_1","name":"Again","channels":2})") == "already_exists");
    CHECK(errorCode(doc, R"({"op":"track.add","trackId":"trk_9","name":"X","channels":2,"index":3})") ==
          "invalid_params");
}

TEST_CASE("Mixer commands change one field", "[command]") {
    const Document doc = base();
    const Document gained = prepare(doc, cmd(R"({"op":"track.set_gain","trackId":"trk_1","gainMilliDb":-6000})")).result;
    CHECK(gained.track("trk_1")->gain.milliDb == -6'000);
    const Document silent =
        prepare(doc, cmd(R"({"op":"track.set_gain","trackId":"trk_1","gainMilliDb":-2147483648})")).result;
    CHECK(silent.track("trk_1")->gain.isMinusInfinity());
    CHECK(prepare(doc, cmd(R"({"op":"track.set_pan","trackId":"trk_1","pan":-10000})")).result.track("trk_1")->pan ==
          -10'000);
    CHECK(prepare(doc, cmd(R"({"op":"track.set_mute","trackId":"trk_1","mute":true})")).result.track("trk_1")->mute);
    CHECK(prepare(doc, cmd(R"({"op":"track.set_solo","trackId":"trk_1","solo":true})")).result.track("trk_1")->solo);
    CHECK(prepare(doc, cmd(R"({"op":"track.rename","trackId":"trk_1","name":"Kit"})")).result.track("trk_1")->name ==
          "Kit");

    CHECK(errorCode(doc, R"({"op":"track.set_gain","trackId":"trk_1","gainMilliDb":30000})") == "invalid_gain");
    CHECK(errorCode(doc, R"({"op":"track.set_pan","trackId":"trk_1","pan":20000})") == "invalid_pan");
    CHECK(errorCode(doc, R"({"op":"track.set_gain","trackId":"trk_x","gainMilliDb":0})") == "not_found");
}

TEST_CASE("Clips are placed, moved, trimmed and removed", "[command]") {
    Document doc = base();
    const auto placed = prepare(doc, cmd(R"({"op":"clip.place","clipId":"clp_1","trackId":"trk_1","mediaId":"med_1",
        "position":{"domain":"audio","value":"96000"},"sourceStart":"0","length":"48000"})"));
    CHECK(placed.effects == DeclaredEffects{ref(EntityType::clip, "clp_1")});
    doc = placed.result;
    CHECK(doc.clip("clp_1")->position.value == 96'000);
    CHECK(doc.clip("clp_1")->gain.milliDb == 0);

    doc = prepare(doc, cmd(R"({"op":"clip.move","clipId":"clp_1","position":{"domain":"music","value":"3840"}})")).result;
    CHECK(doc.clip("clp_1")->position == siann::time::Position::music(3'840));
    doc = prepare(doc, cmd(R"({"op":"clip.trim","clipId":"clp_1","sourceStart":"1000","length":"47000"})")).result;
    CHECK(doc.clip("clp_1")->sourceStart == 1'000);
    CHECK(doc.clip("clp_1")->length == 47'000);
    doc = prepare(doc, cmd(R"({"op":"clip.set_gain","clipId":"clp_1","gainMilliDb":-1500})")).result;
    CHECK(doc.clip("clp_1")->gain.milliDb == -1'500);

    CHECK(errorCode(doc, R"({"op":"clip.trim","clipId":"clp_1","sourceStart":"1001","length":"47000"})") ==
          "clip_exceeds_media");
    CHECK(errorCode(doc, R"({"op":"clip.place","clipId":"clp_1","trackId":"trk_1","mediaId":"med_1",
        "position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"10"})") == "already_exists");
    CHECK(errorCode(doc, R"({"op":"clip.place","clipId":"clp_2","trackId":"trk_9","mediaId":"med_1",
        "position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"10"})") == "not_found");

    const auto removed = prepare(doc, cmd(R"({"op":"clip.remove","clipId":"clp_1"})"));
    CHECK(removed.result.clip("clp_1") == nullptr);
    CHECK(errorCode(removed.result, R"({"op":"clip.remove","clipId":"clp_1"})") == "not_found");
}

TEST_CASE("track.remove cascades to its clips and declares them", "[command]") {
    Document doc = base();
    doc = prepare(doc, cmd(R"({"op":"clip.place","clipId":"clp_1","trackId":"trk_1","mediaId":"med_1",
        "position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"100"})")).result;
    doc = prepare(doc, cmd(R"({"op":"clip.place","clipId":"clp_2","trackId":"trk_1","mediaId":"med_1",
        "position":{"domain":"audio","value":"200"},"sourceStart":"0","length":"100"})")).result;
    const auto removed = prepare(doc, cmd(R"({"op":"track.remove","trackId":"trk_1"})"));
    CHECK(removed.effects == DeclaredEffects{ref(EntityType::root, "root"), ref(EntityType::track, "trk_1"),
                                             ref(EntityType::clip, "clp_1"), ref(EntityType::clip, "clp_2")});
    CHECK(removed.result.track("trk_1") == nullptr);
    CHECK(removed.result.clipCount() == 0);
    CHECK(removed.result.root().trackOrder.empty());
}

namespace {

std::string insertJson(const std::string& slotId, const std::string& trackId, int index,
                       const std::string& stateBlob = "null") {
    return R"({"op":"plugin.insert","trackId":")" + trackId + R"(","index":)" + std::to_string(index) +
           R"(,"slotId":")" + slotId +
           R"(","descriptor":{"format":"clap","uid":"com.siann.test-plugin","name":"Test","path":"/p/t.clap"},"stateBlob":)" +
           stateBlob + "}";
}

}  // namespace

TEST_CASE("plugin.insert adds a slot at an index that clamps to the end", "[command][plugin]") {
    const Document doc = base();
    const auto first = prepare(doc, cmd(insertJson("slt_1", "trk_1", 0, "\"" + kHash + "\"")));
    CHECK(first.effects == DeclaredEffects{ref(EntityType::track, "trk_1"), ref(EntityType::plugin_slot, "slt_1")});
    const auto* slot = first.result.pluginSlot("slt_1");
    REQUIRE(slot != nullptr);
    CHECK(slot->trackId == "trk_1");
    CHECK(slot->format == "clap");
    CHECK(slot->uid == "com.siann.test-plugin");
    CHECK(slot->name == "Test");
    CHECK(slot->path == "/p/t.clap");
    CHECK(slot->stateBlob == std::optional<std::string>{kHash});
    CHECK_FALSE(slot->bypass);
    CHECK(first.result.track("trk_1")->inserts == std::vector<std::string>{"slt_1"});

    Document doc2 = prepare(first.result, cmd(insertJson("slt_2", "trk_1", 99))).result;
    CHECK(doc2.track("trk_1")->inserts == std::vector<std::string>{"slt_1", "slt_2"});
    doc2 = prepare(doc2, cmd(insertJson("slt_0", "trk_1", 0))).result;
    CHECK(doc2.track("trk_1")->inserts == std::vector<std::string>{"slt_0", "slt_1", "slt_2"});
    CHECK_FALSE(doc2.pluginSlot("slt_2")->stateBlob.has_value());

    // name and path are optional in the descriptor.
    const auto bare = prepare(doc, cmd(R"({"op":"plugin.insert","trackId":"trk_1","index":0,"slotId":"slt_9",
        "descriptor":{"format":"vst3","uid":"ABCD"},"stateBlob":null})"));
    CHECK(bare.result.pluginSlot("slt_9")->name.empty());
    CHECK(bare.result.pluginSlot("slt_9")->path.empty());
}

TEST_CASE("plugin.insert rejects used ids, missing tracks and bad parameters", "[command][plugin]") {
    const Document doc = prepare(base(), cmd(insertJson("slt_1", "trk_1", 0))).result;
    CHECK(errorCode(doc, insertJson("slt_1", "trk_1", 0)) == "already_exists");
    CHECK(errorCode(doc, insertJson("slt_2", "trk_9", 0)) == "not_found");
    CHECK(errorCode(doc, insertJson("slt_2", "trk_1", -1)) == "invalid_params");
    CHECK(errorCode(doc, insertJson("slt_2", "trk_1", 0, "\"sha256:abc\"")) == "invalid_state_blob");
    CHECK(errorCode(doc, insertJson("slt_2", "trk_1", 0, "7")) == "invalid_params");
    CHECK(errorCode(doc, insertJson("bad id", "trk_1", 0)) == "invalid_id");
    CHECK(errorCode(doc, R"({"op":"plugin.insert","trackId":"trk_1","index":0,"slotId":"slt_2",
        "descriptor":{"format":"dx","uid":"u"},"stateBlob":null})") == "invalid_format");
    CHECK(errorCode(doc, R"({"op":"plugin.insert","trackId":"trk_1","index":0,"slotId":"slt_2",
        "descriptor":{"format":"clap","uid":"u","extra":1},"stateBlob":null})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"plugin.insert","trackId":"trk_1","index":0,"slotId":"slt_2",
        "descriptor":{"format":"clap"},"stateBlob":null})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"plugin.insert","trackId":"trk_1","index":0,"slotId":"slt_2",
        "descriptor":{"format":"clap","uid":"u"}})") == "invalid_params");
}

// m5-plugin-registry: a pure command has no bundle in reach, so it refuses the UNC
// forms only (Protocol v0 item 21).
TEST_CASE("plugin.insert rejects a UNC path", "[command][plugin]") {
    const Document doc = base();
    for (const std::string path : {R"(\\\\server\\share\\x.clap)", "//server/share/x.clap",
                                   R"(\\\\?\\UNC\\server\\share\\x.clap)"}) {
        CHECK(errorCode(doc, R"({"op":"plugin.insert","trackId":"trk_1","index":0,"slotId":"slt_2",
            "descriptor":{"format":"clap","uid":"u","path":")" + path + R"("},"stateBlob":null})") ==
              "invalid_params");
    }
    CHECK(errorCode(doc, insertJson("slt_2", "trk_1", 0)) == "no error");
}

TEST_CASE("plugin.remove and plugin.set_bypass declare exactly what they change", "[command][plugin]") {
    Document doc = prepare(base(), cmd(insertJson("slt_1", "trk_1", 0))).result;
    doc = prepare(doc, cmd(insertJson("slt_2", "trk_1", 1))).result;

    const auto bypassed = prepare(doc, cmd(R"({"op":"plugin.set_bypass","slotId":"slt_2","bypass":true})"));
    CHECK(bypassed.effects == DeclaredEffects{ref(EntityType::plugin_slot, "slt_2")});
    CHECK(bypassed.result.pluginSlot("slt_2")->bypass);
    CHECK(bypassed.result.sharesEntity(doc, ref(EntityType::track, "trk_1")));
    CHECK(errorCode(doc, R"({"op":"plugin.set_bypass","slotId":"slt_9","bypass":true})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"plugin.set_bypass","slotId":"slt_2","bypass":1})") == "invalid_params");

    const auto removed = prepare(doc, cmd(R"({"op":"plugin.remove","slotId":"slt_1"})"));
    CHECK(removed.effects == DeclaredEffects{ref(EntityType::track, "trk_1"), ref(EntityType::plugin_slot, "slt_1")});
    CHECK(removed.result.pluginSlot("slt_1") == nullptr);
    CHECK(removed.result.track("trk_1")->inserts == std::vector<std::string>{"slt_2"});
    CHECK(errorCode(removed.result, R"({"op":"plugin.remove","slotId":"slt_1"})") == "not_found");
}

TEST_CASE("track.remove declares and removes the track's plugin slots as cascades", "[command][plugin]") {
    Document doc = base();
    doc = prepare(doc, cmd(R"({"op":"track.add","trackId":"trk_2","name":"Bass","channels":2})")).result;
    doc = prepare(doc, cmd(insertJson("slt_1", "trk_1", 0))).result;
    doc = prepare(doc, cmd(insertJson("slt_2", "trk_1", 1))).result;
    doc = prepare(doc, cmd(insertJson("slt_3", "trk_2", 0))).result;
    doc = prepare(doc, cmd(R"({"op":"clip.place","clipId":"clp_1","trackId":"trk_1","mediaId":"med_1",
        "position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"100"})")).result;
    const auto removed = prepare(doc, cmd(R"({"op":"track.remove","trackId":"trk_1"})"));
    CHECK(removed.effects == DeclaredEffects{ref(EntityType::root, "root"), ref(EntityType::track, "trk_1"),
                                             ref(EntityType::clip, "clp_1"), ref(EntityType::plugin_slot, "slt_1"),
                                             ref(EntityType::plugin_slot, "slt_2")});
    CHECK(removed.result.pluginSlot("slt_1") == nullptr);
    CHECK(removed.result.pluginSlot("slt_2") == nullptr);
    CHECK(removed.result.pluginSlot("slt_3") != nullptr);
    CHECK(removed.result.validate().empty());
}

TEST_CASE("Media in use cannot be removed", "[command]") {
    Document doc = base();
    doc = prepare(doc, cmd(R"({"op":"clip.place","clipId":"clp_1","trackId":"trk_1","mediaId":"med_1",
        "position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"100"})")).result;
    CHECK(errorCode(doc, R"({"op":"media.remove","mediaId":"med_1"})") == "media_in_use");
    doc = prepare(doc, cmd(R"({"op":"clip.remove","clipId":"clp_1"})")).result;
    CHECK(prepare(doc, cmd(R"({"op":"media.remove","mediaId":"med_1"})")).result.media("med_1") == nullptr);
}

TEST_CASE("Session commands change the root", "[command]") {
    const Document doc = base();
    CHECK(prepare(doc, cmd(R"({"op":"session.rename","name":"New"})")).result.root().name == "New");
    const Document tempo = prepare(doc, cmd(R"({"op":"session.set_tempo","tempo":[
        {"ticks":"0","milliBpm":90000},{"ticks":"7680","milliBpm":140000}]})")).result;
    REQUIRE(tempo.root().tempo.size() == 2);
    CHECK(tempo.root().tempo[1].milliBpm == 140'000);
    CHECK(errorCode(doc, R"({"op":"session.set_tempo","tempo":[{"ticks":"10","milliBpm":90000}]})") ==
          "invalid_tempo");
}

TEST_CASE("session.set_locators sets the pair and declares exactly the locators entity", "[command][locators]") {
    const Document doc = base();
    const auto prepared = prepare(doc, cmd(R"({"op":"session.set_locators","left":"96000","right":"480000"})"));
    CHECK(prepared.effects == DeclaredEffects{ref(EntityType::locators, "locators")});
    REQUIRE(prepared.result.locators() != nullptr);
    CHECK(prepared.result.locators()->left == 96'000);
    CHECK(prepared.result.locators()->right == 480'000);
    CHECK(doc.locators() == nullptr);

    // Setting again replaces the pair; the same pair is no change at all.
    const auto again = prepare(prepared.result, cmd(R"({"op":"session.set_locators","left":"0","right":"1"})"));
    CHECK(again.effects == DeclaredEffects{ref(EntityType::locators, "locators")});
    CHECK(again.result.locators()->left == 0);
    CHECK(again.result.locators()->right == 1);
    const auto same = prepare(prepared.result, cmd(R"({"op":"session.set_locators","left":"96000","right":"480000"})"));
    CHECK(diff(prepared.result, same.result).empty());
    CHECK(prepare(doc, cmd(R"({"op":"session.set_locators","left":"0","right":"4398046511104"})"))
              .result.locators()
              ->right == siann::time::kMaxPositionMagnitude);
}

TEST_CASE("session.set_locators refuses a bad pair and malformed values", "[command][locators]") {
    const Document doc = base();
    CHECK(errorCode(doc, R"({"op":"session.set_locators","left":"480000","right":"480000"})") == "invalid_locators");
    CHECK(errorCode(doc, R"({"op":"session.set_locators","left":"480001","right":"480000"})") == "invalid_locators");
    CHECK(errorCode(doc, R"({"op":"session.set_locators","left":"-1","right":"480000"})") == "invalid_locators");
    CHECK(errorCode(doc, R"({"op":"session.set_locators","left":"0","right":"4398046511105"})") ==
          "invalid_locators");
    CHECK(errorCode(doc, R"({"op":"session.set_locators","left":96000,"right":"480000"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"session.set_locators","left":"96000","right":480000})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"session.set_locators","left":"096000","right":"480000"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"session.set_locators","left":"1.5","right":"480000"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"session.set_locators","left":"96000"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"session.set_locators","left":"0","right":"1","cycle":true})") ==
          "invalid_params");
}

TEST_CASE("Malformed commands are rejected with stable codes", "[command]") {
    const Document doc = base();
    CHECK(errorCode(doc, R"({"op":"track.explode","trackId":"trk_1"})") == "unknown_command");
    CHECK(errorCode(doc, R"({"op":"track.set_gain","trackId":"trk_1"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_gain","trackId":"trk_1","gainMilliDb":0,"extra":1})") ==
          "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_gain","trackId":"trk_1","gainMilliDb":"0"})") == "invalid_params");
    CHECK_THROWS_AS(Command::fromJson(siann::json::parse(R"({"trackId":"trk_1"})")), CommandError);
    CHECK_THROWS_AS(Command::fromJson(siann::json::parse(R"([1])")), CommandError);
}

TEST_CASE("A transaction applies all steps or none", "[command]") {
    const Document doc = base();
    const auto ok = prepareTransaction(doc, {
        cmd(R"({"op":"track.add","trackId":"trk_2","name":"Bass","channels":2})"),
        cmd(R"({"op":"clip.place","clipId":"clp_1","trackId":"trk_2","mediaId":"med_1",
            "position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"100"})"),
    });
    CHECK(ok.result.clip("clp_1")->trackId == "trk_2");
    CHECK(ok.effects.count(ref(EntityType::clip, "clp_1")) == 1);
    CHECK(ok.effects.count(ref(EntityType::track, "trk_2")) == 1);

    try {
        (void)prepareTransaction(doc, {
            cmd(R"({"op":"track.add","trackId":"trk_2","name":"Bass","channels":2})"),
            cmd(R"({"op":"track.add","trackId":"trk_2","name":"Again","channels":2})"),
        });
        FAIL("expected the second step to fail");
    } catch (const CommandError& error) {
        CHECK(error.code() == "already_exists");
        CHECK(error.step() == 1);
    }
    CHECK_THROWS_AS(prepareTransaction(doc, {}), CommandError);
}

TEST_CASE("Undeclared effects are detected", "[command]") {
    const Document before = base();
    const Document after = prepare(before, cmd(R"({"op":"track.rename","trackId":"trk_1","name":"X"})")).result;
    CHECK_NOTHROW(checkDeclaredEffects(before, after, {ref(EntityType::track, "trk_1")}));
    try {
        checkDeclaredEffects(before, after, {ref(EntityType::root, "root")});
        FAIL("expected undeclared_effect");
    } catch (const CommandError& error) {
        CHECK(error.code() == "undeclared_effect");
    }
}

// ---- m5b-engine-project-media: media names ----------------------------------

namespace {

std::string mediaAddJson(const std::string& id, const std::string& nameField) {
    return R"({"op":"media.add","mediaId":")" + id + R"(","contentHash":")" + kHash +
           R"(","format":"wav","channels":2,"sampleRate":48000,"frames":"48000")" + nameField + "}";
}

std::string renameJson(const std::string& id, const std::string& nameValue) {
    return R"({"op":"media.rename","mediaId":")" + id + R"(","name":)" + nameValue + "}";
}

}  // namespace

TEST_CASE("media.add takes an optional name", "[command][media]") {
    const Document doc = base();
    REQUIRE_FALSE(doc.media("med_1")->name.has_value());
    const auto prepared = prepare(doc, cmd(mediaAddJson("med_2", R"(,"name":"kick.wav")")));
    CHECK(prepared.effects == DeclaredEffects{ref(EntityType::media, "med_2")});
    REQUIRE(prepared.result.media("med_2")->name.has_value());
    CHECK(*prepared.result.media("med_2")->name == "kick.wav");
    CHECK(errorCode(doc, mediaAddJson("med_2", R"(,"name":"")")) == "invalid_params");
    CHECK(errorCode(doc, mediaAddJson("med_2", R"(,"name":")" + std::string(256, 'a') + "\"")) == "invalid_params");
    CHECK(errorCode(doc, mediaAddJson("med_2", R"(,"name":7)")) == "invalid_params");
    CHECK(errorCode(doc, mediaAddJson("med_2", R"(,"name":null)")) == "invalid_params");
    CHECK(errorCode(doc, mediaAddJson("med_2", "")) == "no error");
}

TEST_CASE("media.rename sets or removes the name and declares exactly the media", "[command][media]") {
    const Document doc = base();
    const auto named = prepare(doc, cmd(renameJson("med_1", R"("Loop 聲.wav")")));
    CHECK(named.effects == DeclaredEffects{ref(EntityType::media, "med_1")});
    REQUIRE(named.result.media("med_1")->name.has_value());
    CHECK(*named.result.media("med_1")->name == "Loop 聲.wav");
    CHECK(named.result.entityHash(ref(EntityType::media, "med_1")) != doc.entityHash(ref(EntityType::media, "med_1")));

    // null removes the field: the entity hashes as it did before it had a name.
    const auto cleared = prepare(named.result, cmd(renameJson("med_1", "null")));
    CHECK(cleared.effects == DeclaredEffects{ref(EntityType::media, "med_1")});
    CHECK_FALSE(cleared.result.media("med_1")->name.has_value());
    CHECK(cleared.result.entityHash(ref(EntityType::media, "med_1")) ==
          doc.entityHash(ref(EntityType::media, "med_1")));
    CHECK(cleared.result.documentHash() == doc.documentHash());

    CHECK(errorCode(doc, renameJson("med_9", R"("x")")) == "not_found");
    CHECK(errorCode(doc, renameJson("med_1", R"("")")) == "invalid_params");
    CHECK(errorCode(doc, renameJson("med_1", "3")) == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"media.rename","mediaId":"med_1"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"media.rename","mediaId":"med_1","name":"x","extra":1})") == "invalid_params");
}

TEST_CASE("The command catalog is listed", "[command]") {
    const auto names = commandNames();
    CHECK(names == std::vector<std::string>{
                       "bus.add", "bus.remove", "bus.rename", "bus.set_gain", "bus.set_mute", "bus.set_output",
                       "bus.set_pan", "bus.set_solo",
                       "clip.move", "clip.place", "clip.remove", "clip.set_fade", "clip.set_gain", "clip.trim",
                       "marker.add", "marker.move", "marker.remove", "marker.rename", "master.set_gain", "media.add",
                       "media.remove", "media.rename", "plugin.insert", "plugin.remove", "plugin.set_bypass",
                       "send.add", "send.remove", "send.set_enabled", "send.set_level", "send.set_pre", "session.rename",
                       "session.set_locators", "session.set_tempo", "track.add", "track.remove",
                       "track.rename", "track.set_gain", "track.set_input", "track.set_monitor", "track.set_mute",
                       "track.set_notes", "track.set_output", "track.set_pan", "track.set_solo"});
}

// m5b-engine-monitoring: track.set_monitor {trackId, monitor: off | auto | input}.
TEST_CASE("track.set_monitor sets each mode and declares only the track", "[command][monitor]") {
    const Document doc = base();
    CHECK(doc.track("trk_1")->monitor == siann::model::MonitorMode::off);
    const auto automatic = prepare(doc, cmd(R"({"op":"track.set_monitor","trackId":"trk_1","monitor":"auto"})"));
    CHECK(automatic.effects == DeclaredEffects{ref(EntityType::track, "trk_1")});
    CHECK(automatic.result.track("trk_1")->monitor == siann::model::MonitorMode::automatic);

    const auto input = prepare(automatic.result, cmd(R"({"op":"track.set_monitor","trackId":"trk_1","monitor":"input"})"));
    CHECK(input.effects == DeclaredEffects{ref(EntityType::track, "trk_1")});
    CHECK(input.result.track("trk_1")->monitor == siann::model::MonitorMode::input);

    const auto off = prepare(input.result, cmd(R"({"op":"track.set_monitor","trackId":"trk_1","monitor":"off"})"));
    CHECK(off.result.track("trk_1")->monitor == siann::model::MonitorMode::off);
    CHECK(off.result.documentHash() == doc.documentHash());  // off is the track as it was
}

TEST_CASE("track.set_monitor refuses another value, a bad field and an unknown track", "[command][monitor]") {
    const Document doc = base();
    CHECK(errorCode(doc, R"({"op":"track.set_monitor","trackId":"trk_1","monitor":"always"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_monitor","trackId":"trk_1","monitor":"AUTO"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_monitor","trackId":"trk_1","monitor":true})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_monitor","trackId":"trk_1","monitor":null})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_monitor","trackId":"trk_1"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_monitor","trackId":"trk_1","monitor":"auto","x":1})") ==
          "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_monitor","trackId":"trk_9","monitor":"auto"})") == "not_found");
}

// ---- m5b-engine-track-notes: track.set_notes {trackId, notes} ---------------

namespace {

// A track.set_notes command built as a Value, so `notes` can carry any bytes.
Command setNotes(const std::string& trackId, siann::json::Value notes) {
    return Command::fromJson(siann::json::Value(siann::json::Object{
        {"op", siann::json::Value("track.set_notes")},
        {"trackId", siann::json::Value(trackId)},
        {"notes", std::move(notes)},
    }));
}

std::string notesErrorCode(const Document& doc, const Command& command) {
    try {
        (void)prepare(doc, command);
    } catch (const CommandError& error) {
        return error.code();
    }
    return "no error";
}

}  // namespace

TEST_CASE("track.set_notes stores the text and declares only the track", "[command][notes]") {
    const Document doc = base();
    const std::string text = "Verse: double it.\r\n\xE5\x89\xAF\xE6\xAD\x8C louder\tnow";
    const auto set = prepare(doc, setNotes("trk_1", siann::json::Value(text)));
    CHECK(set.effects == DeclaredEffects{ref(EntityType::track, "trk_1")});
    REQUIRE(set.result.track("trk_1")->notes.has_value());
    CHECK(*set.result.track("trk_1")->notes == text);  // byte for byte
    CHECK_FALSE(doc.track("trk_1")->notes.has_value());
    CHECK(set.result.entityHash(ref(EntityType::track, "trk_1")) != doc.entityHash(ref(EntityType::track, "trk_1")));
    CHECK(siann::model::toJson(*set.result.track("trk_1")).find("notes")->asString() == text);

    const auto replaced = prepare(set.result, cmd(R"({"op":"track.set_notes","trackId":"trk_1","notes":"other"})"));
    CHECK(*replaced.result.track("trk_1")->notes == "other");

    // "" removes the field: the track hashes as it did before it had notes.
    const auto removed = prepare(set.result, cmd(R"({"op":"track.set_notes","trackId":"trk_1","notes":""})"));
    CHECK(removed.effects == DeclaredEffects{ref(EntityType::track, "trk_1")});
    CHECK_FALSE(removed.result.track("trk_1")->notes.has_value());
    CHECK(siann::model::toJson(*removed.result.track("trk_1")).find("notes") == nullptr);
    CHECK(removed.result.entityHash(ref(EntityType::track, "trk_1")) == doc.entityHash(ref(EntityType::track, "trk_1")));
    CHECK(removed.result.documentHash() == doc.documentHash());

    // "" on a track without notes is a no-op on the document.
    CHECK(prepare(doc, setNotes("trk_1", siann::json::Value(std::string()))).result.documentHash() ==
          doc.documentHash());
}

TEST_CASE("track.set_notes accepts 16,384 bytes and refuses more as invalid_notes", "[command][notes]") {
    const Document doc = base();
    CHECK(prepare(doc, setNotes("trk_1", siann::json::Value(std::string(16'384, 'a'))))
              .result.track("trk_1")
              ->notes->size() == 16'384);
    std::string multi;
    while (multi.size() + 3 <= 16'384) {
        multi += "\xE8\x81\xB2";
    }
    multi += "a";  // 16,384 bytes of multi-byte text
    REQUIRE(multi.size() == 16'384);
    CHECK(notesErrorCode(doc, setNotes("trk_1", siann::json::Value(multi))) == "no error");
    CHECK(notesErrorCode(doc, setNotes("trk_1", siann::json::Value(std::string(16'385, 'a')))) == "invalid_notes");
    CHECK(notesErrorCode(doc, setNotes("trk_1", siann::json::Value(multi + "a"))) == "invalid_notes");
}

TEST_CASE("track.set_notes refuses malformed UTF-8 as invalid_notes", "[command][notes]") {
    const Document doc = base();
    for (const std::string& bad : {
             std::string("overlong \xC0\xAF"),         // overlong '/'
             std::string("overlong \xE0\x80\xAF"),     // three-byte overlong
             std::string("lone surrogate \xED\xA0\x80"),  // U+D800
             std::string("truncated \xE8\x81"),        // a three-byte sequence cut short
             std::string("stray \x80 continuation"),
             std::string("past U+10FFFF \xF4\x90\x80\x80"),
         }) {
        INFO(bad);
        CHECK(notesErrorCode(doc, setNotes("trk_1", siann::json::Value(bad))) == "invalid_notes");
    }
}

TEST_CASE("track.set_notes refuses malformed params and an unknown track", "[command][notes]") {
    const Document doc = base();
    CHECK(errorCode(doc, R"({"op":"track.set_notes","trackId":"trk_1","notes":42})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_notes","trackId":"trk_1","notes":null})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_notes","trackId":"trk_1","notes":["a"]})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_notes","trackId":"trk_1"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_notes","notes":"a"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_notes","trackId":"trk_1","notes":"a","x":1})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_notes","trackId":"trk_9","notes":"a"})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"track.set_notes","trackId":"trk_9","notes":""})") == "not_found");
}

TEST_CASE("track.set_notes passes the declared-effects check inside a transaction", "[command][notes]") {
    const Document doc = base();
    const auto applied = prepareTransaction(doc, {cmd(R"({"op":"track.set_notes","trackId":"trk_1","notes":"a"})"),
                                                  cmd(R"({"op":"track.set_gain","trackId":"trk_1","gainMilliDb":-3000})")});
    CHECK(*applied.result.track("trk_1")->notes == "a");
    CHECK(applied.result.track("trk_1")->gain.milliDb == -3'000);
}

TEST_CASE("track.set_notes keeps tab, LF and CR and refuses other controls and bidi characters", "[command][notes]") {
    const Document doc = base();
    CHECK(*prepare(doc, setNotes("trk_1", siann::json::Value(std::string("a\tb\nc\rd")))).result.track("trk_1")->notes ==
          "a\tb\nc\rd");
    for (const std::string& bad : {std::string("bell \x07"), std::string("esc \x1B[2J"), std::string("del \x7F"),
                                   std::string("c1 \xC2\x85"), std::string("rlo \xE2\x80\xAE"),
                                   std::string("fsi \xE2\x81\xA8"), std::string("rlm \xE2\x80\x8F")}) {
        INFO(bad);
        CHECK(notesErrorCode(doc, setNotes("trk_1", siann::json::Value(bad))) == "invalid_notes");
    }
}

TEST_CASE("A bad track.set_notes step in a transaction names the step and applies nothing", "[command][notes]") {
    const Document doc = base();
    try {
        (void)prepareTransaction(doc, {cmd(R"({"op":"track.set_gain","trackId":"trk_1","gainMilliDb":-3000})"),
                                       setNotes("trk_1", siann::json::Value(std::string("rlo \xE2\x80\xAE")))});
        FAIL("the transaction was accepted");
    } catch (const CommandError& error) {
        CHECK(error.code() == "invalid_notes");
        CHECK(error.step() == 1);
    }
    CHECK(doc.track("trk_1")->gain.milliDb == 0);
    CHECK_FALSE(doc.track("trk_1")->notes.has_value());
}

// m5b-engine-record: track.set_input {trackId, input: {port, channels} | null}.
TEST_CASE("track.set_input sets and clears the input and declares only the track", "[command][input]") {
    const Document doc = base();
    const auto set = prepare(doc, cmd(R"({"op":"track.set_input","trackId":"trk_1","input":{"port":2,"channels":2}})"));
    CHECK(set.effects == DeclaredEffects{ref(EntityType::track, "trk_1")});
    REQUIRE(set.result.track("trk_1")->input.has_value());
    CHECK(set.result.track("trk_1")->input->port == 2);
    CHECK(set.result.track("trk_1")->input->channels == 2);
    CHECK_FALSE(doc.track("trk_1")->input.has_value());

    const auto mono = prepare(set.result, cmd(R"({"op":"track.set_input","trackId":"trk_1","input":{"port":0,"channels":1}})"));
    CHECK(mono.result.track("trk_1")->input == siann::model::TrackInput{0, 1});

    const auto cleared = prepare(set.result, cmd(R"({"op":"track.set_input","trackId":"trk_1","input":null})"));
    CHECK(cleared.effects == DeclaredEffects{ref(EntityType::track, "trk_1")});
    CHECK_FALSE(cleared.result.track("trk_1")->input.has_value());
    CHECK(cleared.result.documentHash() == doc.documentHash());  // cleared is the track as it was
}

TEST_CASE("track.set_input refuses a bad input and an unknown track", "[command][input]") {
    const Document doc = base();
    CHECK(errorCode(doc, R"({"op":"track.set_input","trackId":"trk_1","input":{"port":-1,"channels":1}})") ==
          "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_input","trackId":"trk_1","input":{"port":0,"channels":3}})") ==
          "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_input","trackId":"trk_1","input":{"port":0,"channels":0}})") ==
          "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_input","trackId":"trk_1","input":{"port":0}})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_input","trackId":"trk_1","input":{"port":0,"channels":1,"x":1}})") ==
          "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_input","trackId":"trk_1","input":"in 1"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_input","trackId":"trk_1"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_input","trackId":"trk_9","input":null})") == "not_found");
}

// ---- m5b-engine-master: master.set_gain {gainMilliDb} -----------------------

namespace {

Command setMaster(const std::string& gain) {
    return cmd(R"({"op":"master.set_gain","gainMilliDb":)" + gain + "}");
}

}  // namespace

TEST_CASE("master.set_gain sets the master and declares exactly master:master", "[command][master]") {
    const Document doc = base();
    const auto set = prepare(doc, setMaster("-6000"));
    CHECK(set.effects == DeclaredEffects{ref(EntityType::master, "master")});
    REQUIRE(set.result.master() != nullptr);
    CHECK(set.result.master()->gain.milliDb == -6000);
    CHECK(doc.master() == nullptr);
    CHECK(set.result.root() == doc.root());
    CHECK(set.result.sharesEntity(doc, ref(EntityType::root, "root")));

    // A change replaces it; set back to 0 dB removes it and the document hashes as before.
    const auto changed = prepare(set.result, setMaster("-3000"));
    CHECK(changed.effects == DeclaredEffects{ref(EntityType::master, "master")});
    CHECK(changed.result.master()->gain.milliDb == -3000);
    const auto removed = prepare(changed.result, setMaster("0"));
    CHECK(removed.effects == DeclaredEffects{ref(EntityType::master, "master")});
    CHECK(removed.result.master() == nullptr);
    CHECK(removed.result.documentHash() == doc.documentHash());
    CHECK(removed.result.toJson().find("master") == nullptr);

    // 0 while absent changes nothing, as a track.set_gain to its own value does.
    const auto noop = prepare(doc, setMaster("0"));
    CHECK(noop.effects == DeclaredEffects{ref(EntityType::master, "master")});
    CHECK(noop.result.master() == nullptr);
    CHECK(diff(doc, noop.result).empty());
    CHECK(noop.result.documentHash() == doc.documentHash());

    // The range ends and minus infinity.
    CHECK(prepare(doc, setMaster("-144000")).result.master()->gain.milliDb == -144'000);
    CHECK(prepare(doc, setMaster("24000")).result.master()->gain.milliDb == 24'000);
    CHECK(prepare(doc, setMaster("-2147483648")).result.master()->gain.isMinusInfinity());
}

TEST_CASE("master.set_gain refuses a gain out of range and malformed params", "[command][master]") {
    const Document doc = base();
    CHECK(errorCode(doc, R"({"op":"master.set_gain","gainMilliDb":24001})") == "invalid_gain");
    CHECK(errorCode(doc, R"({"op":"master.set_gain","gainMilliDb":-144001})") == "invalid_gain");
    CHECK(errorCode(doc, R"({"op":"master.set_gain","gainMilliDb":-2147483647})") == "invalid_gain");
    CHECK(errorCode(doc, R"({"op":"master.set_gain","gainMilliDb":-6000.5})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"master.set_gain","gainMilliDb":"-6000"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"master.set_gain","gainMilliDb":4294967296})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"master.set_gain"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"master.set_gain","gainMilliDb":-6000,"pan":0})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"master.set_gain","gainMilliDb":0,"extra":1})") == "invalid_params");
}

TEST_CASE("master.set_gain passes the declared-effects check inside a transaction", "[command][master]") {
    const Document doc = base();
    const auto prepared = prepareTransaction(doc, {setMaster("-6000"), setMaster("-1000")});
    CHECK(prepared.result.master()->gain.milliDb == -1000);
    CHECK(prepared.effects == DeclaredEffects{ref(EntityType::master, "master")});
    const auto back = prepareTransaction(doc, {setMaster("-6000"), setMaster("0")});
    CHECK(back.result.documentHash() == doc.documentHash());
}

// ---- m5b-engine-buses-sends: buses, sends and routing ----------------------

namespace {

Document applied(const Document& doc, const std::string& json) {
    return prepare(doc, cmd(json)).result;
}

// trk_1 and trk_2, buses bus_a and bus_b (in that order), a post-fader send
// snd_1 from trk_1 to bus_a.
Document mixer() {
    Document doc = base();
    doc = applied(doc, R"({"op":"track.add","trackId":"trk_2","name":"Bass","channels":1})");
    doc = applied(doc, R"({"op":"bus.add","busId":"bus_a","name":"Reverb"})");
    doc = applied(doc, R"({"op":"bus.add","busId":"bus_b","name":"Group"})");
    doc = applied(doc, R"({"op":"send.add","sendId":"snd_1","trackId":"trk_1","busId":"bus_a"})");
    return doc;
}

std::string busInsertJson(const std::string& slotId, const std::string& busId, int index) {
    return R"({"op":"plugin.insert","busId":")" + busId + R"(","index":)" + std::to_string(index) +
           R"(,"slotId":")" + slotId + R"(","descriptor":{"format":"clap","uid":"u"},"stateBlob":null})";
}

}  // namespace

TEST_CASE("bus.add adds a stereo bus feeding the master and declares root and the bus", "[command][buses]") {
    const Document doc = base();
    const auto added = prepare(doc, cmd(R"({"op":"bus.add","busId":"bus_a","name":"Reverb"})"));
    CHECK(added.effects == DeclaredEffects{ref(EntityType::root, "root"), ref(EntityType::bus, "bus_a")});
    const auto* b = added.result.bus("bus_a");
    REQUIRE(b != nullptr);
    CHECK(b->name == "Reverb");
    CHECK(b->channels == 2);
    CHECK(b->gain.milliDb == 0);
    CHECK(b->pan == 0);
    CHECK_FALSE(b->mute);
    CHECK_FALSE(b->solo);
    CHECK_FALSE(b->output.has_value());
    CHECK(added.result.root().busOrder == std::vector<std::string>{"bus_a"});
    const Document two = applied(added.result, R"({"op":"bus.add","busId":"bus_0","name":"First","index":0})");
    CHECK(two.root().busOrder == std::vector<std::string>{"bus_0", "bus_a"});
    CHECK(errorCode(two, R"({"op":"bus.add","busId":"bus_a","name":"Again"})") == "already_exists");
    CHECK(errorCode(two, R"({"op":"bus.add","busId":"bus_9","name":"X","index":3})") == "invalid_params");
    CHECK(errorCode(two, R"({"op":"bus.add","busId":"bus_9"})") == "invalid_params");
    CHECK(errorCode(two, R"({"op":"bus.add","busId":"bus_9","name":"X","extra":1})") == "invalid_params");
    CHECK(errorCode(two, R"({"op":"bus.add","busId":"bad id","name":"X"})") == "invalid_id");
}

TEST_CASE("The bus edits change one field and declare only the bus", "[command][buses]") {
    const Document doc = mixer();
    const DeclaredEffects onlyBus{ref(EntityType::bus, "bus_a")};
    auto edit = [&](const std::string& json) {
        const auto prepared = prepare(doc, cmd(json));
        CHECK(prepared.effects == onlyBus);
        return prepared.result;
    };
    CHECK(edit(R"({"op":"bus.rename","busId":"bus_a","name":"Hall"})").bus("bus_a")->name == "Hall");
    CHECK(edit(R"({"op":"bus.set_gain","busId":"bus_a","gainMilliDb":-6000})").bus("bus_a")->gain.milliDb == -6000);
    CHECK(edit(R"({"op":"bus.set_pan","busId":"bus_a","pan":2500})").bus("bus_a")->pan == 2500);
    CHECK(edit(R"({"op":"bus.set_mute","busId":"bus_a","mute":true})").bus("bus_a")->mute);
    CHECK(edit(R"({"op":"bus.set_solo","busId":"bus_a","solo":true})").bus("bus_a")->solo);
    CHECK(edit(R"({"op":"bus.set_output","busId":"bus_a","output":{"busId":"bus_b"}})").bus("bus_a")->output ==
          std::optional<std::string>("bus_b"));
    const Document routedDoc = applied(doc, R"({"op":"bus.set_output","busId":"bus_a","output":{"busId":"bus_b"}})");
    const auto back = prepare(routedDoc, cmd(R"({"op":"bus.set_output","busId":"bus_a","output":null})"));
    CHECK(back.effects == onlyBus);
    CHECK_FALSE(back.result.bus("bus_a")->output.has_value());
    CHECK(back.result.documentHash() == doc.documentHash());

    CHECK(errorCode(doc, R"({"op":"bus.rename","busId":"bus_x","name":"N"})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"bus.set_gain","busId":"bus_x","gainMilliDb":0})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"bus.set_pan","busId":"bus_x","pan":0})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"bus.set_mute","busId":"bus_x","mute":true})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"bus.set_solo","busId":"bus_x","solo":true})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"bus.set_output","busId":"bus_x","output":null})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"bus.set_output","busId":"bus_a","output":{"busId":"bus_x"}})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"bus.set_gain","busId":"bus_a","gainMilliDb":24001})") == "invalid_gain");
    CHECK(errorCode(doc, R"({"op":"bus.set_pan","busId":"bus_a","pan":-10001})") == "invalid_pan");
    CHECK(errorCode(doc, R"({"op":"bus.set_mute","busId":"bus_a","mute":1})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"bus.set_output","busId":"bus_a"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"bus.set_output","busId":"bus_a","output":"bus_b"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"bus.set_output","busId":"bus_a","output":{"busId":"bus_b","x":1}})") ==
          "invalid_params");
    CHECK(errorCode(doc, R"({"op":"bus.set_gain","busId":"bus_a","gainMilliDb":0,"x":1})") == "invalid_params");
}

TEST_CASE("bus.set_output refuses a route that reaches the bus itself and changes nothing", "[command][buses]") {
    Document doc = mixer();
    doc = applied(doc, R"({"op":"bus.add","busId":"bus_c","name":"Third"})");
    CHECK(errorCode(doc, R"({"op":"bus.set_output","busId":"bus_a","output":{"busId":"bus_a"}})") == "routing_cycle");
    doc = applied(doc, R"({"op":"bus.set_output","busId":"bus_a","output":{"busId":"bus_b"}})");
    doc = applied(doc, R"({"op":"bus.set_output","busId":"bus_b","output":{"busId":"bus_c"}})");
    const auto hash = doc.documentHash();
    CHECK(errorCode(doc, R"({"op":"bus.set_output","busId":"bus_b","output":{"busId":"bus_a"}})") == "routing_cycle");
    CHECK(errorCode(doc, R"({"op":"bus.set_output","busId":"bus_c","output":{"busId":"bus_a"}})") == "routing_cycle");
    CHECK(doc.documentHash() == hash);
    // Inside a transaction the failing step is reported and nothing applies.
    try {
        (void)prepareTransaction(doc, {cmd(R"({"op":"bus.rename","busId":"bus_c","name":"X"})"),
                                       cmd(R"({"op":"bus.set_output","busId":"bus_c","output":{"busId":"bus_a"}})")});
        FAIL("expected routing_cycle");
    } catch (const CommandError& error) {
        CHECK(error.code() == "routing_cycle");
        CHECK(error.step() == 1);
    }
}

TEST_CASE("track.set_output routes a track to a bus or the master and declares only the track", "[command][buses]") {
    const Document doc = mixer();
    const auto routedTrack = prepare(doc, cmd(R"({"op":"track.set_output","trackId":"trk_2","output":{"busId":"bus_b"}})"));
    CHECK(routedTrack.effects == DeclaredEffects{ref(EntityType::track, "trk_2")});
    CHECK(routedTrack.result.track("trk_2")->output == std::optional<std::string>("bus_b"));
    const auto back = prepare(routedTrack.result, cmd(R"({"op":"track.set_output","trackId":"trk_2","output":null})"));
    CHECK(back.effects == DeclaredEffects{ref(EntityType::track, "trk_2")});
    CHECK(back.result.documentHash() == doc.documentHash());
    CHECK(errorCode(doc, R"({"op":"track.set_output","trackId":"trk_x","output":null})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"track.set_output","trackId":"trk_2","output":{"busId":"bus_x"}})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"track.set_output","trackId":"trk_2"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"track.set_output","trackId":"trk_2","output":{"trackId":"trk_1"}})") ==
          "invalid_params");
}

TEST_CASE("send.add and the send edits declare exactly their entities", "[command][buses]") {
    const Document doc = mixer();
    const auto* s = doc.send("snd_1");
    REQUIRE(s != nullptr);
    CHECK(s->trackId == "trk_1");
    CHECK(s->busId == "bus_a");
    CHECK(s->level.milliDb == 0);
    CHECK_FALSE(s->pre);
    CHECK(s->enabled);
    CHECK(doc.track("trk_1")->sends == std::vector<std::string>{"snd_1"});

    const auto added = prepare(doc, cmd(R"({"op":"send.add","sendId":"snd_0","trackId":"trk_1","busId":"bus_b",
        "levelMilliDb":-6000,"pre":true,"enabled":false,"index":0})"));
    CHECK(added.effects == DeclaredEffects{ref(EntityType::track, "trk_1"), ref(EntityType::send, "snd_0")});
    CHECK(added.result.track("trk_1")->sends == std::vector<std::string>{"snd_0", "snd_1"});
    CHECK(added.result.send("snd_0")->level.milliDb == -6000);
    CHECK(added.result.send("snd_0")->pre);
    CHECK_FALSE(added.result.send("snd_0")->enabled);

    const DeclaredEffects onlySend{ref(EntityType::send, "snd_1")};
    auto edit = [&](const std::string& json) {
        const auto prepared = prepare(doc, cmd(json));
        CHECK(prepared.effects == onlySend);
        return prepared.result;
    };
    CHECK(edit(R"({"op":"send.set_level","sendId":"snd_1","levelMilliDb":-3000})").send("snd_1")->level.milliDb ==
          -3000);
    CHECK(edit(R"({"op":"send.set_pre","sendId":"snd_1","pre":true})").send("snd_1")->pre);
    CHECK_FALSE(edit(R"({"op":"send.set_enabled","sendId":"snd_1","enabled":false})").send("snd_1")->enabled);

    const auto removed = prepare(doc, cmd(R"({"op":"send.remove","sendId":"snd_1"})"));
    CHECK(removed.effects == DeclaredEffects{ref(EntityType::track, "trk_1"), ref(EntityType::send, "snd_1")});
    CHECK(removed.result.send("snd_1") == nullptr);
    CHECK(removed.result.track("trk_1")->sends.empty());

    CHECK(errorCode(doc, R"({"op":"send.add","sendId":"snd_1","trackId":"trk_1","busId":"bus_a"})") == "already_exists");
    CHECK(errorCode(doc, R"({"op":"send.add","sendId":"snd_9","trackId":"trk_x","busId":"bus_a"})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"send.add","sendId":"snd_9","trackId":"trk_1","busId":"bus_x"})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"send.add","sendId":"snd_9","trackId":"trk_1","busId":"bus_a","index":2})") ==
          "invalid_params");
    CHECK(errorCode(doc, R"({"op":"send.add","sendId":"snd_9","trackId":"trk_1","busId":"bus_a","pan":0})") ==
          "invalid_params");
    CHECK(errorCode(doc, R"({"op":"send.add","sendId":"snd_9","trackId":"trk_1","busId":"bus_a","levelMilliDb":24001})") ==
          "invalid_gain");
    CHECK(errorCode(doc, R"({"op":"send.remove","sendId":"snd_x"})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"send.set_level","sendId":"snd_x","levelMilliDb":0})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"send.set_pre","sendId":"snd_x","pre":true})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"send.set_enabled","sendId":"snd_x","enabled":true})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"send.set_level","sendId":"snd_1","levelMilliDb":-144001})") == "invalid_gain");
    CHECK(errorCode(doc, R"({"op":"send.set_pre","sendId":"snd_1","pre":"yes"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"send.set_enabled","sendId":"snd_1"})") == "invalid_params");
}

TEST_CASE("bus.remove removes its sends and slots and routes its inputs to the master in one revision",
          "[command][buses]") {
    Document doc = mixer();
    doc = applied(doc, R"({"op":"send.add","sendId":"snd_2","trackId":"trk_2","busId":"bus_a"})");
    doc = applied(doc, R"({"op":"send.add","sendId":"snd_3","trackId":"trk_2","busId":"bus_b"})");
    doc = applied(doc, R"({"op":"track.set_output","trackId":"trk_2","output":{"busId":"bus_a"}})");
    doc = applied(doc, R"({"op":"bus.set_output","busId":"bus_b","output":{"busId":"bus_a"}})");
    doc = applied(doc, busInsertJson("slt_a", "bus_a", 0));
    doc = applied(doc, busInsertJson("slt_b", "bus_b", 0));

    const auto removed = prepare(doc, cmd(R"({"op":"bus.remove","busId":"bus_a"})"));
    CHECK(removed.effects == DeclaredEffects{ref(EntityType::root, "root"), ref(EntityType::track, "trk_1"),
                                             ref(EntityType::track, "trk_2"), ref(EntityType::plugin_slot, "slt_a"),
                                             ref(EntityType::bus, "bus_a"), ref(EntityType::bus, "bus_b"),
                                             ref(EntityType::send, "snd_1"), ref(EntityType::send, "snd_2")});
    const Document& after = removed.result;
    CHECK(after.validate().empty());
    CHECK(after.bus("bus_a") == nullptr);
    CHECK(after.send("snd_1") == nullptr);
    CHECK(after.send("snd_2") == nullptr);
    CHECK(after.send("snd_3") != nullptr);
    CHECK(after.pluginSlot("slt_a") == nullptr);
    CHECK(after.pluginSlot("slt_b") != nullptr);
    CHECK(after.root().busOrder == std::vector<std::string>{"bus_b"});
    CHECK(after.track("trk_1")->sends.empty());
    CHECK(after.track("trk_2")->sends == std::vector<std::string>{"snd_3"});
    CHECK_FALSE(after.track("trk_2")->output.has_value());
    CHECK_FALSE(after.bus("bus_b")->output.has_value());
    CHECK(errorCode(doc, R"({"op":"bus.remove","busId":"bus_x"})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"bus.remove"})") == "invalid_params");

    // A bus nothing refers to declares the root and itself only.
    const auto lone = prepare(applied(base(), R"({"op":"bus.add","busId":"bus_z","name":"Z"})"),
                              cmd(R"({"op":"bus.remove","busId":"bus_z"})"));
    CHECK(lone.effects == DeclaredEffects{ref(EntityType::root, "root"), ref(EntityType::bus, "bus_z")});
    CHECK(lone.result.documentHash() == base().documentHash());
}

TEST_CASE("track.remove cascades the track's sends", "[command][buses]") {
    const Document doc = mixer();
    const auto removed = prepare(doc, cmd(R"({"op":"track.remove","trackId":"trk_1"})"));
    CHECK(removed.effects.count(ref(EntityType::send, "snd_1")) == 1);
    CHECK(removed.result.send("snd_1") == nullptr);
    CHECK(removed.result.validate().empty());
    CHECK(removed.result.bus("bus_a") != nullptr);
}

TEST_CASE("plugin.insert takes exactly one of trackId or busId", "[command][buses][plugin]") {
    const Document doc = mixer();
    const auto onBus = prepare(doc, cmd(busInsertJson("slt_1", "bus_a", 5)));
    CHECK(onBus.effects == DeclaredEffects{ref(EntityType::bus, "bus_a"), ref(EntityType::plugin_slot, "slt_1")});
    CHECK(onBus.result.bus("bus_a")->inserts == std::vector<std::string>{"slt_1"});
    CHECK(onBus.result.pluginSlot("slt_1")->busId == "bus_a");
    CHECK(onBus.result.pluginSlot("slt_1")->trackId.empty());
    CHECK(errorCode(doc, busInsertJson("slt_1", "bus_x", 0)) == "not_found");
    CHECK(errorCode(doc, R"({"op":"plugin.insert","trackId":"trk_1","busId":"bus_a","index":0,"slotId":"slt_1",
        "descriptor":{"format":"clap","uid":"u"},"stateBlob":null})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"plugin.insert","index":0,"slotId":"slt_1",
        "descriptor":{"format":"clap","uid":"u"},"stateBlob":null})") == "invalid_params");

    // plugin.remove and plugin.set_bypass work on a bus's slot unchanged.
    const auto bypassed = prepare(onBus.result, cmd(R"({"op":"plugin.set_bypass","slotId":"slt_1","bypass":true})"));
    CHECK(bypassed.effects == DeclaredEffects{ref(EntityType::plugin_slot, "slt_1")});
    const auto removed = prepare(onBus.result, cmd(R"({"op":"plugin.remove","slotId":"slt_1"})"));
    CHECK(removed.effects == DeclaredEffects{ref(EntityType::bus, "bus_a"), ref(EntityType::plugin_slot, "slt_1")});
    CHECK(removed.result.bus("bus_a")->inserts.empty());
    CHECK(removed.result.documentHash() == doc.documentHash());
}

TEST_CASE("commandCascades lists what a command may remove or change besides its target", "[command][buses]") {
    const auto cascades = siann::command::commandCascades();
    const std::map<std::string, std::vector<std::string>> expected{
        {"bus.remove", {"bus", "plugin_slot", "root", "send", "track"}},
        {"track.remove", {"clip", "plugin_slot", "root", "send"}},
    };
    CHECK(cascades == expected);
}

// ---- display-safe names (follow-up to #123) ---------------------------------

namespace {

using siann::json::Object;
using siann::json::Value;

// A command whose "name" (or descriptor name) is `name`, built as a value so
// it can carry bytes that JSON text could not (a name from the C++ API).
Command withName(Object fields, const std::string& name) {
    fields.emplace_back("name", Value(name));
    return Command::fromJson(Value(std::move(fields)));
}

std::string errorCodeOf(const Document& doc, const Command& command) {
    try {
        (void)prepare(doc, command);
    } catch (const CommandError& error) {
        return error.code();
    }
    return "no error";
}

// RLO, LRI, PDI, ALM, LRM, a line separator, a C0 and a C1 control, and a
// malformed byte: each refused anywhere in a name.
const std::vector<std::string> kUnsafeNames = {
    "Vox \xE2\x80\xAE" "6- ot",   // U+202E RLO
    "Vox \xE2\x81\xA6" "x",       // U+2066 LRI, unclosed
    "Vox \xE2\x81\xA9",           // U+2069 PDI
    "\xD8\x9C" "Vox",             // U+061C ALM
    "Vox\xE2\x80\x8E",            // U+200E LRM
    "Vox\xE2\x80\xA8" "Bass",     // U+2028 line separator
    "Vox\nBass",                  // LF
    "Vox\xC2\x85",                // U+0085 NEL (C1)
    "Vox \xC3\x28",               // malformed UTF-8
};

}  // namespace

TEST_CASE("track.add and track.rename refuse a display-unsafe name with invalid_name", "[command][names]") {
    const Document doc = base();
    for (const std::string& name : kUnsafeNames) {
        INFO(name);
        CHECK(errorCodeOf(doc, withName(Object{{"op", Value("track.add")}, {"trackId", Value("trk_2")},
                                               {"channels", Value(2.0)}},
                                        name)) == "invalid_name");
        CHECK(errorCodeOf(doc, withName(Object{{"op", Value("track.rename")}, {"trackId", Value("trk_1")}}, name)) ==
              "invalid_name");
    }
    // Text in any script, with its own direction, is a name.
    CHECK(errorCode(doc, R"({"op":"track.rename","trackId":"trk_1","name":"שירה 主唱 Vox"})") == "no error");
    CHECK(errorCode(doc, R"({"op":"track.add","trackId":"trk_2","name":"Ünïcødé 🎸","channels":2})") == "no error");
}

TEST_CASE("media.add and media.rename refuse a display-unsafe name with invalid_name", "[command][names][media]") {
    const Document doc = base();
    for (const std::string& name : kUnsafeNames) {
        INFO(name);
        CHECK(errorCodeOf(doc, withName(Object{{"op", Value("media.add")}, {"mediaId", Value("med_2")},
                                               {"contentHash", Value(kHash)}, {"format", Value("wav")},
                                               {"channels", Value(2.0)}, {"sampleRate", Value(48000.0)},
                                               {"frames", Value("48000")}},
                                        name)) == "invalid_name");
        CHECK(errorCodeOf(doc, withName(Object{{"op", Value("media.rename")}, {"mediaId", Value("med_1")}}, name)) ==
              "invalid_name");
    }
    // The length rule stays invalid_params.
    CHECK(errorCode(doc, R"({"op":"media.rename","mediaId":"med_1","name":""})") == "invalid_params");
}

TEST_CASE("bus.add and bus.rename refuse a display-unsafe name with invalid_name", "[command][names][bus]") {
    const Document doc = applied(base(), R"({"op":"bus.add","busId":"bus_a","name":"Verb"})");
    for (const std::string& name : kUnsafeNames) {
        INFO(name);
        CHECK(errorCodeOf(doc, withName(Object{{"op", Value("bus.add")}, {"busId", Value("bus_b")}}, name)) ==
              "invalid_name");
        CHECK(errorCodeOf(doc, withName(Object{{"op", Value("bus.rename")}, {"busId", Value("bus_a")}}, name)) ==
              "invalid_name");
    }
    CHECK(errorCode(doc, R"({"op":"bus.rename","busId":"bus_a","name":"混響 Verb"})") == "no error");
}

TEST_CASE("session.rename refuses a display-unsafe name with invalid_name", "[command][names]") {
    const Document doc = base();
    for (const std::string& name : kUnsafeNames) {
        INFO(name);
        CHECK(errorCodeOf(doc, withName(Object{{"op", Value("session.rename")}}, name)) == "invalid_name");
    }
    CHECK(errorCode(doc, R"({"op":"session.rename","name":"夜 Drive"})") == "no error");
}

TEST_CASE("plugin.insert refuses a display-unsafe descriptor name with invalid_name", "[command][names][plugin]") {
    const Document doc = base();
    for (const std::string& name : kUnsafeNames) {
        INFO(name);
        Object descriptor{{"format", Value("clap")}, {"uid", Value("u")}, {"name", Value(name)}};
        const Command insert = Command::fromJson(Value(Object{{"op", Value("plugin.insert")},
                                                              {"trackId", Value("trk_1")},
                                                              {"index", Value(0.0)},
                                                              {"slotId", Value("slt_2")},
                                                              {"descriptor", Value(std::move(descriptor))},
                                                              {"stateBlob", Value(nullptr)}}));
        CHECK(errorCodeOf(doc, insert) == "invalid_name");
    }
}

TEST_CASE("A transaction stops at the step whose name is unsafe", "[command][names]") {
    const Document doc = base();
    try {
        (void)prepareTransaction(doc, {cmd(R"({"op":"track.rename","trackId":"trk_1","name":"Kit"})"),
                                       cmd(R"({"op":"track.rename","trackId":"trk_1","name":"Kit \u202e"})")});
        FAIL("the transaction was not refused");
    } catch (const CommandError& error) {
        CHECK(error.code() == "invalid_name");
        CHECK(error.step() == 1);
    }
}

// ---- m5b-engine-clip-fades: clip.set_fade and clip.trim's shortening ---------

namespace {

using siann::model::Fade;
using siann::model::FadeCurve;

// base() with clp_1: 24000 frames of med_1 at 0.
Document faded() {
    return prepare(base(), cmd(R"({"op":"clip.place","clipId":"clp_1","trackId":"trk_1","mediaId":"med_1",)"
                               R"("position":{"domain":"audio","value":"0"},"sourceStart":"0","length":"24000"})"))
        .result;
}

std::string setFade(const std::string& sides) {
    return R"({"op":"clip.set_fade","clipId":"clp_1")" + sides + "}";
}

std::string trim(std::int64_t sourceStart, std::int64_t length) {
    return R"({"op":"clip.trim","clipId":"clp_1","sourceStart":")" + std::to_string(sourceStart) +
           R"(","length":")" + std::to_string(length) + R"("})";
}

const EntityRef kClip1{EntityType::clip, "clp_1"};

}  // namespace

TEST_CASE("clip.set_fade sets either side or both and declares exactly clip:<id>", "[command][fades]") {
    const Document doc = faded();
    const auto plainHash = doc.entityHash(kClip1);

    const auto in = prepare(doc, cmd(setFade(R"(,"fadeIn":{"length":"480","curve":"linear"})")));
    CHECK(in.effects == DeclaredEffects{kClip1});
    CHECK(in.result.clip("clp_1")->fadeIn == Fade{480, FadeCurve::linear});
    CHECK(in.result.clip("clp_1")->fadeOut == Fade{});
    CHECK(in.result.entityHash(kClip1) != plainHash);
    // Only the clip changes.
    const auto changes = siann::model::diff(doc, in.result);
    REQUIRE(changes.size() == 1);
    CHECK(changes[0].entity == kClip1);

    const auto out = prepare(doc, cmd(setFade(R"(,"fadeOut":{"length":"960","curve":"equal_power"})")));
    CHECK(out.effects == DeclaredEffects{kClip1});
    CHECK(out.result.clip("clp_1")->fadeIn == Fade{});
    CHECK(out.result.clip("clp_1")->fadeOut == Fade{960, FadeCurve::equal_power});

    const auto both = prepare(doc, cmd(setFade(R"(,"fadeIn":{"length":"480","curve":"linear"},)"
                                               R"("fadeOut":{"length":"960","curve":"equal_power"})")));
    CHECK(both.result.clip("clp_1")->fadeIn == Fade{480, FadeCurve::linear});
    CHECK(both.result.clip("clp_1")->fadeOut == Fade{960, FadeCurve::equal_power});

    // An omitted side is unchanged.
    const auto later = prepare(both.result, cmd(setFade(R"(,"fadeIn":{"length":"100","curve":"equal_power"})")));
    CHECK(later.result.clip("clp_1")->fadeIn == Fade{100, FadeCurve::equal_power});
    CHECK(later.result.clip("clp_1")->fadeOut == Fade{960, FadeCurve::equal_power});

    // Length "0" removes the side; both removed is the pre-fade hash.
    const auto noIn = prepare(both.result, cmd(setFade(R"(,"fadeIn":{"length":"0","curve":"equal_power"})")));
    CHECK(noIn.result.clip("clp_1")->fadeIn == Fade{});
    CHECK(noIn.result.clip("clp_1")->fadeOut == Fade{960, FadeCurve::equal_power});
    const auto none = prepare(noIn.result, cmd(setFade(R"(,"fadeOut":{"length":"0","curve":"linear"})")));
    CHECK(none.result.entityHash(kClip1) == plainHash);
    CHECK(none.result.documentHash() == doc.documentHash());

    // The two fades may meet but not overlap.
    CHECK(errorCode(doc, setFade(R"(,"fadeIn":{"length":"12000","curve":"linear"},)"
                                 R"("fadeOut":{"length":"12000","curve":"linear"})")) == "no error");
    CHECK(errorCode(doc, setFade(R"(,"fadeIn":{"length":"24000","curve":"linear"})")) == "no error");
    CHECK(errorCode(both.result, setFade(R"(,"fadeIn":{"length":"23041","curve":"linear"})")) == "invalid_fade");
    CHECK(errorCode(doc, setFade(R"(,"fadeIn":{"length":"24001","curve":"linear"})")) == "invalid_fade");
}

TEST_CASE("clip.set_fade refuses a missing clip, a missing side and malformed fades", "[command][fades]") {
    const Document doc = faded();
    CHECK(errorCode(doc, R"({"op":"clip.set_fade","clipId":"clp_9","fadeIn":{"length":"1","curve":"linear"}})") ==
          "not_found");
    CHECK(errorCode(doc, setFade("")) == "invalid_params");
    CHECK(errorCode(doc, setFade(R"(,"fadeIn":{"length":"480","curve":"log"})")) == "invalid_params");
    CHECK(errorCode(doc, setFade(R"(,"fadeIn":{"length":480,"curve":"linear"})")) == "invalid_params");
    CHECK(errorCode(doc, setFade(R"(,"fadeIn":{"length":"-480","curve":"linear"})")) == "invalid_params");
    CHECK(errorCode(doc, setFade(R"(,"fadeIn":{"length":"0480","curve":"linear"})")) == "invalid_params");
    CHECK(errorCode(doc, setFade(R"(,"fadeIn":{"length":"480"})")) == "invalid_params");
    CHECK(errorCode(doc, setFade(R"(,"fadeIn":{"length":"480","curve":"linear","x":1})")) == "invalid_params");
    CHECK(errorCode(doc, setFade(R"(,"fadeIn":null)")) == "invalid_params");
    CHECK(errorCode(doc, setFade(R"(,"fadeIn":{"length":"480","curve":"linear"},"extra":1)")) == "invalid_params");
}

TEST_CASE("clip.trim shortens fades that no longer fit, in the same revision", "[command][fades]") {
    const Document doc =
        prepare(faded(), cmd(setFade(R"(,"fadeIn":{"length":"6000","curve":"linear"},)"
                                     R"("fadeOut":{"length":"8000","curve":"equal_power"})")))
            .result;

    // Still fits (14000 <= 20000): unchanged.
    const auto fits = prepare(doc, cmd(trim(0, 20'000)));
    CHECK(fits.result.clip("clp_1")->fadeIn == Fade{6'000, FadeCurve::linear});
    CHECK(fits.result.clip("clp_1")->fadeOut == Fade{8'000, FadeCurve::equal_power});

    // 10000 frames: the fade in keeps 6000, the fade out takes the 4000 left.
    const auto shorter = prepare(doc, cmd(trim(0, 10'000)));
    CHECK(shorter.effects == DeclaredEffects{kClip1});
    CHECK(shorter.result.clip("clp_1")->length == 10'000);
    CHECK(shorter.result.clip("clp_1")->fadeIn == Fade{6'000, FadeCurve::linear});
    CHECK(shorter.result.clip("clp_1")->fadeOut == Fade{4'000, FadeCurve::equal_power});
    const auto changes = siann::model::diff(doc, shorter.result);
    REQUIRE(changes.size() == 1);
    CHECK(changes[0].entity == kClip1);

    // 5000 frames: the fade in is cut to the clip, the fade out is dropped.
    const auto cut = prepare(doc, cmd(trim(1'000, 5'000)));
    CHECK(cut.result.clip("clp_1")->fadeIn == Fade{5'000, FadeCurve::linear});
    CHECK(cut.result.clip("clp_1")->fadeOut == Fade{});
    CHECK(siann::model::toJson(*cut.result.clip("clp_1")).find("fadeOut") == nullptr);

    // A fade out only shortens to the clip.
    const Document outOnly =
        prepare(faded(), cmd(setFade(R"(,"fadeOut":{"length":"8000","curve":"linear"})"))).result;
    CHECK(prepare(outOnly, cmd(trim(0, 3'000))).result.clip("clp_1")->fadeOut == Fade{3'000, FadeCurve::linear});
}

TEST_CASE("commandNames lists clip.set_fade", "[command][fades]") {
    const auto names = commandNames();
    CHECK(std::find(names.begin(), names.end(), "clip.set_fade") != names.end());
}

// ---- m5b-engine-markers: marker.add, marker.move, marker.rename, marker.remove

namespace {

std::string addMarker(const std::string& id, const std::string& extra = "") {
    return R"({"op":"marker.add","markerId":")" + id + R"(","position":"1000")" + extra + "}";
}

std::int32_t numberOf(const Document& doc, const std::string& id) {
    const auto* m = doc.marker(id);
    REQUIRE(m != nullptr);
    return m->number;
}

}  // namespace

TEST_CASE("marker.add adds a position or cycle marker and declares exactly marker:<id>", "[command][markers]") {
    const Document doc = base();
    const auto added = prepare(doc, cmd(R"({"op":"marker.add","markerId":"mk_1","position":"96000"})"));
    CHECK(added.effects == DeclaredEffects{ref(EntityType::marker, "mk_1")});
    const auto* m = added.result.marker("mk_1");
    REQUIRE(m != nullptr);
    CHECK(m->position == 96'000);
    CHECK(m->name.empty());
    CHECK(m->number == 1);
    CHECK_FALSE(m->length.has_value());
    CHECK(added.result.sharesEntity(doc, ref(EntityType::root, "root")));
    const auto changes = diff(doc, added.result);
    REQUIRE(changes.size() == 1);
    CHECK(changes[0].entity == ref(EntityType::marker, "mk_1"));

    const auto cycle = prepare(added.result, cmd(R"({"op":"marker.add","markerId":"mk_2","position":"0","length":"48000","name":"Chorus 聲","number":7})"));
    CHECK(cycle.effects == DeclaredEffects{ref(EntityType::marker, "mk_2")});
    const auto* c = cycle.result.marker("mk_2");
    REQUIRE(c != nullptr);
    CHECK(c->length == std::optional<std::int64_t>(48'000));
    CHECK(c->name == "Chorus 聲");
    CHECK(c->number == 7);
    // A cycle marker with the number of a position marker: the kinds number apart.
    const auto one = prepare(added.result, cmd(addMarker("mk_3", R"(,"length":"10","number":1)")));
    CHECK(numberOf(one.result, "mk_3") == 1);
    CHECK(numberOf(one.result, "mk_1") == 1);
}

TEST_CASE("marker.add without a number takes the lowest free one of its kind", "[command][markers]") {
    Document doc = base();
    doc = applied(doc, addMarker("p1"));
    doc = applied(doc, addMarker("p2"));
    doc = applied(doc, addMarker("p3"));
    CHECK(numberOf(doc, "p1") == 1);
    CHECK(numberOf(doc, "p2") == 2);
    CHECK(numberOf(doc, "p3") == 3);
    // Cycle markers number on their own.
    doc = applied(doc, addMarker("c1", R"(,"length":"100")"));
    CHECK(numberOf(doc, "c1") == 1);
    // After removing 1 of {1, 2, 3} the next add gets 1, the one after it 4.
    doc = applied(doc, R"({"op":"marker.remove","markerId":"p1"})");
    doc = applied(doc, addMarker("p4"));
    CHECK(numberOf(doc, "p4") == 1);
    doc = applied(doc, addMarker("p5"));
    CHECK(numberOf(doc, "p5") == 4);
    // An explicit number leaves a gap the next automatic one fills.
    doc = applied(doc, addMarker("c2", R"(,"length":"100","number":3)"));
    doc = applied(doc, addMarker("c3", R"(,"length":"100")"));
    CHECK(numberOf(doc, "c3") == 2);
}

TEST_CASE("marker.add refuses a taken number, a used id and bad values", "[command][markers]") {
    Document doc = applied(base(), addMarker("p1", R"(,"number":5)"));
    CHECK(errorCode(doc, addMarker("p2", R"(,"number":5)")) == "marker_number_taken");
    CHECK(errorCode(doc, addMarker("p2", R"(,"number":5,"length":"1")")) == "no error");
    CHECK(errorCode(doc, addMarker("p1")) == "already_exists");
    CHECK(errorCode(doc, addMarker("p1", R"(,"length":"1")")) == "already_exists");
    // Ranges: invalid_marker.
    CHECK(errorCode(doc, R"({"op":"marker.add","markerId":"m","position":"-1"})") == "invalid_marker");
    CHECK(errorCode(doc, R"({"op":"marker.add","markerId":"m","position":"4398046511105"})") == "invalid_marker");
    CHECK(errorCode(doc, R"({"op":"marker.add","markerId":"m","position":"4398046511104"})") == "no error");
    CHECK(errorCode(doc, addMarker("m", R"(,"length":"0")")) == "invalid_marker");
    CHECK(errorCode(doc, addMarker("m", R"(,"length":"-1")")) == "invalid_marker");
    CHECK(errorCode(doc, addMarker("m", R"(,"length":"4398046510104")")) == "no error");
    CHECK(errorCode(doc, addMarker("m", R"(,"length":"4398046510105")")) == "invalid_marker");
    CHECK(errorCode(doc, addMarker("m", R"(,"number":0)")) == "invalid_marker");
    CHECK(errorCode(doc, addMarker("m", R"(,"number":10000)")) == "invalid_marker");
    CHECK(errorCode(doc, addMarker("m", R"(,"number":9999)")) == "no error");
    CHECK(errorCode(doc, addMarker("m", R"(,"name":")" + std::string(255, 'a') + "\"")) == "no error");
    CHECK(errorCode(doc, addMarker("m", R"(,"name":")" + std::string(256, 'a') + "\"")) == "invalid_marker");
    CHECK(errorCode(doc, R"({"op":"marker.add","markerId":"m 1","position":"0"})") == "invalid_id");
    // Malformed params.
    CHECK(errorCode(doc, R"({"op":"marker.add","markerId":"m","position":1000})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"marker.add","markerId":"m","position":"1e3"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"marker.add","markerId":"m"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"marker.add","position":"0"})") == "invalid_params");
    CHECK(errorCode(doc, addMarker("m", R"(,"number":"2")")) == "invalid_params");
    CHECK(errorCode(doc, addMarker("m", R"(,"number":1.5)")) == "invalid_params");
    CHECK(errorCode(doc, addMarker("m", R"(,"name":7)")) == "invalid_params");
    CHECK(errorCode(doc, addMarker("m", R"(,"name":null)")) == "invalid_params");
    CHECK(errorCode(doc, addMarker("m", R"(,"length":null)")) == "invalid_params");
    CHECK(errorCode(doc, addMarker("m", R"(,"extra":1)")) == "invalid_params");
}

TEST_CASE("marker.move keeps number and name, resizes only a cycle marker", "[command][markers]") {
    Document doc = base();
    doc = applied(doc, addMarker("p1", R"(,"name":"Intro","number":4)"));
    doc = applied(doc, addMarker("c1", R"(,"name":"Loop","length":"500","number":4)"));

    const auto moved = prepare(doc, cmd(R"({"op":"marker.move","markerId":"p1","position":"2000"})"));
    CHECK(moved.effects == DeclaredEffects{ref(EntityType::marker, "p1")});
    const auto* p = moved.result.marker("p1");
    REQUIRE(p != nullptr);
    CHECK(p->position == 2000);
    CHECK(p->number == 4);
    CHECK(p->name == "Intro");
    CHECK_FALSE(p->length.has_value());
    CHECK(moved.result.sharesEntity(doc, ref(EntityType::marker, "c1")));

    // A cycle marker moves with its length, or is resized with one.
    const auto shifted = prepare(doc, cmd(R"({"op":"marker.move","markerId":"c1","position":"3000"})"));
    CHECK(shifted.result.marker("c1")->position == 3000);
    CHECK(shifted.result.marker("c1")->length == std::optional<std::int64_t>(500));
    const auto resized = prepare(doc, cmd(R"({"op":"marker.move","markerId":"c1","position":"1000","length":"9000"})"));
    CHECK(resized.effects == DeclaredEffects{ref(EntityType::marker, "c1")});
    CHECK(resized.result.marker("c1")->length == std::optional<std::int64_t>(9000));
    CHECK(resized.result.marker("c1")->number == 4);
    CHECK(resized.result.marker("c1")->name == "Loop");

    // The kind never changes: a length on a position marker is invalid_params.
    CHECK(errorCode(doc, R"({"op":"marker.move","markerId":"p1","position":"0","length":"10"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"marker.move","markerId":"c1","position":"0","length":"0"})") == "invalid_marker");
    CHECK(errorCode(doc, R"({"op":"marker.move","markerId":"c1","position":"4398046511000"})") == "invalid_marker");
    CHECK(errorCode(doc, R"({"op":"marker.move","markerId":"p1","position":"-5"})") == "invalid_marker");
    CHECK(errorCode(doc, R"({"op":"marker.move","markerId":"zz","position":"0"})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"marker.move","markerId":"p1"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"marker.move","markerId":"p1","position":"0","name":"x"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"marker.move","markerId":"p1","position":"0","number":2})") == "invalid_params");
}

TEST_CASE("marker.rename sets the name, empty included, and declares exactly the marker", "[command][markers]") {
    const Document doc = applied(base(), addMarker("p1", R"(,"name":"Intro")"));
    const auto renamed = prepare(doc, cmd(R"({"op":"marker.rename","markerId":"p1","name":"Verse 1"})"));
    CHECK(renamed.effects == DeclaredEffects{ref(EntityType::marker, "p1")});
    CHECK(renamed.result.marker("p1")->name == "Verse 1");
    CHECK(renamed.result.marker("p1")->position == 1000);
    const auto cleared = prepare(renamed.result, cmd(R"({"op":"marker.rename","markerId":"p1","name":""})"));
    CHECK(cleared.result.marker("p1")->name.empty());
    CHECK(errorCode(doc, R"({"op":"marker.rename","markerId":"zz","name":"x"})") == "not_found");
    CHECK(errorCode(doc, R"({"op":"marker.rename","markerId":"p1"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"marker.rename","markerId":"p1","name":null})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"marker.rename","markerId":"p1","name":"x","position":"0"})") == "invalid_params");
    CHECK(errorCode(doc, R"({"op":"marker.rename","markerId":"p1","name":")" + std::string(256, 'a') + "\"}") ==
          "invalid_marker");
}

TEST_CASE("marker.add and marker.rename refuse a display-unsafe name with invalid_name", "[command][names][markers]") {
    const Document doc = applied(base(), addMarker("p1", R"(,"name":"Intro")"));
    for (const std::string& name : kUnsafeNames) {
        INFO(name);
        CHECK(errorCodeOf(doc, withName(Object{{"op", Value("marker.add")}, {"markerId", Value("p2")},
                                               {"position", Value("0")}},
                                        name)) == "invalid_name");
        CHECK(errorCodeOf(doc, withName(Object{{"op", Value("marker.rename")}, {"markerId", Value("p1")}}, name)) ==
              "invalid_name");
    }
    CHECK(errorCode(doc, R"({"op":"marker.rename","markerId":"p1","name":"副歌 Chorus"})") == "no error");
    // The length rule stays invalid_marker.
    CHECK(errorCode(doc, R"({"op":"marker.rename","markerId":"p1","name":")" + std::string(256, 'a') + "\"}") ==
          "invalid_marker");
}

TEST_CASE("marker.remove removes the marker and declares exactly it", "[command][markers]") {
    const Document doc = base();
    const Document with = applied(doc, addMarker("p1"));
    const auto removed = prepare(with, cmd(R"({"op":"marker.remove","markerId":"p1"})"));
    CHECK(removed.effects == DeclaredEffects{ref(EntityType::marker, "p1")});
    CHECK(removed.result.marker("p1") == nullptr);
    CHECK(removed.result.documentHash() == doc.documentHash());
    CHECK(removed.result.toJson().find("markers") == nullptr);
    CHECK(errorCode(doc, R"({"op":"marker.remove","markerId":"p1"})") == "not_found");
    CHECK(errorCode(with, R"({"op":"marker.remove","markerId":"p1","extra":true})") == "invalid_params");
    CHECK(errorCode(with, R"({"op":"marker.remove"})") == "invalid_params");
    // No marker command has cascades.
    const auto cascades = siann::command::commandCascades();
    for (const char* name : {"marker.add", "marker.move", "marker.rename", "marker.remove"}) {
        CHECK(cascades.count(name) == 0);
    }
}

TEST_CASE("Marker commands pass the declared-effects check inside a transaction", "[command][markers]") {
    const Document doc = base();
    const auto prepared = prepareTransaction(
        doc, {cmd(addMarker("p1")), cmd(addMarker("p2")), cmd(R"({"op":"marker.move","markerId":"p1","position":"5"})"),
              cmd(R"({"op":"marker.rename","markerId":"p2","name":"B"})")});
    CHECK(prepared.effects == DeclaredEffects{ref(EntityType::marker, "p1"), ref(EntityType::marker, "p2")});
    CHECK(numberOf(prepared.result, "p2") == 2);
    const auto back = prepareTransaction(doc, {cmd(addMarker("p1")), cmd(R"({"op":"marker.remove","markerId":"p1"})")});
    CHECK(back.result.documentHash() == doc.documentHash());
}
