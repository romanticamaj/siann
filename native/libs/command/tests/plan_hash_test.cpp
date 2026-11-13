#include <catch2/catch_test_macros.hpp>

#include <optional>
#include <stdexcept>
#include <string>

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
    const Value& c = validCase("locators_write_set");
    const Plan plan = Plan::fromJson(*c.find("plan"));
    REQUIRE(plan.writeSet.size() == 1);
    CHECK(plan.writeSet[0].ref == siann::model::EntityRef{siann::model::EntityType::locators, "locators"});
    CHECK(formatHash(planHash(plan)) == c.find("planHash")->asString());
}

TEST_CASE("Invalid plans are rejected with the fixture's code", "[plan][fixtures]") {
    for (const Value& c : fixture().find("invalid")->asArray()) {
        INFO(c.find("name")->asString());
        CHECK(errorCode(c.find("planText")->asString()) == c.find("error")->asString());
    }
}
