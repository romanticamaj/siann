// Plan actors (security fix after m5b-protocol-parity; spec, "Plans" and
// Scopes v0; docs/schemas/protocol-mcp-v0.md, "Trust model"): a propose-scoped
// MCP agent changes the lifecycle of its own plans only. reject_plan of a plan
// another agent or the UI submitted, and discard_proposal of a branch it neither
// proposed nor owns the plan of, are not_plan_actor and change nothing. A
// trusted MCP credential and the UI keep full reach. Reading (list_plans,
// plan_status, preview_plan) stays across agents by design.

#include <catch2/catch_test_macros.hpp>

#include <string>

#include "siann/session/session.hpp"
#include "support/mcp_agent.hpp"
#include "support/protocol_fixture.hpp"

using namespace siann;
using namespace siann::protocol::testing;
using protocol::ConnectionId;
using protocol::McpScope;
using protocol::ServerOptions;

namespace {

Value trackGain(const std::string& id, int milliDb) {
    return Value(Object{{"op", Value("track.set_gain")}, {"trackId", Value(id)}, {"gainMilliDb", Value(milliDb)}});
}

Value stepsOf(int milliDb) {
    return Value(Object{{"steps", Value(Array{trackGain("trk_a", milliDb)})}});
}

Value byPlan(const std::string& hash) {
    return Value(Object{{"plan", Value(hash)}});
}

Value byBranch(const std::string& branch) {
    return Value(Object{{"branch", Value(branch)}});
}

std::string hashOf(const Value& plan) {
    return at(plan, "hash").asString();
}

std::string stateIn(Fixture& f, ConnectionId c, const std::string& hash) {
    return at(f.ok(c, "plan.status", byPlan(hash)), "state").asString();
}

ServerOptions scoped(McpScope scope) {
    ServerOptions options = manualOptions();
    options.mcpScope = scope;
    return options;
}

}  // namespace

TEST_CASE("a propose agent rejects only its own plans: another agent's or the UI's is not_plan_actor",
          "[protocol][mcp][plans][actor]") {
    Fixture f(scoped(McpScope::propose));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    McpAgent a(f);
    a.initialize("agent-a");
    McpAgent b(f);
    b.initialize("agent-b");

    const std::string planA = hashOf(a.ok("submit_plan", stepsOf(-100)));
    const std::string planB = hashOf(b.ok("submit_plan", stepsOf(-200)));
    const std::string planUi = hashOf(f.ok(c, "plan.submit", stepsOf(-300)));
    CHECK(at(at(f.ok(c, "plan.status", byPlan(planB)), "actor"), "name").asString() == "agent-b");

    // Refused, and nothing changed.
    CHECK(a.error("reject_plan", byPlan(planB)) == "not_plan_actor");
    CHECK(a.error("reject_plan", Value(Object{{"plan", Value(planUi)}, {"note", Value("no")}})) == "not_plan_actor");
    CHECK(stateIn(f, c, planB) == "validated");
    CHECK(stateIn(f, c, planUi) == "validated");
    // An unknown plan is still not_found, before the actor check.
    CHECK(a.error("reject_plan", byPlan("sha256:" + std::string(64, '0'))) == "not_found");

    // An identical resubmission returns B's stored plan; it does not make A its actor.
    CHECK(hashOf(a.ok("submit_plan", stepsOf(-200))) == planB);
    CHECK(a.error("reject_plan", byPlan(planB)) == "not_plan_actor");
    CHECK(stateIn(f, c, planB) == "validated");

    // Its own plan: rejected.
    CHECK(at(a.ok("reject_plan", byPlan(planA)), "state").asString() == "rejected");
    CHECK(at(b.ok("reject_plan", byPlan(planB)), "state").asString() == "rejected");

    // Reading stays across agents (the trust model): A sees B's plan.
    CHECK(at(a.ok("plan_status", byPlan(planB)), "state").asString() == "rejected");
    CHECK(at(a.ok("list_plans"), "plans").asArray().size() == 3);
    a.ok("preview_plan", byPlan(planUi));

    // The UI keeps full reject.
    CHECK(at(f.ok(c, "plan.reject", byPlan(planUi)), "state").asString() == "rejected");
}

