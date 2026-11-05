// Plan and proposal methods (architecture spec, Protocol v0 item 14, m3-mcp)
// against the in-memory transport: pump() runs on the test thread.

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <utility>
#include <vector>

#include "support/protocol_fixture.hpp"
#include "siann/command/plan.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/protocol/about.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;

namespace {

Value trackGain(const std::string& id, int milliDb) {
    return Value(Object{{"op", Value("track.set_gain")}, {"trackId", Value(id)}, {"gainMilliDb", Value(milliDb)}});
}

Value stepsParams(Array steps) {
    return Value(Object{{"steps", Value(std::move(steps))}});
}

Value planParams(const std::string& plan) {
    return Value(Object{{"plan", Value(plan)}});
}

std::vector<std::string> refsOf(const Value& entitySet) {
    std::vector<std::string> out;
    for (const Value& entry : entitySet.asArray()) {
        out.push_back(at(entry, "type").asString() + ":" + at(entry, "id").asString());
    }
    return out;
}

std::vector<std::string> types(const std::vector<Value>& events) {
    std::vector<std::string> out;
    for (const Value& event : events) {
        out.push_back(at(event, "type").asString());
    }
    return out;
}

const Value& errorOf(const Value& response) {
    INFO(canonical(response));
    REQUIRE_FALSE(at(response, "ok").asBool());
    return at(response, "error");
}

// A fixture with trk_a on main (r2); returns the submitted plan's hash.
std::string submitted(Fixture& f, ConnectionId c, Array steps) {
    const Value plan = f.ok(c, "plan.submit", stepsParams(std::move(steps)));
    return at(plan, "hash").asString();
}

}  // namespace

TEST_CASE("plan.submit returns a validated siann.plan.v1 with the writeSet from declared effects",
          "[protocol][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});

    const Value plan = f.ok(c, "plan.submit",
                            Value(Object{{"steps", Value(Array{trackGain("trk_a", -600), trackAdd("trk_b")})},
                                         {"readSet", Value(Array{Value("root:root")})}}));
    CHECK(at(plan, "schema").asString() == "siann.plan.v1");
    CHECK(at(plan, "state").asString() == "validated");
    CHECK(at(plan, "baseRevision").asString() == "r2");
    CHECK(refsOf(at(plan, "writeSet")) == std::vector<std::string>{"root:root", "track:trk_a", "track:trk_b"});
    CHECK(refsOf(at(plan, "readSet")) == std::vector<std::string>{"root:root"});
    // The hash follows command::planHash over the returned object.
    CHECK(at(plan, "hash").asString() == hash::formatHash(command::planHash(command::Plan::fromJson(plan))));

    CHECK(errorCode(f.call(c, "plan.submit", Value(Object{}))) == "invalid_params");
    CHECK(errorCode(f.call(c, "plan.submit", Value(Object{{"steps", Value(Array{trackGain("trk_a", -600)})},
                                                          {"readSet", Value(Array{Value("bogus")})}}))) ==
          "invalid_params");
    CHECK(errorCode(f.call(c, "plan.submit", stepsParams(Array{trackGain("nope", 0)}))) == "not_found");
}

TEST_CASE("plan.status reports stale entities after a conflicting commit", "[protocol][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    const std::string plan = submitted(f, c, Array{trackGain("trk_a", -600)});

    Value status = f.ok(c, "plan.status", planParams(plan));
    CHECK(at(status, "hash").asString() == plan);
    CHECK(at(status, "stale").asArray().empty());
    CHECK(status.find("proposalBranch") == nullptr);

    f.commit(c, Array{trackGain("trk_a", -100)});
    status = f.ok(c, "plan.status", planParams(plan));
    REQUIRE(at(status, "stale").asArray().size() == 1);
    CHECK(at(at(status, "stale").asArray()[0], "ref").asString() == "track:trk_a");
    CHECK(at(at(status, "stale").asArray()[0], "change").asString() == "modified");

    // plan_stale carries the plan and the changed entities as data.
    const Value& error = errorOf(f.call(c, "plan.approve", planParams(plan)));
    CHECK(at(error, "code").asString() == "plan_stale");
    const Value& data = at(error, "data");
    CHECK(at(data, "plan").asString() == plan);
    REQUIRE(at(data, "changedEntities").asArray().size() == 1);
    CHECK(at(at(data, "changedEntities").asArray()[0], "ref").asString() == "track:trk_a");
    CHECK(at(at(data, "changedEntities").asArray()[0], "change").asString() == "modified");

    CHECK(errorCode(f.call(c, "plan.status", planParams("sha256:" + std::string(64, '0')))) == "not_found");
    CHECK(errorCode(f.call(c, "plan.status", Value(Object{}))) == "invalid_params");
}

