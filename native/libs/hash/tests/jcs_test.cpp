#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <limits>
#include <string>

#include "fixture_util.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/sha256.hpp"

using siann::jcs::CanonicalizeError;
using siann::jcs::canonicalize;
using siann::jcs::formatNumber;
using siann::jcs::sha256Jcs;
using siann::json::Array;
using siann::json::Object;
using siann::json::ParseError;
using siann::json::Value;

TEST_CASE("Shared JCS fixtures: valid cases", "[jcs][fixtures]") {
    const Value fixtures = siann::test::readFixture("jcs/cases.json");
    REQUIRE(fixtures.find("schemaVersion")->asString() == "siann.jcs_fixtures.v1");
    const auto& cases = fixtures.find("valid")->asArray();
    REQUIRE_FALSE(cases.empty());
    for (const Value& entry : cases) {
        const std::string& name = entry.find("name")->asString();
        INFO("fixture " << name);
        const Value input = siann::json::parse(entry.find("input")->asString());
        CHECK(canonicalize(input) == entry.find("canonical")->asString());
        CHECK(sha256Jcs(input) == entry.find("sha256")->asString());
    }
}

TEST_CASE("Shared JCS fixtures: invalid cases are rejected", "[jcs][fixtures]") {
    const Value fixtures = siann::test::readFixture("jcs/cases.json");
    for (const Value& entry : fixtures.find("invalid")->asArray()) {
        const std::string& name = entry.find("name")->asString();
        const std::string& expected = entry.find("error")->asString();
        INFO("fixture " << name);
        std::string actual = "no error";
        try {
            canonicalize(siann::json::parse(entry.find("input")->asString()));
        } catch (const ParseError& error) {
            actual = error.code();
        } catch (const CanonicalizeError& error) {
            actual = error.code();
        }
        CHECK(actual == expected);
    }
}

TEST_CASE("formatNumber follows ECMAScript Number::toString", "[jcs]") {
    CHECK(formatNumber(0.0) == "0");
    CHECK(formatNumber(-0.0) == "0");
    CHECK(formatNumber(1.0) == "1");
    CHECK(formatNumber(-1.5) == "-1.5");
    CHECK(formatNumber(100.0) == "100");
    CHECK(formatNumber(123456789012345680000.0) == "123456789012345680000");
    CHECK(formatNumber(1e21) == "1e+21");
    CHECK(formatNumber(1.5e21) == "1.5e+21");
    CHECK(formatNumber(0.000001) == "0.000001");
    CHECK(formatNumber(0.0000001) == "1e-7");
    CHECK(formatNumber(1.25e-7) == "1.25e-7");
    CHECK(formatNumber(0.1) == "0.1");
    CHECK(formatNumber(0.1 + 0.2) == "0.30000000000000004");
    CHECK(formatNumber(5e-324) == "5e-324");
    CHECK(formatNumber(std::numeric_limits<double>::max()) == "1.7976931348623157e+308");
    CHECK(formatNumber(-2147483648.0) == "-2147483648");
}

TEST_CASE("Canonicalize rejects non-finite numbers with a pointer", "[jcs]") {
    const Value value = Object{{"a/b", Array{Value(1), Value(std::nan(""))}}};
    try {
        (void)canonicalize(value);
        FAIL("expected an error");
    } catch (const CanonicalizeError& error) {
        CHECK(error.code() == "non_finite_number");
        CHECK(error.pointer() == "/a~1b/1");
    }
    CHECK_THROWS_AS(canonicalize(Value(std::numeric_limits<double>::infinity())), CanonicalizeError);
}

TEST_CASE("Canonicalize rejects invalid UTF-8 and duplicate keys built in code", "[jcs]") {
    try {
        (void)canonicalize(Value(std::string("\xFF")));
        FAIL("expected an error");
    } catch (const CanonicalizeError& error) {
        CHECK(error.code() == "invalid_utf8");
    }
    try {
        (void)canonicalize(Value(Object{{"k", Value(1)}, {"k", Value(2)}}));
        FAIL("expected an error");
    } catch (const CanonicalizeError& error) {
        CHECK(error.code() == "duplicate_key");
    }
}

TEST_CASE("Canonicalize sorts keys by UTF-16 code units, not code points", "[jcs]") {
    // U+1F600 (surrogates D83D DE00) sorts before U+E000 in UTF-16 order,
    // although its code point and UTF-8 bytes are larger.
    const Value value = Object{{"\xEE\x80\x80", Value(1)}, {"\xF0\x9F\x98\x80", Value(2)}};
    CHECK(canonicalize(value) == "{\"\xF0\x9F\x98\x80\":2,\"\xEE\x80\x80\":1}");
}