TEST_CASE("a trusted MCP caller and the UI reject any plan", "[protocol][mcp][plans][actor]") {
    Fixture f(scoped(McpScope::trusted));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    McpAgent a(f);
    a.initialize("agent-a");
    McpAgent b(f);
    b.initialize("agent-b");

    const std::string planB = hashOf(b.ok("submit_plan", stepsOf(-200)));
    const std::string planUi = hashOf(f.ok(c, "plan.submit", stepsOf(-300)));
    const std::string planB2 = hashOf(b.ok("submit_plan", stepsOf(-400)));
    CHECK(at(a.ok("reject_plan", byPlan(planB)), "state").asString() == "rejected");
    CHECK(at(a.ok("reject_plan", byPlan(planUi)), "state").asString() == "rejected");
    CHECK(at(f.ok(c, "plan.reject", byPlan(planB2)), "state").asString() == "rejected");
}

TEST_CASE("a propose agent discards only the proposals of its own plans or the ones it proposed",
          "[protocol][mcp][plans][actor][proposals]") {
    Fixture f(scoped(McpScope::propose));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    McpAgent a(f);
    a.initialize("agent-a");
    McpAgent b(f);
    b.initialize("agent-b");

    // The user approves each plan; each agent proposes its own.
    const std::string planA = hashOf(a.ok("submit_plan", stepsOf(-100)));
    const std::string planB = hashOf(b.ok("submit_plan", stepsOf(-200)));
    const std::string planUi = hashOf(f.ok(c, "plan.submit", stepsOf(-300)));
    for (const std::string& hash : {planA, planB, planUi}) {
        f.ok(c, "plan.approve", byPlan(hash));
    }
    const std::string branchA = at(a.ok("propose_plan", byPlan(planA)), "branch").asString();
    const std::string branchB = at(b.ok("propose_plan", byPlan(planB)), "branch").asString();
    const std::string branchUi = at(f.ok(c, "plan.propose", byPlan(planUi)), "branch").asString();

    CHECK(a.error("discard_proposal", byBranch(branchB)) == "not_plan_actor");
    CHECK(a.error("discard_proposal", byBranch(branchUi)) == "not_plan_actor");
    CHECK(f.session.history().isOpen(branchB));
    CHECK(f.session.history().isOpen(branchUi));
    // Its own: discarded.
    a.ok("discard_proposal", byBranch(branchA));
    CHECK_FALSE(f.session.history().isOpen(branchA));

    // A proposal B made of A's plan: B proposed it, A owns the plan; both may discard it.
    const std::string branchBofA = at(b.ok("propose_plan", byPlan(planA)), "branch").asString();
    a.ok("discard_proposal", byBranch(branchBofA));
    const std::string branchBofA2 = at(b.ok("propose_plan", byPlan(planA)), "branch").asString();
    b.ok("discard_proposal", byBranch(branchBofA2));

    // The UI discards any.
    f.ok(c, "proposal.discard", byBranch(branchB));
    f.ok(c, "proposal.discard", byBranch(branchUi));
    CHECK_FALSE(f.session.history().isOpen(branchB));
}

TEST_CASE("a trusted MCP caller discards any proposal", "[protocol][mcp][plans][actor][proposals]") {
    Fixture f(scoped(McpScope::trusted));
    const ConnectionId c = f.authed();
    f.commit(c, Array{trackAdd("trk_a")});
    McpAgent a(f);
    a.initialize("agent-a");
    const std::string planUi = hashOf(f.ok(c, "plan.submit", stepsOf(-300)));
    f.ok(c, "plan.approve", byPlan(planUi));
    const std::string branch = at(f.ok(c, "plan.propose", byPlan(planUi)), "branch").asString();
    a.ok("discard_proposal", byBranch(branch));
    CHECK_FALSE(f.session.history().isOpen(branch));
}
