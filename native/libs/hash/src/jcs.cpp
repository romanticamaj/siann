#include "siann/hash/jcs.hpp"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <numeric>
#include <string>
#include <vector>

#include "siann/hash/sha256.hpp"
#include "utf8.hpp"

namespace siann::jcs {

CanonicalizeError::CanonicalizeError(std::string code, std::string pointer, const std::string& message)
    : std::runtime_error(message + " at " + pointer), code_(std::move(code)), pointer_(std::move(pointer)) {}

namespace {

std::string pointerJoin(const std::string& pointer, std::string_view token) {
    std::string out = pointer == "/" ? std::string() : pointer;
    out.push_back('/');
    for (const char c : token) {
        if (c == '~') {
            out += "~0";
        } else if (c == '/') {
            out += "~1";
        } else {
            out.push_back(c);
        }
    }
    return out;
}

// UTF-16 code units of a valid UTF-8 string, for RFC 8785 key ordering.
std::u16string toUtf16(std::string_view text, const std::string& pointer) {
    std::u16string out;
    std::size_t pos = 0;
    while (pos < text.size()) {
        char32_t codePoint = 0;
        const std::size_t length = detail::decodeUtf8(text, pos, codePoint);
        if (length == 0) {
            throw CanonicalizeError("invalid_utf8", pointer, "key is not valid UTF-8");
        }
        if (codePoint >= 0x10000) {
            const char32_t v = codePoint - 0x10000;
            out.push_back(static_cast<char16_t>(0xD800 + (v >> 10)));
            out.push_back(static_cast<char16_t>(0xDC00 + (v & 0x3FF)));
        } else {
            out.push_back(static_cast<char16_t>(codePoint));
        }
        pos += length;
    }
    return out;
}

void appendString(std::string& out, std::string_view text, const std::string& pointer) {
    static constexpr char kHex[] = "0123456789abcdef";
    out.push_back('"');
    std::size_t pos = 0;
    while (pos < text.size()) {
        const auto c = static_cast<unsigned char>(text[pos]);
        if (c >= 0x80) {
            char32_t codePoint = 0;
            const std::size_t length = detail::decodeUtf8(text, pos, codePoint);
            if (length == 0) {
                throw CanonicalizeError("invalid_utf8", pointer, "string is not valid UTF-8");
            }
            out.append(text.substr(pos, length));
            pos += length;
            continue;
        }
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    out += "\\u00";
                    out.push_back(kHex[c >> 4]);
                    out.push_back(kHex[c & 0x0F]);
                } else {
                    out.push_back(static_cast<char>(c));
                }
        }
        ++pos;
    }
    out.push_back('"');
}

void serialize(std::string& out, const json::Value& value, const std::string& pointer) {
    switch (value.kind()) {
        case json::Value::Kind::Null:
            out += "null";
            return;
        case json::Value::Kind::Bool:
            out += value.asBool() ? "true" : "false";
            return;
        case json::Value::Kind::Number:
            if (!std::isfinite(value.asNumber())) {
                throw CanonicalizeError("non_finite_number", pointer, "number must be finite");
            }
            out += formatNumber(value.asNumber());
            return;
        case json::Value::Kind::String:
            appendString(out, value.asString(), pointer);
            return;
        case json::Value::Kind::Array: {
            const auto& items = value.asArray();
            out.push_back('[');
            for (std::size_t i = 0; i < items.size(); ++i) {
                if (i > 0) {
                    out.push_back(',');
                }
                serialize(out, items[i], pointerJoin(pointer, std::to_string(i)));
            }
            out.push_back(']');
            return;
        }
        case json::Value::Kind::Object: {
            const auto& members = value.asObject();
            std::vector<std::u16string> keys;
            keys.reserve(members.size());
            for (const auto& member : members) {
                keys.push_back(toUtf16(member.first, pointerJoin(pointer, member.first)));
            }
            std::vector<std::size_t> order(members.size());
            std::iota(order.begin(), order.end(), std::size_t{0});
            std::sort(order.begin(), order.end(), [&](std::size_t a, std::size_t b) { return keys[a] < keys[b]; });
            out.push_back('{');
            for (std::size_t i = 0; i < order.size(); ++i) {
                const auto& member = members[order[i]];
                const std::string memberPointer = pointerJoin(pointer, member.first);
                if (i > 0) {
                    if (keys[order[i - 1]] == keys[order[i]]) {
                        throw CanonicalizeError("duplicate_key", memberPointer, "duplicate object key");
                    }
                    out.push_back(',');
                }
                appendString(out, member.first, memberPointer);
                out.push_back(':');
                serialize(out, member.second, memberPointer);
            }
            out.push_back('}');
            return;
        }
    }
}

}  // namespace

std::string formatNumber(double value) {
    if (value == 0.0) {
        return "0";  // also -0
    }
    if (value < 0) {
        return "-" + formatNumber(-value);
    }
    // Shortest round-trip digits in scientific form, for example "1.2345e+20".
    char buffer[64];
    const auto result = std::to_chars(buffer, buffer + sizeof(buffer), value, std::chars_format::scientific);
    const std::string_view text(buffer, static_cast<std::size_t>(result.ptr - buffer));
    const std::size_t ePos = text.find('e');
    std::string digits;
    for (const char c : text.substr(0, ePos)) {
        if (c != '.') {
            digits.push_back(c);
        }
    }
    const int exponent = std::atoi(std::string(text.substr(ePos + 1)).c_str());
    const int k = static_cast<int>(digits.size());
    const int n = exponent + 1;  // decimal point position, as in ECMA-262 Number::toString

    if (k <= n && n <= 21) {
        return digits + std::string(static_cast<std::size_t>(n - k), '0');
    }
    if (0 < n && n <= 21) {
        return digits.substr(0, static_cast<std::size_t>(n)) + "." + digits.substr(static_cast<std::size_t>(n));
    }
    if (-6 < n && n <= 0) {
        return "0." + std::string(static_cast<std::size_t>(-n), '0') + digits;
    }
    const int e = n - 1;
    const std::string exponentText = (e < 0 ? "-" : "+") + std::to_string(std::abs(e));
    if (k == 1) {
        return digits + "e" + exponentText;
    }
    return digits.substr(0, 1) + "." + digits.substr(1) + "e" + exponentText;
}

std::string canonicalize(const json::Value& value) {
    std::string out;
    serialize(out, value, "/");
    return out;
}

std::string sha256Jcs(const json::Value& value) {
    return hash::formatHash(hash::sha256(canonicalize(value)));
}

}  // namespace siann::jcs
