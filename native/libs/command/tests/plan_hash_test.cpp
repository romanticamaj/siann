#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>

#include "fixture_util.hpp"
#include "siann/command/plan.hpp"
#include "siann/hash/jcs.hpp"

using siann::command::CommandError;
using siann::command::Plan;
using siann::command::PlanState;
using siann::command::planHash;
using siann::hash::formatHash;
using siann::json::Value;

namespace {

const Value& fixture() {
    static const Value value = siann::test::readFixture("plan/plan-hash.json");
    return value;
}

const Value& validCase(const std::string& name) {
    for (const Value& c : fixture().find("valid")->asArray()) {
        if (c.find("name")->asString() == name) {
            return c;
        }
    }
    throw std::runtime_error("no fixture case " + name);
}

std::string errorCode(const std::string& text) {
    try {
        (void)planHash(Plan::parse(text));
    } catch (const CommandError& error) {
        return error.code();
    }
    return "no error";
}

}  // namespace

TEST_CASE("The plan hash fixture has the expected schema", "[plan][fixtures]") {
    CHECK(fixture().find("schemaVersion")->asString() == "siann.plan_hash_fixtures.v1");
    CHECK(fixture().find("valid")->asArray().size() >= 8);
    CHECK(fixture().find("invalid")->asArray().size() >= 3);
}

TEST_CASE("planHash reproduces every shared fixture", "[plan][fixtures]") {
    for (const Value& c : fixture().find("valid")->asArray()) {
        const std::string& name = c.find("name")->asString();
        INFO(name);
        const Plan plan = Plan::fromJson(*c.find("plan"));
        CHECK(formatHash(planHash(plan)) == c.find("planHash")->asString());
        // A JSON round trip keeps the hash.
        CHECK(formatHash(planHash(Plan::fromJson(plan.toJson()))) == c.find("planHash")->asString());
    }
}

TEST_CASE("planHash ignores the lifecycle fields", "[plan][fixtures]") {
    const Plan withLifecycle = Plan::fromJson(*validCase("lifecycle_fields_ignored").find("plan"));
    CHECK(withLifecycle.state == PlanState::applied);
    CHECK(withLifecycle.approvedBy == std::optional<std::string>{"user"});
    CHECK(withLifecycle.appliedRevision == std::optional<std::string>{"r9"});
    CHECK(planHash(withLifecycle) == planHash(Plan::fromJson(*validCase("minimal_plan").find("plan"))));

    Plan changed = withLifecycle;
    changed.state = PlanState::rejected;
    changed.rejectionNote = "another note";
    changed.hashText = formatHash(siann::hash::Digest{});
    CHECK(planHash(changed) == planHash(withLifecycle));
}

TEST_CASE("A null entity hash means absent at the base revision", "[plan][fixtures]") {
    const Plan plan = Plan::fromJson(*validCase("absent_entity_null_hash").find("plan"));
    REQUIRE(plan.writeSet.size() == 2);
    CHECK(plan.writeSet[0].entityHash.has_value());
    CHECK_FALSE(plan.writeSet[1].entityHash.has_value());
    CHECK(plan.writeSet[1].ref.id == "trk_4");
}

TEST_CASE("parentPlan and step order are part of the hash", "[plan][fixtures]") {
    const auto hashOf = [](const std::string& name) { return planHash(Plan::fromJson(*validCase(name).find("plan"))); };
    CHECK(hashOf("parent_plan_changes_hash") != hashOf("minimal_plan"));
    CHECK(hashOf("step_order_matters") != hashOf("two_steps"));
}

TEST_CASE("A writeSet may name the locators entity", "[plan][fixtures][locators]") {
    const Value* c = &validCase("locators_write_set");  // a pointer: GCC's -Wdangling-reference
    const Plan plan = Plan::fromJson(*c->find("plan"));
    REQUIRE(plan.writeSet.size() == 1);
    CHECK(plan.writeSet[0].ref == siann::model::EntityRef{siann::model::EntityType::locators, "locators"});
    CHECK(formatHash(planHash(plan)) == c->find("planHash")->asString());
}