TEST_CASE("plan.approve then plan.apply publishes one plan revision and session.changed", "[protocol][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    f.commit(c, Array{trackAdd("trk_a")});
    const std::string plan = submitted(f, c, Array{trackGain("trk_a", -600), trackAdd("trk_b")});

    const Value approved = f.ok(c, "plan.approve", planParams(plan));
    CHECK(at(approved, "state").asString() == "approved");
    CHECK(at(approved, "approvedBy").asString() == "protocol");
    const std::size_t revisions = f.session.history().revisions().size();
    const std::size_t eventsBefore = f.events(watcher).size();

    const Value applied = f.ok(c, "plan.apply", planParams(plan));
    const Value& revision = at(applied, "revision");
    CHECK(at(revision, "cause").asString() == "plan");
    CHECK(at(revision, "id").asString() == f.head().envelope.id);
    CHECK(f.session.history().revisions().size() == revisions + 1);
    CHECK(f.session.plans().find(plan)->state == command::PlanState::applied);

    const auto events = f.events(watcher);
    REQUIRE(events.size() == eventsBefore + 1);
    CHECK(at(events.back(), "type").asString() == "session.changed");
    CHECK(at(events.back(), "cause").asString() == "plan");
    CHECK(at(events.back(), "revision").asString() == at(revision, "id").asString());

    CHECK(at(f.ok(c, "plan.status", planParams(plan)), "state").asString() == "applied");
    CHECK(errorCode(f.call(c, "plan.apply", planParams(plan))) == "invalid_state");
}

TEST_CASE("plan.approve with steps produces a sub-plan and rejects the original", "[protocol][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    const std::string plan = submitted(f, c, Array{trackGain("trk_a", -600), trackAdd("trk_b")});

    const Value sub = f.ok(c, "plan.approve",
                           Value(Object{{"plan", Value(plan)}, {"steps", Value(Array{Value(1)})}}));
    CHECK(at(sub, "state").asString() == "approved");
    CHECK(at(sub, "parentPlan").asString() == plan);
    CHECK(at(sub, "hash").asString() != plan);
    CHECK(at(sub, "steps").asArray().size() == 1);
    CHECK(at(f.ok(c, "plan.status", planParams(plan)), "state").asString() == "rejected");

    CHECK(errorCode(f.call(c, "plan.approve", Value(Object{{"plan", Value(plan)}, {"steps", Value("1")}}))) ==
          "invalid_params");
}

TEST_CASE("plan.reject marks the plan rejected with its note", "[protocol][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    const std::string plan = submitted(f, c, Array{trackGain("trk_a", -600)});

    const Value rejected = f.ok(c, "plan.reject", Value(Object{{"plan", Value(plan)}, {"note", Value("too loud")}}));
    CHECK(at(rejected, "state").asString() == "rejected");
    CHECK(at(rejected, "rejectionNote").asString() == "too loud");
    CHECK(errorCode(f.call(c, "plan.approve", planParams(plan))) == "invalid_state");
}

TEST_CASE("plan.rollback publishes an inverse revision, rollback_conflict carries the entities",
          "[protocol][plans][rollback]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    const std::string before = hash::formatHash(f.head().envelope.documentHash);
    const std::string plan = submitted(f, c, Array{trackGain("trk_a", -600), trackAdd("trk_b")});
    f.ok(c, "plan.approve", planParams(plan));
    f.ok(c, "plan.apply", planParams(plan));

    SECTION("unchanged entities roll back") {
        const Value rolled = f.ok(c, "plan.rollback", planParams(plan));
        CHECK(at(at(rolled, "revision"), "cause").asString() == "rollback");
        CHECK(at(at(rolled, "revision"), "documentHash").asString() == before);
        CHECK(at(f.ok(c, "plan.status", planParams(plan)), "state").asString() == "rolled_back");
    }
    SECTION("a changed entity is rollback_conflict with data.entities") {
        f.commit(c, Array{trackGain("trk_b", -300)});
        const Value& error = errorOf(f.call(c, "plan.rollback", planParams(plan)));
        CHECK(at(error, "code").asString() == "rollback_conflict");
        REQUIRE(at(at(error, "data"), "entities").asArray().size() == 1);
        CHECK(at(at(error, "data"), "entities").asArray()[0].asString() == "track:trk_b");
    }
}

