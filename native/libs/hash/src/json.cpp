#include "siann/hash/json.hpp"

#include <charconv>
#include <cmath>
#include <cstdlib>
#include <string>
#include <unordered_set>

#include "utf8.hpp"

namespace siann::json {

const Value* Value::find(std::string_view key) const noexcept {
    const auto* object = std::get_if<Object>(&data_);
    if (object == nullptr) {
        return nullptr;
    }
    for (const auto& member : *object) {
        if (member.first == key) {
            return &member.second;
        }
    }
    return nullptr;
}

ParseError::ParseError(std::string code, std::size_t offset, const std::string& message)
    : std::runtime_error(message + " at byte " + std::to_string(offset)),
      code_(std::move(code)),
      offset_(offset) {}

namespace {

bool isDigit(char c) noexcept {
    return c >= '0' && c <= '9';
}

int hexValue(char c) noexcept {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

double toDouble(std::string_view token, std::size_t offset) {
#if defined(__cpp_lib_to_chars) && __cpp_lib_to_chars >= 201611L
    double value = 0.0;
    const auto result = std::from_chars(token.data(), token.data() + token.size(), value);
    if (result.ec == std::errc::result_out_of_range) {
        // strtod gives +-HUGE_VAL on overflow (rejected below) and the nearest
        // subnormal or zero on underflow (accepted, as in ECMAScript).
        const std::string copy(token);
        value = std::strtod(copy.c_str(), nullptr);
    } else if (result.ec != std::errc{} || result.ptr != token.data() + token.size()) {
        throw ParseError("syntax", offset, "invalid number");
    }
#else
    // Fallback for standard libraries without floating-point from_chars. The
    // engine never changes LC_NUMERIC, so strtod uses '.' as the decimal point.
    const std::string copy(token);
    const double value = std::strtod(copy.c_str(), nullptr);
#endif
    if (!std::isfinite(value)) {
        throw ParseError("number_out_of_range", offset, "number is out of the double range");
    }
    return value;
}

class Parser {
public:
    Parser(std::string_view text, const ParseOptions& options) : text_(text), options_(options) {}

    Value parseDocument() {
        skipWhitespace();
        Value value = parseValue(0);
        skipWhitespace();
        if (pos_ != text_.size()) {
            throw ParseError("trailing_content", pos_, "unexpected content after the JSON value");
        }
        return value;
    }

private:
    [[noreturn]] void fail(const char* code, const std::string& message) const {
        throw ParseError(code, pos_, message);
    }

    bool atEnd() const noexcept { return pos_ >= text_.size(); }
    char peek() const noexcept { return atEnd() ? '\0' : text_[pos_]; }

    void skipWhitespace() noexcept {
        while (!atEnd()) {
            const char c = text_[pos_];
            if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
                break;
            }
            ++pos_;
        }
    }

    void expectLiteral(std::string_view literal) {
        if (text_.substr(pos_, literal.size()) != literal) {
            fail("syntax", "invalid literal");
        }
        pos_ += literal.size();
    }

    Value parseValue(std::size_t depth) {
        if (atEnd()) {
            fail("syntax", "unexpected end of input");
        }
        switch (peek()) {
            case '{':
                return parseObject(depth + 1);
            case '[':
                return parseArray(depth + 1);
            case '"':
                return Value(parseString());
            case 't':
                expectLiteral("true");
                return Value(true);
            case 'f':
                expectLiteral("false");
                return Value(false);
            case 'n':
                expectLiteral("null");
                return Value(nullptr);
            default:
                if (peek() == '-' || isDigit(peek())) {
                    return Value(parseNumber());
                }
                fail("syntax", "unexpected character");
        }
    }

    void checkDepth(std::size_t depth) const {
        if (depth > options_.maxDepth) {
            throw ParseError("too_deep", pos_, "nesting is deeper than the limit");
        }
    }

    Value parseArray(std::size_t depth) {
        checkDepth(depth);
        ++pos_;  // '['
        Array items;
        skipWhitespace();
        if (peek() == ']') {
            ++pos_;
            return Value(std::move(items));
        }
        while (true) {
            skipWhitespace();
            items.push_back(parseValue(depth));
            skipWhitespace();
            if (peek() == ',') {
                ++pos_;
                continue;
            }
            if (peek() == ']') {
                ++pos_;
                return Value(std::move(items));
            }
            fail("syntax", "expected ',' or ']'");
        }
    }

    Value parseObject(std::size_t depth) {
        checkDepth(depth);
        ++pos_;  // '{'
        Object members;
        std::unordered_set<std::string> keys;
        skipWhitespace();
        if (peek() == '}') {
            ++pos_;
            return Value(std::move(members));
        }
        while (true) {
            skipWhitespace();
            if (peek() != '"') {
                fail("syntax", "expected a string key");
            }
            const std::size_t keyOffset = pos_;
            std::string key = parseString();
            if (!keys.insert(key).second) {
                throw ParseError("duplicate_key", keyOffset, "duplicate object key");
            }
            skipWhitespace();
            if (peek() != ':') {
                fail("syntax", "expected ':'");
            }
            ++pos_;
            skipWhitespace();
            Value value = parseValue(depth);
            members.emplace_back(std::move(key), std::move(value));
            skipWhitespace();
            if (peek() == ',') {
                ++pos_;
                continue;
            }
            if (peek() == '}') {
                ++pos_;
                return Value(std::move(members));
            }
            fail("syntax", "expected ',' or '}'");
        }
    }

    char32_t parseHex4() {
        if (text_.size() - pos_ < 4) {
            fail("syntax", "truncated \\u escape");
        }
        char32_t value = 0;
        for (int i = 0; i < 4; ++i) {
            const int digit = hexValue(text_[pos_ + static_cast<std::size_t>(i)]);
            if (digit < 0) {
                fail("syntax", "invalid \\u escape");
            }
            value = (value << 4) | static_cast<char32_t>(digit);
        }
        pos_ += 4;
        return value;
    }

    std::string parseString() {
        ++pos_;  // opening quote
        std::string out;
        while (true) {
            if (atEnd()) {
                fail("syntax", "unterminated string");
            }
            const auto c = static_cast<unsigned char>(text_[pos_]);
            if (c == '"') {
                ++pos_;
                return out;
            }
            if (c < 0x20) {
                fail("syntax", "unescaped control character in string");
            }
            if (c == '\\') {
                parseEscape(out);
                continue;
            }
            if (c < 0x80) {
                out.push_back(static_cast<char>(c));
                ++pos_;
                continue;
            }
            char32_t codePoint = 0;
            const std::size_t length = detail::decodeUtf8(text_, pos_, codePoint);
            if (length == 0) {
                fail("invalid_utf8", "invalid UTF-8 in string");
            }
            out.append(text_.substr(pos_, length));
            pos_ += length;
        }
    }

    void parseEscape(std::string& out) {
        const std::size_t escapeStart = pos_;
        ++pos_;  // backslash
        if (atEnd()) {
            fail("syntax", "unterminated escape");
        }
        const char kind = text_[pos_++];
        switch (kind) {
            case '"': out.push_back('"'); return;
            case '\\': out.push_back('\\'); return;
            case '/': out.push_back('/'); return;
            case 'b': out.push_back('\b'); return;
            case 'f': out.push_back('\f'); return;
            case 'n': out.push_back('\n'); return;
            case 'r': out.push_back('\r'); return;
            case 't': out.push_back('\t'); return;
            case 'u': break;
            default:
                pos_ = escapeStart;
                fail("syntax", "invalid escape");
        }
        const char32_t unit = parseHex4();
        if (unit >= 0xDC00 && unit <= 0xDFFF) {
            throw ParseError("lone_surrogate", escapeStart, "unpaired low surrogate");
        }
        if (unit >= 0xD800 && unit <= 0xDBFF) {
            if (text_.substr(pos_, 2) != "\\u") {
                throw ParseError("lone_surrogate", escapeStart, "unpaired high surrogate");
            }
            pos_ += 2;
            const char32_t low = parseHex4();
            if (low < 0xDC00 || low > 0xDFFF) {
                throw ParseError("lone_surrogate", escapeStart, "unpaired high surrogate");
            }
            detail::appendUtf8(out, 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00));
            return;
        }
        detail::appendUtf8(out, unit);
    }

    double parseNumber() {
        const std::size_t start = pos_;
        if (peek() == '-') {
            ++pos_;
        }
        if (peek() == '0') {
            ++pos_;
            if (isDigit(peek())) {
                fail("syntax", "leading zeros are not allowed");
            }
        } else if (isDigit(peek())) {
            while (isDigit(peek())) {
                ++pos_;
            }
        } else {
            fail("syntax", "invalid number");
        }
        if (peek() == '.') {
            ++pos_;
            if (!isDigit(peek())) {
                fail("syntax", "invalid number fraction");
            }
            while (isDigit(peek())) {
                ++pos_;
            }
        }
        if (peek() == 'e' || peek() == 'E') {
            ++pos_;
            if (peek() == '+' || peek() == '-') {
                ++pos_;
            }
            if (!isDigit(peek())) {
                fail("syntax", "invalid number exponent");
            }
            while (isDigit(peek())) {
                ++pos_;
            }
        }
        return toDouble(text_.substr(start, pos_ - start), start);
    }

    std::string_view text_;
    const ParseOptions& options_;
    std::size_t pos_ = 0;
};

}  // namespace

Value parse(std::string_view text, const ParseOptions& options) {
    return Parser(text, options).parseDocument();
}

}  // namespace siann::json