// m5b-engine-project-media: a media name in media.add and media.rename steps hashes
// as Node hashes it, and the steps run on a document holding the media.
TEST_CASE("Plans with a media name hash as in Node and their steps apply", "[plan][fixtures][media]") {
    siann::model::Document doc = siann::model::Document::create("Song", 48'000);
    for (const char* name : {"media_add_with_name", "media_rename"}) {
        INFO(name);
        const Value* c = &validCase(name);
        const Plan plan = Plan::fromJson(*c->find("plan"));
        CHECK(formatHash(planHash(plan)) == c->find("planHash")->asString());
        CHECK(formatHash(planHash(Plan::fromJson(plan.toJson()))) == c->find("planHash")->asString());
        if (std::string(name) == "media_rename") {
            doc = siann::command::prepare(doc, siann::command::Command::fromJson(siann::json::parse(
                                                   R"({"op":"media.add","mediaId":"med_1","contentHash":"sha256:)" +
                                                   std::string(64, 'c') +
                                                   R"(","format":"wav","channels":2,"sampleRate":48000,"frames":"1"})")))
                      .result;
        }
        const auto applied = siann::command::prepareTransaction(doc, plan.steps);
        if (std::string(name) == "media_add_with_name") {
            REQUIRE(applied.result.media("med_2") != nullptr);
            CHECK(*applied.result.media("med_2")->name == "Kick \xE8\x81\xB2.wav");
        } else {
            CHECK_FALSE(applied.result.media("med_1")->name.has_value());
            CHECK(applied.result.documentHash() == doc.documentHash());
        }
    }
}

// m5b-engine-track-notes: track.set_notes steps hash as in Node, and the plan sets
// the notes and removes them again, so the document returns to its hash.
TEST_CASE("A plan with track.set_notes steps hashes as in Node and its steps apply", "[plan][fixtures][notes]") {
    const Value* c = &validCase("track_notes_steps");  // a pointer: GCC's -Wdangling-reference
    const Plan plan = Plan::fromJson(*c->find("plan"));
    CHECK(formatHash(planHash(plan)) == c->find("planHash")->asString());
    CHECK(formatHash(planHash(Plan::fromJson(plan.toJson()))) == c->find("planHash")->asString());
    REQUIRE(plan.steps.size() == 2);
    CHECK(plan.steps[0].op() == "track.set_notes");

    siann::model::Document doc = siann::model::Document::create("Song", 48'000);
    doc = siann::command::prepare(doc, siann::command::Command::fromJson(siann::json::parse(
                                           R"({"op":"track.add","trackId":"trk_1","name":"Drums","channels":2})")))
              .result;
    const auto first = siann::command::prepare(doc, plan.steps[0]);
    CHECK(*first.result.track("trk_1")->notes == "Verse: double it.\n\xE5\x89\xAF\xE6\xAD\x8C louder");
    const auto applied = siann::command::prepareTransaction(doc, plan.steps);
    CHECK_FALSE(applied.result.track("trk_1")->notes.has_value());
    CHECK(applied.result.documentHash() == doc.documentHash());
}

TEST_CASE("Invalid plans are rejected with the fixture's code", "[plan][fixtures]") {
    for (const Value& c : fixture().find("invalid")->asArray()) {
        INFO(c.find("name")->asString());
        CHECK(errorCode(c.find("planText")->asString()) == c.find("error")->asString());
    }
}

// m5b-engine-master: master is a singleton entity type of the plan entity sets.
TEST_CASE("A writeSet may name the master entity, and only by the id master", "[plan][fixtures][master]") {
    const Value* c = &validCase("master_write_set");  // a pointer: GCC's -Wdangling-reference
    const Plan plan = Plan::fromJson(*c->find("plan"));
    REQUIRE(plan.writeSet.size() == 1);
    CHECK(plan.writeSet[0].ref == siann::model::EntityRef{siann::model::EntityType::master, "master"});
    CHECK_FALSE(plan.writeSet[0].entityHash.has_value());
    REQUIRE(plan.steps.size() == 1);
    CHECK(plan.steps[0].op() == "master.set_gain");
    CHECK(formatHash(planHash(plan)) == c->find("planHash")->asString());
    CHECK(formatHash(planHash(Plan::fromJson(plan.toJson()))) == c->find("planHash")->asString());
}

// m5b-engine-plan-metadata: title, intent and actor are metadata beside the plan.
// Each fixture case hashes as its untitled twin, round-trips through JSON, and
// the fields are in the excluded list.
TEST_CASE("A plan with and without title, intent and actor has the same planHash", "[plan][fixtures][metadata]") {
    const auto& excluded = siann::command::planHashExcludedFields();
    for (const std::string_view key : {"title", "intent", "actor"}) {
        INFO(key);
        CHECK(std::find(excluded.begin(), excluded.end(), key) != excluded.end());
    }
    const auto hashOf = [](const std::string& name) { return planHash(Plan::fromJson(*validCase(name).find("plan"))); };
    for (const char* name : {"titled_plan", "plan_with_intent", "plan_with_actor"}) {
        INFO(name);
        CHECK(hashOf(name) == hashOf("minimal_plan"));
    }
    CHECK(hashOf("non_ascii_title") == hashOf("two_steps"));

    const Value* c = &validCase("non_ascii_title");  // a pointer: GCC's -Wdangling-reference
    const Plan plan = Plan::fromJson(*c->find("plan"));
    CHECK(plan.title ==
          std::optional<std::string>{"\xE9\xBC\x93\xE8\x81\xB2\xE9\x99\x8D\xE4\xBD\x8E \xF0\x9F\xA5\x81"});
    CHECK(plan.intent ==
          std::optional<std::string>{"\xE8\xAE\x93\xE4\xBA\xBA\xE8\x81\xB2\xE6\x9B\xB4\xE6\xB8\x85\xE6\xA5\x9A"});
    REQUIRE(plan.actor.has_value());
    CHECK(plan.actor->kind == siann::command::PlanActorKind::ui);
    CHECK(plan.actor->name == "SIANN");
    // toJson writes them back; fromJson reads the same plan again.
    const Value json = plan.toJson();
    CHECK(json.find("title")->asString() == *plan.title);
    CHECK(json.find("intent")->asString() == *plan.intent);
    CHECK(siann::jcs::canonicalize(*json.find("actor")) == R"({"kind":"ui","name":"SIANN"})");
    const Plan again = Plan::fromJson(json);
    CHECK(again.title == plan.title);
    CHECK(again.intent == plan.intent);
    CHECK(again.actor == plan.actor);
    CHECK(formatHash(planHash(again)) == c->find("planHash")->asString());

    // Without them nothing is written.
    const Value bare = Plan::fromJson(*validCase("minimal_plan").find("plan")).toJson();
    CHECK(bare.find("title") == nullptr);
    CHECK(bare.find("intent") == nullptr);
    CHECK(bare.find("actor") == nullptr);
}

// m5b-engine-clip-fades: a plan step may set a fade. The fixture's step hashes as
// Node says and prepares against the v2 model fixture, touching clip:clp_1 only.
TEST_CASE("A clip.set_fade step hashes as the fixture says and prepares against the document",
          "[plan][fixtures][fades]") {
    const Value* c = &validCase("clip_set_fade_step");  // a pointer: GCC's -Wdangling-reference
    const Plan plan = Plan::fromJson(*c->find("plan"));
    REQUIRE(plan.steps.size() == 1);
    CHECK(plan.steps[0].op() == "clip.set_fade");
    CHECK(formatHash(planHash(plan)) == c->find("planHash")->asString());
    const auto doc = siann::model::Document::fromJson(
        *siann::test::readFixture("model/session-document-v2.json").find("document"));
    const auto prepared = siann::command::prepare(doc, plan.steps[0]);
    CHECK(prepared.effects ==
          siann::command::DeclaredEffects{siann::model::EntityRef{siann::model::EntityType::clip, "clp_1"}});
    const auto* clip = prepared.result.clip("clp_1");
    REQUIRE(clip != nullptr);
    CHECK(clip->fadeIn.length == 480);
    CHECK(clip->fadeOut.length == 960);
    CHECK(clip->fadeOut.curve == siann::model::FadeCurve::equal_power);
}