TEST_CASE("plan.propose opens a branch, proposal.merge lands it, proposal.discard closes one",
          "[protocol][plans][proposals]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    f.commit(c, Array{trackAdd("trk_a")});
    const std::string mainHead = f.head().envelope.id;
    const std::string plan = submitted(f, c, Array{trackAdd("trk_b")});
    f.ok(c, "plan.approve", planParams(plan));
    const std::size_t eventsBefore = f.events(watcher).size();

    const Value proposed = f.ok(c, "plan.propose", planParams(plan));
    CHECK(at(proposed, "branch").asString() == "p1");
    const Value& branchRevision = at(proposed, "revision");
    CHECK(at(branchRevision, "cause").asString() == "plan");
    CHECK(f.head().envelope.id == mainHead);  // main did not move
    CHECK(at(f.ok(c, "plan.status", planParams(plan)), "proposalBranch").asString() == "p1");
    const Value inspected = f.ok(c, "session.inspect");
    CHECK(at(inspected, "branches").asArray().size() == 1);
    CHECK(inspected.find("heard") == nullptr);  // no audition port

    auto events = f.events(watcher);
    REQUIRE(events.size() == eventsBefore + 1);
    CHECK(at(events.back(), "type").asString() == "proposal.changed");
    CHECK(at(events.back(), "branch").asString() == "p1");
    CHECK(at(events.back(), "revision").asString() == at(branchRevision, "id").asString());
    REQUIRE(at(events.back(), "changedIds").asArray().size() == 2);

    SECTION("merge") {
        const Value merged = f.ok(c, "proposal.merge", Value(Object{{"branch", Value("p1")}}));
        const Value& revision = at(merged, "revision");
        CHECK(at(revision, "cause").asString() == "branch-merge");
        CHECK(at(revision, "parents").asArray().size() == 2);
        CHECK(f.head().envelope.id == at(revision, "id").asString());
        CHECK(at(f.ok(c, "plan.status", planParams(plan)), "state").asString() == "applied");
        events = f.events(watcher);
        REQUIRE(events.size() == eventsBefore + 3);
        CHECK(types(events).back() == "proposal.closed");
        CHECK(at(events[events.size() - 2], "type").asString() == "session.changed");
        CHECK(at(events.back(), "branch").asString() == "p1");
        CHECK(at(events.back(), "merged").asBool());
        CHECK(at(events.back(), "revision").asString() == at(revision, "id").asString());
        CHECK(errorCode(f.call(c, "proposal.merge", Value(Object{{"branch", Value("p1")}}))) == "not_found");
    }
    SECTION("discard") {
        CHECK(f.ok(c, "proposal.discard", Value(Object{{"branch", Value("p1")}})).asObject().empty());
        CHECK(f.head().envelope.id == mainHead);
        CHECK(at(f.ok(c, "plan.status", planParams(plan)), "state").asString() == "approved");
        events = f.events(watcher);
        REQUIRE(events.size() == eventsBefore + 2);
        CHECK(at(events.back(), "type").asString() == "proposal.closed");
        CHECK_FALSE(at(events.back(), "merged").asBool());
        CHECK(events.back().find("revision") != nullptr);  // the envelope's head revision
        CHECK(at(events.back(), "revision").asString() == mainHead);
        CHECK(errorCode(f.call(c, "proposal.discard", Value(Object{{"branch", Value("p1")}}))) == "not_found");
    }
    SECTION("a conflicting merge is branch_conflict with data.entities") {
        f.commit(c, Array{trackAdd("trk_b")});
        const Value& error = errorOf(f.call(c, "proposal.merge", Value(Object{{"branch", Value("p1")}})));
        CHECK(at(error, "code").asString() == "branch_conflict");
        const auto& entities = at(at(error, "data"), "entities").asArray();
        REQUIRE_FALSE(entities.empty());
        bool named = false;
        for (const Value& entity : entities) {
            named = named || entity.asString() == "track:trk_b";
        }
        CHECK(named);
    }
}

