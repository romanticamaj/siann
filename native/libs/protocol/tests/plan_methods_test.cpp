// Plan and proposal methods (architecture spec, Protocol v0 item 14, m3-mcp)
// against the in-memory transport: pump() runs on the test thread.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <optional>
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

// The events without plan.changed (Protocol v0 item 25), for the tests that
// count the revision and proposal events of a plan method.
std::vector<Value> nonPlan(std::vector<Value> events) {
    std::erase_if(events, [](const Value& event) { return at(event, "type").asString() == "plan.changed"; });
    return events;
}

// A copy: callers pass the temporary response of call().
Value errorOf(const Value& response) {
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
    const std::size_t eventsBefore = nonPlan(f.events(watcher)).size();

    const Value applied = f.ok(c, "plan.apply", planParams(plan));
    const Value& revision = at(applied, "revision");
    CHECK(at(revision, "cause").asString() == "plan");
    CHECK(at(revision, "id").asString() == f.head().envelope.id);
    CHECK(f.session.history().revisions().size() == revisions + 1);
    CHECK(f.session.plans().find(plan)->state == command::PlanState::applied);

    const auto events = nonPlan(f.events(watcher));
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
    const std::size_t eventsBefore = nonPlan(f.events(watcher)).size();

    const Value proposed = f.ok(c, "plan.propose", planParams(plan));
    CHECK(at(proposed, "branch").asString() == "p1");
    const Value& branchRevision = at(proposed, "revision");
    CHECK(at(branchRevision, "cause").asString() == "plan");
    CHECK(f.head().envelope.id == mainHead);  // main did not move
    CHECK(at(f.ok(c, "plan.status", planParams(plan)), "proposalBranch").asString() == "p1");
    const Value inspected = f.ok(c, "session.inspect");
    CHECK(at(inspected, "branches").asArray().size() == 1);
    CHECK(inspected.find("heard") == nullptr);  // no audition port

    auto events = nonPlan(f.events(watcher));
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
        events = nonPlan(f.events(watcher));
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
        events = nonPlan(f.events(watcher));
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

// Plans in the UI (spec, Protocol v0 item 25; docs/schemas/plan-v1.md,
// "Protocol methods"; protocol-events-v1.md, plan.changed).

namespace {

std::vector<std::string> refsOfEntities(const Value& entities) {
    std::vector<std::string> out;
    for (const Value& entry : entities.asArray()) {
        out.push_back(at(entry, "ref").asString());
    }
    return out;
}

Value entityRow(const Value& preview, const std::string& ref) {
    for (const Value& entry : at(preview, "entities").asArray()) {
        if (at(entry, "ref").asString() == ref) {
            return entry;
        }
    }
    FAIL("no preview row " << ref);
    return preview;
}

// The plan.changed events of a connection after the first `from` events, as
// "<plan> <state>[ <proposalBranch>]".
std::vector<std::string> planChanges(const Fixture& f, ConnectionId watcher, std::size_t from) {
    std::vector<std::string> out;
    const auto all = f.events(watcher);
    for (std::size_t i = from; i < all.size(); ++i) {
        const Value& event = all[i];
        if (at(event, "type").asString() != "plan.changed") {
            continue;
        }
        std::string line = at(event, "plan").asString() + " " + at(event, "state").asString();
        if (const Value* branch = event.find("proposalBranch")) {
            line += " " + branch->asString();
        }
        out.push_back(line);
    }
    return out;
}

Value trackRemove(const std::string& id) {
    return Value(Object{{"op", Value("track.remove")}, {"trackId", Value(id)}});
}

}  // namespace

TEST_CASE("plan.list lists every plan in submission order as plan.status returns it", "[protocol][plans][ui]") {
    Fixture f;
    const ConnectionId c = f.authed();
    CHECK(canonical(f.ok(c, "plan.list")) == R"({"plans":[]})");

    f.commit(c, Array{trackAdd("trk_a")});
    const std::string first = submitted(f, c, Array{trackGain("trk_a", -600)});
    const std::string second = submitted(f, c, Array{trackAdd("trk_b")});
    f.ok(c, "plan.approve", planParams(second));
    f.ok(c, "plan.propose", planParams(second));
    f.commit(c, Array{trackGain("trk_a", -100)});  // makes the first plan stale

    const Value listed = f.ok(c, "plan.list");
    const auto& plans = at(listed, "plans").asArray();
    REQUIRE(plans.size() == 2);
    CHECK(at(plans[0], "hash").asString() == first);
    CHECK(at(plans[1], "hash").asString() == second);
    CHECK(canonical(plans[0]) == canonical(f.ok(c, "plan.status", planParams(first))));
    CHECK(canonical(plans[1]) == canonical(f.ok(c, "plan.status", planParams(second))));
    CHECK(at(plans[0], "stale").asArray().size() == 1);
    CHECK(at(plans[1], "proposalBranch").asString() == "p1");
}

TEST_CASE("plan.preview answers the prepared entities at the head and commits nothing", "[protocol][plans][ui]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    f.commit(c, Array{trackAdd("trk_a")});
    const std::string plan = submitted(f, c, Array{trackAdd("trk_n"), trackGain("trk_a", -600)});
    const std::string head = f.head().envelope.id;
    const std::size_t revisions = f.session.history().revisions().size();
    const std::size_t eventsBefore = f.events(watcher).size();

    const Value preview = f.ok(c, "plan.preview", planParams(plan));
    CHECK(at(preview, "revision").asString() == head);
    CHECK(at(preview, "documentHash").asString() == hash::formatHash(f.head().envelope.documentHash));
    CHECK(at(preview, "stale").asArray().empty());
    CHECK(refsOfEntities(at(preview, "entities")) ==
          std::vector<std::string>{"root:root", "track:trk_a", "track:trk_n"});

    const Value root = entityRow(preview, "root:root");
    CHECK(at(at(root, "before"), "trackOrder").asArray().size() == 1);
    CHECK(at(at(root, "after"), "trackOrder").asArray().size() == 2);
    const Value gained = entityRow(preview, "track:trk_a");
    CHECK(at(at(gained, "before"), "gainMilliDb").asNumber() == 0);
    CHECK(at(at(gained, "after"), "gainMilliDb").asNumber() == -600);
    const Value added = entityRow(preview, "track:trk_n");
    CHECK(at(added, "before").kind() == Value::Kind::null);
    CHECK(at(at(added, "after"), "id").asString() == "trk_n");
    CHECK(at(at(added, "after"), "name").asString() == "trk_n");

    // Nothing committed, nothing published, the plan untouched.
    CHECK(f.head().envelope.id == head);
    CHECK(f.session.history().revisions().size() == revisions);
    CHECK(f.events(watcher).size() == eventsBefore);
    CHECK(f.session.plans().find(plan)->state == command::PlanState::validated);

    // Any state previews, against the head: once applied, the head already
    // holds trk_n, so the plan's track.add answers already_exists (the UI
    // shows "applied at <revision>" instead of previewing a landed plan).
    f.ok(c, "plan.approve", planParams(plan));
    f.ok(c, "plan.apply", planParams(plan));
    CHECK(errorCode(f.call(c, "plan.preview", planParams(plan))) == "already_exists");

    CHECK(errorCode(f.call(c, "plan.preview", planParams("sha256:" + std::string(64, '0')))) == "not_found");
    CHECK(errorCode(f.call(c, "plan.preview", Value(Object{}))) == "invalid_params");
}

TEST_CASE("plan.preview of a step that fails at the head answers its error with the step", "[protocol][plans][ui]") {
    Fixture f;
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    const std::string plan = submitted(f, c, Array{trackAdd("trk_n"), trackGain("trk_a", -600)});
    f.commit(c, Array{trackRemove("trk_a")});

    const Value& error = errorOf(f.call(c, "plan.preview", planParams(plan)));
    CHECK(at(error, "code").asString() == "not_found");
    CHECK(at(error, "step").asNumber() == 1);
    CHECK(f.session.plans().find(plan)->state == command::PlanState::validated);
}

TEST_CASE("plan.changed is published once per plan transition", "[protocol][plans][ui]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    f.commit(c, Array{trackAdd("trk_a")});
    std::size_t mark = f.events(watcher).size();
    const auto changes = [&] {
        auto out = planChanges(f, watcher, mark);
        mark = f.events(watcher).size();
        return out;
    };

    const std::string plan = submitted(f, c, Array{trackGain("trk_a", -600)});
    CHECK(changes() == std::vector<std::string>{plan + " validated"});
    submitted(f, c, Array{trackGain("trk_a", -600)});  // the same plan again: no transition
    CHECK(changes().empty());
    f.ok(c, "plan.status", planParams(plan));
    f.ok(c, "plan.list");
    f.ok(c, "plan.preview", planParams(plan));
    CHECK(changes().empty());

    SECTION("approve, apply, rollback") {
        f.ok(c, "plan.approve", planParams(plan));
        CHECK(changes() == std::vector<std::string>{plan + " approved"});
        CHECK(errorCode(f.call(c, "plan.approve", planParams(plan))) == "invalid_state");
        CHECK(changes().empty());
        f.ok(c, "plan.apply", planParams(plan));
        const auto all = f.events(watcher);
        CHECK(changes() == std::vector<std::string>{plan + " applied"});
        // After the commit's session.changed.
        REQUIRE(all.size() >= 2);
        CHECK(at(all[all.size() - 2], "type").asString() == "session.changed");
        f.ok(c, "plan.rollback", planParams(plan));
        CHECK(changes() == std::vector<std::string>{plan + " rolled_back"});
    }
    SECTION("reject") {
        f.ok(c, "plan.reject", Value(Object{{"plan", Value(plan)}, {"note", Value("no")}}));
        CHECK(changes() == std::vector<std::string>{plan + " rejected"});
        // A rejected plan still previews.
        CHECK(at(entityRow(f.ok(c, "plan.preview", planParams(plan)), "track:trk_a"), "after").find("gainMilliDb")
                  ->asNumber() == -600);
    }
    SECTION("propose, then merge") {
        f.ok(c, "plan.approve", planParams(plan));
        changes();
        f.ok(c, "plan.propose", planParams(plan));
        CHECK(changes() == std::vector<std::string>{plan + " approved p1"});
        f.ok(c, "proposal.merge", Value(Object{{"branch", Value("p1")}}));
        CHECK(changes() == std::vector<std::string>{plan + " applied"});
    }
    SECTION("propose, then discard") {
        f.ok(c, "plan.approve", planParams(plan));
        f.ok(c, "plan.propose", planParams(plan));
        changes();
        f.ok(c, "proposal.discard", Value(Object{{"branch", Value("p1")}}));
        CHECK(changes() == std::vector<std::string>{plan + " approved"});
    }
    SECTION("partial approval: the original rejected, then the sub-plan approved") {
        const std::string two = submitted(f, c, Array{trackGain("trk_a", -300), trackAdd("trk_b")});
        changes();
        const Value sub = f.ok(c, "plan.approve", Value(Object{{"plan", Value(two)}, {"steps", Value(Array{Value(1)})}}));
        CHECK(changes() ==
              std::vector<std::string>{two + " rejected", at(sub, "hash").asString() + " approved"});
    }
    SECTION("partial approval answering plan_stale: the original rejected, then the sub-plan validated") {
        const std::string two = submitted(f, c, Array{trackGain("trk_a", -300), trackAdd("trk_b")});
        f.commit(c, Array{trackGain("trk_a", -100)});  // trk_a changes after the submit
        changes();
        const Value& error =
            errorOf(f.call(c, "plan.approve", Value(Object{{"plan", Value(two)}, {"steps", Value(Array{Value(0)})}})));
        CHECK(at(error, "code").asString() == "plan_stale");
        const std::string sub = at(at(error, "data"), "plan").asString();
        CHECK(sub != two);
        CHECK(changes() == std::vector<std::string>{two + " rejected", sub + " validated"});
        CHECK(at(f.ok(c, "plan.status", planParams(sub)), "state").asString() == "validated");
    }
}

TEST_CASE("engine.capabilities lists plan.list and plan.preview", "[protocol][plans][ui]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const Value capabilities = f.ok(c, "engine.capabilities");
    std::vector<std::string> methods;
    for (const Value& method : at(capabilities, "methods").asArray()) {
        methods.push_back(method.asString());
    }
    CHECK(std::count(methods.begin(), methods.end(), "plan.list") == 1);
    CHECK(std::count(methods.begin(), methods.end(), "plan.preview") == 1);
}

// Plan metadata (m5b-engine-plan-metadata, UI redesign E-7; spec "Plans",
// decisions of 2026-11-15; docs/schemas/plan-v1.md, "Metadata").

namespace {

// A command connection authenticated with `client` in its auth frame (absent
// when null), subscribed to events when `events`.
ConnectionId authedAs(Fixture& f, const Value& client, bool events = false) {
    Object frame{{"type", Value("auth")}, {"token", Value(f.server.token())}};
    if (events) {
        frame.emplace_back("events", Value(true));
    }
    if (!client.isNull()) {
        frame.emplace_back("client", client);
    }
    auto upgrade = f.transport.connect();
    REQUIRE(upgrade.connection.has_value());
    f.transport.deliver(*upgrade.connection, canonical(Value(std::move(frame))));
    REQUIRE(f.transport.sent(*upgrade.connection).size() == 1);
    REQUIRE(at(json::parse(f.transport.sent(*upgrade.connection)[0]), "ok").asBool());
    return *upgrade.connection;
}

Value named(const std::string& name) {
    return Value(Object{{"name", Value(name)}});
}

Value withMetadata(Array steps, std::optional<Value> title, std::optional<Value> intent = std::nullopt) {
    Object params{{"steps", Value(std::move(steps))}};
    if (title) {
        params.emplace_back("title", *title);
    }
    if (intent) {
        params.emplace_back("intent", *intent);
    }
    return Value(std::move(params));
}

std::vector<Value> planEvents(const Fixture& f, ConnectionId watcher) {
    std::vector<Value> out;
    for (Value& event : f.events(watcher)) {
        if (at(event, "type").asString() == "plan.changed") {
            out.push_back(std::move(event));
        }
    }
    return out;
}

std::string actorOf(const Value& plan) {
    const Value* actor = plan.find("actor");
    return actor == nullptr ? "none" : canonical(*actor);
}

}  // namespace

TEST_CASE("plan.submit refuses a title or intent outside the limits with invalid_plan_metadata",
          "[protocol][plans][metadata]") {
    Fixture f;
    const ConnectionId c = f.authed();
    const ConnectionId watcher = f.authed(true);
    f.commit(c, Array{trackAdd("trk_a")});
    const std::size_t before = f.events(watcher).size();
    const Array steps{trackGain("trk_a", -600)};
    // U+9F13 is three UTF-8 bytes: 66 of them and two ASCII bytes are 200 bytes, 67 are 201.
    std::string threeByte66;
    for (int i = 0; i < 66; ++i) {
        threeByte66 += "\xE9\xBC\x93";
    }

    const auto refused = [&](std::optional<Value> title, std::optional<Value> intent) {
        INFO((title ? canonical(*title).substr(0, 40) : "-") << " / " << (intent ? canonical(*intent).substr(0, 40) : "-"));
        CHECK(errorCode(f.call(c, "plan.submit", withMetadata(steps, std::move(title), std::move(intent)))) ==
              "invalid_plan_metadata");
    };
    refused(Value(std::string(201, 'a')), std::nullopt);
    refused(Value(threeByte66 + "\xE9\xBC\x93"), std::nullopt);  // 67 characters, 201 bytes
    refused(Value("two\nlines"), std::nullopt);
    refused(Value("carriage\rreturn"), std::nullopt);
    refused(Value(std::string("tab\there")), std::nullopt);
    refused(Value(std::string("nul\x01")), std::nullopt);
    refused(Value("\xC2\x85next line"), std::nullopt);  // U+0085, a C1 control
    refused(Value(""), std::nullopt);
    refused(Value(7), std::nullopt);
    refused(Value(nullptr), std::nullopt);
    refused(std::nullopt, Value(std::string(2001, 'i')));
    refused(std::nullopt, Value(""));
    refused(std::nullopt, Value(Array{Value("a")}));
    refused(std::nullopt, Value(std::string("bell\x07")));

    CHECK(at(f.ok(c, "plan.list"), "plans").asArray().empty());
    CHECK(f.events(watcher).size() == before);
    CHECK(planEvents(f, watcher).empty());

    // At the limits: accepted, and the multi-line intent is kept as sent.
    const Value at200 = f.ok(c, "plan.submit", withMetadata(steps, Value(threeByte66 + "ab")));
    CHECK(at(at200, "title").asString().size() == 200);
    const Value multiLine = f.ok(c, "plan.submit", withMetadata(Array{trackGain("trk_a", -300)},
                                                                std::nullopt, Value(std::string(1998, 'i') + "\r\n")));
    CHECK(at(multiLine, "intent").asString().size() == 2000);
    const Value tabbed =
        f.ok(c, "plan.submit", withMetadata(Array{trackGain("trk_a", -100)}, std::nullopt, Value("a\tb\nc")));
    CHECK(at(tabbed, "intent").asString() == "a\tb\nc");
    CHECK(at(f.ok(c, "plan.list"), "plans").asArray().size() == 3);
}

TEST_CASE("plan.status, plan.list and plan.changed carry title, intent and actor", "[protocol][plans][metadata]") {
    Fixture f;
    const ConnectionId c = authedAs(f, named("Studio"));
    const ConnectionId watcher = f.authed(true);
    f.commit(c, Array{trackAdd("trk_a")});

    const Value plan = f.ok(c, "plan.submit",
                            withMetadata(Array{trackGain("trk_a", -600)}, Value("Lower the drums"),
                                         Value("They mask the vocal.")));
    const std::string hash = at(plan, "hash").asString();
    CHECK(at(plan, "title").asString() == "Lower the drums");
    CHECK(at(plan, "intent").asString() == "They mask the vocal.");
    CHECK(actorOf(plan) == R"({"kind":"ui","name":"Studio"})");
    // Outside the hash: the same steps without metadata are the same plan.
    CHECK(hash == hash::formatHash(command::planHash(command::Plan::fromJson(plan))));

    const Value status = f.ok(c, "plan.status", planParams(hash));
    CHECK(at(status, "title").asString() == "Lower the drums");
    CHECK(at(status, "intent").asString() == "They mask the vocal.");
    CHECK(actorOf(status) == R"({"kind":"ui","name":"Studio"})");
    const Value listed = at(f.ok(c, "plan.list"), "plans").asArray().at(0);
    CHECK(at(listed, "title").asString() == "Lower the drums");
    CHECK(at(listed, "intent").asString() == "They mask the vocal.");
    CHECK(actorOf(listed) == R"({"kind":"ui","name":"Studio"})");

    const auto events = planEvents(f, watcher);
    REQUIRE(events.size() == 1);
    CHECK(at(events[0], "plan").asString() == hash);
    CHECK(at(events[0], "title").asString() == "Lower the drums");
    CHECK(at(events[0], "intent").asString() == "They mask the vocal.");
    CHECK(actorOf(events[0]) == R"({"kind":"ui","name":"Studio"})");
    CHECK(events[0].find("rejectionNote") == nullptr);

    // Fixed at submission: an identical plan with another title returns the stored one.
    const Value again = f.ok(c, "plan.submit", withMetadata(Array{trackGain("trk_a", -600)}, Value("Other")));
    CHECK(at(again, "hash").asString() == hash);
    CHECK(at(again, "title").asString() == "Lower the drums");
    CHECK(planEvents(f, watcher).size() == 1);

    // A plan without metadata carries only its actor.
    const Value bare = f.ok(c, "plan.submit", stepsParams(Array{trackGain("trk_a", -300)}));
    CHECK(bare.find("title") == nullptr);
    CHECK(bare.find("intent") == nullptr);
    CHECK(actorOf(bare) == R"({"kind":"ui","name":"Studio"})");
    const auto later = planEvents(f, watcher);
    REQUIRE(later.size() == 2);
    CHECK(later[1].find("title") == nullptr);
    CHECK(actorOf(later[1]) == R"({"kind":"ui","name":"Studio"})");
}

TEST_CASE("The actor of a UI submission comes from the auth frame, never from the params",
          "[protocol][plans][metadata]") {
    Fixture f;
    const ConnectionId setup = f.authed();
    f.commit(setup, Array{trackAdd("trk_a")});

    // No client in the auth frame (Harness::authed): the default name.
    CHECK(actorOf(f.ok(setup, "plan.submit", stepsParams(Array{trackGain("trk_a", -100)}))) ==
          R"({"kind":"ui","name":"SIANN"})");
    // Sanitised: control characters removed, white space trimmed, at most 64 bytes.
    const ConnectionId messy = authedAs(f, named("  Mix\x01 Desk\n  "));
    CHECK(actorOf(f.ok(messy, "plan.submit", stepsParams(Array{trackGain("trk_a", -200)}))) ==
          R"({"kind":"ui","name":"Mix Desk"})");
    const ConnectionId longName = authedAs(f, named(std::string(70, 'n')));
    CHECK(actorOf(f.ok(longName, "plan.submit", stepsParams(Array{trackGain("trk_a", -300)}))) ==
          R"({"kind":"ui","name":")" + std::string(64, 'n') + R"("})");
    // A malformed client is ignored, not refused.
    const ConnectionId odd = authedAs(f, Value("not an object"));
    CHECK(actorOf(f.ok(odd, "plan.submit", stepsParams(Array{trackGain("trk_a", -400)}))) ==
          R"({"kind":"ui","name":"SIANN"})");
    const ConnectionId blank = authedAs(f, named("\x02 "));
    CHECK(actorOf(f.ok(blank, "plan.submit", stepsParams(Array{trackGain("trk_a", -500)}))) ==
          R"({"kind":"ui","name":"SIANN"})");

    // An actor, kind or name in the params is invalid_params and nothing is stored.
    const ConnectionId c = authedAs(f, named("Studio"));
    const std::size_t stored = at(f.ok(c, "plan.list"), "plans").asArray().size();
    for (const char* key : {"actor", "kind", "name", "owner"}) {
        INFO(key);
        Value params = stepsParams(Array{trackGain("trk_a", -700)});
        Object members = params.asObject();
        members.emplace_back(key, std::string(key) == "actor"
                                      ? Value(Object{{"kind", Value("mcp")}, {"name", Value("forged")}})
                                      : Value("forged"));
        CHECK(errorCode(f.call(c, "plan.submit", Value(std::move(members)))) == "invalid_params");
    }
    CHECK(at(f.ok(c, "plan.list"), "plans").asArray().size() == stored);
}

TEST_CASE("plan.changed and plan.status carry the rejection note; a split keeps the parent's metadata",
          "[protocol][plans][metadata]") {
    Fixture f;
    const ConnectionId c = authedAs(f, named("Studio"));
    const ConnectionId watcher = f.authed(true);
    f.commit(c, Array{trackAdd("trk_a")});

    SECTION("reject with a note") {
        const std::string plan = at(f.ok(c, "plan.submit", withMetadata(Array{trackGain("trk_a", -600)},
                                                                         Value("Lower the drums"))),
                                    "hash")
                                     .asString();
        f.ok(c, "plan.reject", Value(Object{{"plan", Value(plan)}, {"note", Value("Too much; try -3 dB")}}));
        const auto events = planEvents(f, watcher);
        REQUIRE(events.size() == 2);
        CHECK(at(events[1], "state").asString() == "rejected");
        CHECK(at(events[1], "rejectionNote").asString() == "Too much; try -3 dB");
        CHECK(at(events[1], "title").asString() == "Lower the drums");
        const Value status = f.ok(c, "plan.status", planParams(plan));
        CHECK(at(status, "rejectionNote").asString() == "Too much; try -3 dB");
    }
    SECTION("partial approval") {
        const std::string two =
            at(f.ok(c, "plan.submit", withMetadata(Array{trackGain("trk_a", -300), trackAdd("trk_b")},
                                                   Value("Mix pass"), Value("Gain and a new track."))),
               "hash")
                .asString();
        const Value sub =
            f.ok(c, "plan.approve", Value(Object{{"plan", Value(two)}, {"steps", Value(Array{Value(1)})}}));
        const std::string subHash = at(sub, "hash").asString();
        CHECK(at(sub, "title").asString() == "Mix pass");
        const auto events = planEvents(f, watcher);
        REQUIRE(events.size() == 3);
        CHECK(at(events[1], "plan").asString() == two);
        CHECK(at(events[1], "rejectionNote").asString() == "partially approved as " + subHash);
        CHECK(at(events[2], "plan").asString() == subHash);
        CHECK(at(events[2], "state").asString() == "approved");
        CHECK(at(events[2], "title").asString() == "Mix pass");
        CHECK(at(events[2], "intent").asString() == "Gain and a new track.");
        CHECK(actorOf(events[2]) == R"({"kind":"ui","name":"Studio"})");
        CHECK(events[2].find("rejectionNote") == nullptr);
        CHECK(at(f.ok(c, "plan.status", planParams(two)), "rejectionNote").asString() ==
              "partially approved as " + subHash);
    }
}
