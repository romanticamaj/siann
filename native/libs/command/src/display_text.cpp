#include "siann/command/display_text.hpp"

#include <cstddef>

namespace siann::command {

namespace {

// One decoded character: its code point and its length in bytes, or a length
// of 0 when the bytes at `at` are not well-formed UTF-8 (Unicode 15, table 3-7).
struct Decoded {
    char32_t codePoint = 0;
    std::size_t length = 0;
};

constexpr bool isContinuation(unsigned char byte) noexcept {
    return (byte & 0xC0) == 0x80;
}

Decoded decode(std::string_view text, std::size_t at) noexcept {
    const auto byte = [&](std::size_t offset) { return static_cast<unsigned char>(text[at + offset]); };
    const unsigned char lead = byte(0);
    if (lead < 0x80) {
        return {lead, 1};
    }
    std::size_t length = 0;
    char32_t codePoint = 0;
    unsigned char low = 0x80;  // the second byte's range, narrowed for some leads
    unsigned char high = 0xBF;
    if (lead >= 0xC2 && lead <= 0xDF) {
        length = 2;
        codePoint = lead & 0x1F;
    } else if (lead >= 0xE0 && lead <= 0xEF) {
        length = 3;
        codePoint = lead & 0x0F;
        if (lead == 0xE0) {
            low = 0xA0;  // no overlong
        } else if (lead == 0xED) {
            high = 0x9F;  // no surrogate
        }
    } else if (lead >= 0xF0 && lead <= 0xF4) {
        length = 4;
        codePoint = lead & 0x07;
        if (lead == 0xF0) {
            low = 0x90;  // no overlong
        } else if (lead == 0xF4) {
            high = 0x8F;  // nothing past U+10FFFF
        }
    } else {
        return {};  // a continuation byte, an overlong lead (C0, C1) or F5..FF
    }
    if (at + length > text.size()) {
        return {};
    }
    const unsigned char second = byte(1);
    if (second < low || second > high) {
        return {};
    }
    codePoint = (codePoint << 6) | (second & 0x3F);
    for (std::size_t i = 2; i < length; ++i) {
        if (!isContinuation(byte(i))) {
            return {};
        }
        codePoint = (codePoint << 6) | (byte(i) & 0x3F);
    }
    return {codePoint, length};
}

}  // namespace

bool isDisplayUnsafe(char32_t codePoint) noexcept {
    return codePoint == 0x061C || codePoint == 0x200E || codePoint == 0x200F ||
           (codePoint >= 0x202A && codePoint <= 0x202E) || (codePoint >= 0x2066 && codePoint <= 0x2069) ||
           codePoint == 0x2028 || codePoint == 0x2029;
}

bool isControl(char32_t codePoint) noexcept {
    return codePoint < 0x20 || (codePoint >= 0x7F && codePoint <= 0x9F);
}

TextFault textFault(std::string_view text, std::string_view allowedControls) noexcept {
    for (std::size_t at = 0; at < text.size();) {
        const Decoded character = decode(text, at);
        if (character.length == 0) {
            return TextFault::invalid_utf8;
        }
        if (isControl(character.codePoint) &&
            !(character.codePoint < 0x80 &&
              allowedControls.find(static_cast<char>(character.codePoint)) != std::string_view::npos)) {
            return TextFault::control;
        }
        if (isDisplayUnsafe(character.codePoint)) {
            return TextFault::display_unsafe;
        }
        at += character.length;
    }
    return TextFault::none;
}

std::string withoutUnsafeCharacters(std::string_view text) {
    std::string out;
    out.reserve(text.size());
    for (std::size_t at = 0; at < text.size();) {
        const Decoded character = decode(text, at);
        if (character.length == 0) {
            ++at;  // drop the byte and resynchronise on the next one
            continue;
        }
        if (!isControl(character.codePoint) && !isDisplayUnsafe(character.codePoint)) {
            out.append(text.substr(at, character.length));
        }
        at += character.length;
    }
    return out;
}

}  // namespace siann::command
