#pragma once

// Internal UTF-8 helpers shared by the JSON parser and the JCS serializer.

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace siann::detail {

// Length of the well-formed UTF-8 sequence starting at text[pos] (1 to 4), or
// 0 if it is malformed: overlong forms, encoded surrogates and code points
// above U+10FFFF are malformed. On success, codePoint receives the value.
inline std::size_t decodeUtf8(std::string_view text, std::size_t pos, char32_t& codePoint) noexcept {
    const auto byte = [&](std::size_t i) { return static_cast<std::uint8_t>(text[pos + i]); };
    const std::size_t remaining = text.size() - pos;
    const std::uint8_t b0 = byte(0);
    if (b0 < 0x80) {
        codePoint = b0;
        return 1;
    }
    std::size_t length = 0;
    char32_t value = 0;
    char32_t minimum = 0;
    if ((b0 & 0xE0) == 0xC0) {
        length = 2;
        value = b0 & 0x1F;
        minimum = 0x80;
    } else if ((b0 & 0xF0) == 0xE0) {
        length = 3;
        value = b0 & 0x0F;
        minimum = 0x800;
    } else if ((b0 & 0xF8) == 0xF0) {
        length = 4;
        value = b0 & 0x07;
        minimum = 0x10000;
    } else {
        return 0;
    }
    if (remaining < length) {
        return 0;
    }
    for (std::size_t i = 1; i < length; ++i) {
        const std::uint8_t continuation = byte(i);
        if ((continuation & 0xC0) != 0x80) {
            return 0;
        }
        value = (value << 6) | (continuation & 0x3F);
    }
    if (value < minimum || value > 0x10FFFF || (value >= 0xD800 && value <= 0xDFFF)) {
        return 0;
    }
    codePoint = value;
    return length;
}

inline void appendUtf8(std::string& out, char32_t codePoint) {
    if (codePoint < 0x80) {
        out.push_back(static_cast<char>(codePoint));
    } else if (codePoint < 0x800) {
        out.push_back(static_cast<char>(0xC0 | (codePoint >> 6)));
        out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    } else if (codePoint < 0x10000) {
        out.push_back(static_cast<char>(0xE0 | (codePoint >> 12)));
        out.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (codePoint >> 18)));
        out.push_back(static_cast<char>(0x80 | ((codePoint >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
    }
}

}  // namespace siann::detail
