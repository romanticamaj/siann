// m5b-protocol-parity (test-matrix gap 2): every protocol method the engine
// serves is an MCP tool or has a reasoned entry in kNotMcp, the table beside
// the tool table in src/mcp_adapter.cpp. A method added with neither fails here
// on every OS. test/protocol-parity.test.js holds the same tables against the
// protocol docs and the app's capabilities fixtures without a build.

#include <catch2/catch_test_macros.hpp>

#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "support/protocol_fixture.hpp"
#include "../src/mcp_adapter.hpp"  // the tool table, kNotMcp and kMethods

using namespace siann;
using namespace siann::protocol::testing;

namespace {

std::vector<std::string> toolMethodNames() {
    std::vector<std::string> out;
    for (const auto& tool : protocol::detail::mcpTools()) {
        out.emplace_back(tool.method);
    }
    return out;
}

std::vector<std::string> excludedMethodNames() {
    std::vector<std::string> out;
    for (const auto& exclusion : protocol::detail::mcpExclusions()) {
        out.emplace_back(exclusion.method);
    }
    return out;
}

std::vector<std::string> servedMethodNames() {
    std::vector<std::string> out;
    for (const std::string_view method : protocol::detail::protocolMethods()) {
        out.emplace_back(method);
    }
    return out;
}

// The names that occur more than once.
std::vector<std::string> duplicates(const std::vector<std::string>& names) {
    std::set<std::string> seen;
    std::set<std::string> twice;
    for (const std::string& name : names) {
        if (!seen.insert(name).second) {
            twice.insert(name);
        }
    }
    return {twice.begin(), twice.end()};
}

}  // namespace

TEST_CASE("every served method is an MCP tool or a kNotMcp entry, and nothing else is",
          "[protocol][mcp][parity]") {
    const std::vector<std::string> served = servedMethodNames();
    REQUIRE(served.size() > 40);
    std::set<std::string> covered;
    for (const std::string& method : toolMethodNames()) {
        covered.insert(method);
    }
    for (const std::string& method : excludedMethodNames()) {
        covered.insert(method);
    }
    const std::set<std::string> servedSet(served.begin(), served.end());
    for (const std::string& method : served) {
        INFO(method << " is served (kMethods) but is neither an MCP tool nor in kNotMcp");
        CHECK(covered.count(method) == 1);
    }
    for (const std::string& method : covered) {
        INFO(method << " is an MCP tool or in kNotMcp but no method the engine serves (kMethods)");
        CHECK(servedSet.count(method) == 1);
    }
}

TEST_CASE("the tool methods and kNotMcp are disjoint and no table repeats a name", "[protocol][mcp][parity]") {
    const std::vector<std::string> tools = toolMethodNames();
    const std::vector<std::string> excluded = excludedMethodNames();
    REQUIRE_FALSE(excluded.empty());
    const std::set<std::string> toolSet(tools.begin(), tools.end());
    for (const std::string& method : excluded) {
        INFO(method << " is both an MCP tool and in kNotMcp");
        CHECK(toolSet.count(method) == 0);
    }
    CHECK(duplicates(servedMethodNames()).empty());
    CHECK(duplicates(tools).empty());
    CHECK(duplicates(excluded).empty());
    std::vector<std::string> toolNames;
    for (const auto& tool : protocol::detail::mcpTools()) {
        toolNames.emplace_back(tool.name);
    }
    CHECK(duplicates(toolNames).empty());
}

TEST_CASE("every kNotMcp entry carries its reason", "[protocol][mcp][parity]") {
    for (const auto& exclusion : protocol::detail::mcpExclusions()) {
        INFO(std::string(exclusion.method));
        CHECK_FALSE(exclusion.method.empty());
        CHECK_FALSE(exclusion.reason.empty());
    }
}

TEST_CASE("engine.capabilities lists kMethods in its order", "[protocol][mcp][parity]") {
    Fixture f;
    const auto c = f.authed();
    const Value capabilities = f.ok(c, "engine.capabilities");
    std::vector<std::string> listed;
    for (const Value& method : at(capabilities, "methods").asArray()) {
        listed.push_back(method.asString());
    }
    CHECK(listed == servedMethodNames());
}
