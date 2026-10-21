#include <catch2/catch_test_macros.hpp>

#include <string>

#include "siann/hash/json.hpp"

using siann::json::ParseError;
using siann::json::Value;
using siann::json::parse;

namespace {

std::string errorCode(std::string_view text) {
    try {
        (void)parse(text);
    } catch (const ParseError& error) {
        return error.code();
    }
    return "no error";
}

}  // namespace

TEST_CASE("Parses scalars, arrays and objects", "[json]") {
    const Value value = parse(R"( { "a": [true, false, null, -1.5e2, "x"], "b": {} } )");
    REQUIRE(value.kind() == Value::Kind::Object);
    const Value* a = value.find("a");
    REQUIRE(a != nullptr);
    const auto& items = a->asArray();
    REQUIRE(items.size() == 5);
    CHECK(items[0].asBool());
    CHECK_FALSE(items[1].asBool());
    CHECK(items[2].isNull());
    CHECK(items[3].asNumber() == -150.0);
    CHECK(items[4].asString() == "x");
    CHECK(value.find("b")->asObject().empty());
    CHECK(value.find("missing") == nullptr);
}

TEST_CASE("Object members keep input order", "[json]") {
    const Value value = parse(R"({"z":1,"a":2})");
    const auto& members = value.asObject();
    REQUIRE(members.size() == 2);
    CHECK(members[0].first == "z");
    CHECK(members[1].first == "a");
}

TEST_CASE("Decodes escapes and surrogate pairs to UTF-8", "[json]") {
    CHECK(parse(R"("é\n\"\\\/")").asString() == "\xC3\xA9\n\"\\/");
    CHECK(parse(R"("😀")").asString() == "\xF0\x9F\x98\x80");
    CHECK(parse("\"\xF0\x9F\x98\x80\"").asString() == "\xF0\x9F\x98\x80");
}

TEST_CASE("Numbers are parsed as IEEE doubles", "[json]") {
    CHECK(parse("9007199254740993").asNumber() == 9007199254740992.0);
    CHECK(parse("-0").asNumber() == 0.0);
    CHECK(parse("5e-324").asNumber() > 0.0);
    CHECK(errorCode("1e400") == "number_out_of_range");
    CHECK(errorCode("-1e400") == "number_out_of_range");
}

TEST_CASE("Rejects malformed JSON", "[json]") {
    CHECK(errorCode("") == "syntax");
    CHECK(errorCode("[1,]") == "syntax");
    CHECK(errorCode("{\"a\" 1}") == "syntax");
    CHECK(errorCode("01") == "syntax");
    CHECK(errorCode("1.") == "syntax");
    CHECK(errorCode(".5") == "syntax");
    CHECK(errorCode("+1") == "syntax");
    CHECK(errorCode("NaN") == "syntax");
    CHECK(errorCode("tru") == "syntax");
    CHECK(errorCode("\"tab\there\"") == "syntax");
    CHECK(errorCode(R"("\x")") == "syntax");
    CHECK(errorCode(R"("\u12")") == "syntax");
    CHECK(errorCode("[1] 2") == "trailing_content");
}

TEST_CASE("Rejects what I-JSON forbids", "[json]") {
    CHECK(errorCode(R"("\ud800")") == "lone_surrogate");
    CHECK(errorCode(R"("\udc00")") == "lone_surrogate");
    CHECK(errorCode(R"("\ud800A")") == "lone_surrogate");
    CHECK(errorCode(R"({"a":1,"a":2})") == "duplicate_key");
    CHECK(errorCode("\"\xFF\"") == "invalid_utf8");
    CHECK(errorCode("\"\xC0\xAF\"") == "invalid_utf8");          // overlong
    CHECK(errorCode("\"\xED\xA0\x80\"") == "invalid_utf8");      // encoded surrogate
    CHECK(errorCode("\"\xF4\x90\x80\x80\"") == "invalid_utf8");  // above U+10FFFF
}

TEST_CASE("Nesting depth is limited", "[json]") {
    const std::string deep = std::string(300, '[') + std::string(300, ']');
    CHECK(errorCode(deep) == "too_deep");
    const std::string ok = std::string(200, '[') + std::string(200, ']');
    CHECK_NOTHROW(parse(ok));
}

TEST_CASE("Parse errors report the byte offset", "[json]") {
    try {
        (void)parse("[1, x]");
        FAIL("expected a parse error");
    } catch (const ParseError& error) {
        CHECK(error.offset() == 4);
    }
}
