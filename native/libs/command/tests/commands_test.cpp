#include <catch2/catch_test_macros.hpp>

#include <string>

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

TEST_CASE("The command catalog is listed", "[command]") {
    const auto names = commandNames();
    CHECK(names == std::vector<std::string>{
                       "clip.move", "clip.place", "clip.remove", "clip.set_gain", "clip.trim", "media.add",
                       "media.remove", "session.rename", "session.set_tempo", "track.add", "track.remove",
                       "track.rename", "track.set_gain", "track.set_mute", "track.set_pan", "track.set_solo"});
}
