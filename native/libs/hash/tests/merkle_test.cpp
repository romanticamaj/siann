#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "fixture_util.hpp"
#include "siann/hash/merkle.hpp"

using siann::hash::Digest;
using siann::hash::DocumentHashError;
using siann::hash::EntityLeaf;
using siann::hash::documentHash;
using siann::hash::formatHash;
using siann::hash::isValidEntityId;
using siann::hash::isValidEntityType;
using siann::hash::leafHash;
using siann::hash::parseHash;
using siann::hash::toHex;
using siann::hash::treeHash;
using siann::json::Value;

namespace {

std::vector<std::uint8_t> fromHex(const std::string& hex) {
    std::vector<std::uint8_t> bytes;
    for (std::size_t i = 0; i + 1 < hex.size(); i += 2) {
        bytes.push_back(static_cast<std::uint8_t>(std::stoi(hex.substr(i, 2), nullptr, 16)));
    }
    return bytes;
}

// Fixture entities carry the hash as text. Malformed hashes are a fixture-level
// rejection (invalid_entity_hash) because EntityLeaf holds a parsed Digest.
std::vector<EntityLeaf> toLeaves(const Value& entities, bool& badHash) {
    std::vector<EntityLeaf> leaves;
    badHash = false;
    for (const Value& entity : entities.asArray()) {
        const auto digest = parseHash(entity.find("entityHash")->asString());
        if (!digest) {
            badHash = true;
            return {};
        }
        leaves.push_back({entity.find("type")->asString(), entity.find("id")->asString(), *digest});
    }
    return leaves;
}

}  // namespace

TEST_CASE("RFC 6962 tree hash matches the Certificate Transparency vectors", "[merkle][fixtures]") {
    const Value fixture = siann::test::readFixture("hash/rfc6962.json");
    std::vector<Digest> leaves;
    for (const Value& hex : fixture.find("leafInputsHex")->asArray()) {
        leaves.push_back(leafHash(fromHex(hex.asString())));
    }
    const auto& roots = fixture.find("roots")->asArray();
    REQUIRE(roots.size() == leaves.size() + 1);
    for (std::size_t size = 0; size < roots.size(); ++size) {
        INFO("tree size " << size);
        CHECK(toHex(treeHash(std::span<const Digest>(leaves.data(), size))) == roots[size].asString());
    }
}

TEST_CASE("Shared document hash fixtures: valid cases", "[merkle][fixtures]") {
    const Value fixture = siann::test::readFixture("hash/document.json");
    for (const Value& entry : fixture.find("valid")->asArray()) {
        INFO("fixture " << entry.find("name")->asString());
        bool badHash = false;
        auto leaves = toLeaves(*entry.find("entities"), badHash);
        REQUIRE_FALSE(badHash);
        CHECK(formatHash(documentHash(leaves)) == entry.find("documentHash")->asString());
        std::reverse(leaves.begin(), leaves.end());
        CHECK(formatHash(documentHash(leaves)) == entry.find("documentHash")->asString());
    }
}

TEST_CASE("Shared document hash fixtures: invalid cases are rejected", "[merkle][fixtures]") {
    const Value fixture = siann::test::readFixture("hash/document.json");
    for (const Value& entry : fixture.find("invalid")->asArray()) {
        INFO("fixture " << entry.find("name")->asString());
        const std::string& expected = entry.find("error")->asString();
        bool badHash = false;
        const auto leaves = toLeaves(*entry.find("entities"), badHash);
        std::string actual = "no error";
        if (badHash) {
            actual = "invalid_entity_hash";
        } else {
            try {
                (void)documentHash(leaves);
            } catch (const DocumentHashError& error) {
                actual = error.code();
            }
        }
        CHECK(actual == expected);
    }
}

TEST_CASE("Entity type and id rules", "[merkle]") {
    CHECK(isValidEntityType("track"));
    CHECK(isValidEntityType("plugin_slot"));
    CHECK(isValidEntityType(std::string(32, 'a')));
    CHECK_FALSE(isValidEntityType(std::string(33, 'a')));
    CHECK_FALSE(isValidEntityType(""));
    CHECK_FALSE(isValidEntityType("Track"));
    CHECK_FALSE(isValidEntityType("1track"));
    CHECK_FALSE(isValidEntityType("track-lane"));

    CHECK(isValidEntityId("trk_01-A"));
    CHECK(isValidEntityId(std::string(64, 'x')));
    CHECK_FALSE(isValidEntityId(std::string(65, 'x')));
    CHECK_FALSE(isValidEntityId(""));
    CHECK_FALSE(isValidEntityId("trk:1"));
    CHECK_FALSE(isValidEntityId("trk 1"));
}