TEST_CASE("a merged proposal rolls back through plan.rollback", "[protocol][plans][proposals][rollback]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    const std::string before = hash::formatHash(f.head().envelope.documentHash);
    const std::string plan = submitted(f, c, Array{trackAdd("trk_b")});
    f.ok(c, "plan.approve", planParams(plan));
    f.ok(c, "plan.propose", planParams(plan));
    f.ok(c, "proposal.merge", Value(Object{{"branch", Value("p1")}}));

    const Value rolled = f.ok(c, "plan.rollback", planParams(plan));
    CHECK(at(at(rolled, "revision"), "documentHash").asString() == before);
}

TEST_CASE("expectedRevision guards the plan methods and duplicates return the cached text", "[protocol][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    const std::string plan = submitted(f, c, Array{trackGain("trk_a", -600)});

    const auto send = [&](const std::string& requestId, const std::string& method, Value params,
                          const std::string& expected) {
        Object envelope{{"requestId", Value(requestId)},
                        {"sessionId", Value(f.server.sessionId())},
                        {"method", Value(method)},
                        {"params", std::move(params)}};
        if (!expected.empty()) {
            envelope.emplace_back("expectedRevision", Value(expected));
        }
        f.transport.deliver(c, jcs::canonicalize(Value(std::move(envelope))));
        f.server.pump();
        return f.transport.sent(c).back();
    };

    const std::vector<std::pair<std::string, Value>> methods = {
        {"command.list", Value(Object{})},
        {"engine.capabilities", Value(Object{})},
        {"plan.submit", stepsParams(Array{trackGain("trk_a", -100)})},
        {"plan.status", planParams(plan)},
        {"plan.approve", planParams(plan)},
        {"plan.reject", planParams(plan)},
        {"plan.apply", planParams(plan)},
        {"plan.rollback", planParams(plan)},
        {"plan.propose", planParams(plan)},
        {"proposal.merge", Value(Object{{"branch", Value("p1")}})},
        {"proposal.discard", Value(Object{{"branch", Value("p1")}})},
        {"audition.hear", Value(Object{{"side", Value("main")}})},
        {"render.start", Value(Object{{"name", Value("mix")}})},
        {"job.status", Value(Object{{"jobId", Value("job_1")}})},
        {"session.save", Value(Object{})},
        {"session.open", Value(Object{{"path", Value("nowhere")}})},
    };
    int n = 0;
    for (const auto& [method, params] : methods) {
        INFO(method);
        const Value response = json::parse(send("guard_" + std::to_string(++n), method, params, "r1"));
        CHECK(errorCode(response) == "revision_mismatch");
    }
    CHECK(f.session.plans().find(plan)->state == command::PlanState::validated);

    const std::string first = send("dup", "plan.approve", planParams(plan), "");
    CHECK(at(json::parse(first), "ok").asBool());
    const std::string again = send("dup", "plan.approve", planParams(plan), "");
    CHECK(again == first);
}

TEST_CASE("command.list and engine.capabilities describe the registry and the server", "[protocol][plans]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const Value listed = f.ok(c, "command.list");
    Array expected;
    for (const std::string& name : command::commandNames()) {
        expected.push_back(Value(name));
    }
    CHECK(canonical(at(listed, "commands")) == canonical(Value(expected)));

    const Value capabilities = f.ok(c, "engine.capabilities");
    CHECK(canonical(at(capabilities, "about")) == canonical(protocol::aboutJson()));
    CHECK(at(capabilities, "scope").asString() == "propose");
    CHECK(canonical(at(capabilities, "scopes")) == R"(["propose","trusted"])");
    CHECK(canonical(at(capabilities, "commands")) == canonical(Value(expected)));
    bool hasPlanSubmit = false;
    for (const Value& method : at(capabilities, "methods").asArray()) {
        hasPlanSubmit = hasPlanSubmit || method.asString() == "plan.submit";
    }
    CHECK(hasPlanSubmit);
    const Value& features = at(capabilities, "features");
    CHECK(at(features, "plans").asBool());
    CHECK(at(features, "proposals").asBool());
    CHECK_FALSE(at(features, "audition").asBool());
    CHECK(at(features, "render").asBool());
    CHECK_FALSE(at(features, "plugins").asBool());
    CHECK(at(at(capabilities, "limits"), "syncChunkEntities").asNumber() == 500);
}
