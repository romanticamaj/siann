#pragma once

#include <string>
#include <string_view>

namespace siann::command {

// Text an agent supplies that the plan review shows (a plan's title and
// intent, a client's name; security fix after #121): checked by code point
// after decoding it as UTF-8, so a plan cannot be shown as text other than
// what it says.
//
// Display-unsafe: the bidi formatting characters U+061C (ALM), U+200E (LRM),
// U+200F (RLM), U+202A to U+202E (LRE, RLE, PDF, LRO, RLO) and U+2066 to
// U+2069 (LRI, RLI, FSI, PDI), and the line and paragraph separators U+2028
// and U+2029.
bool isDisplayUnsafe(char32_t codePoint) noexcept;

// A control character: C0 (U+0000 to U+001F), DEL (U+007F) or C1 (U+0080 to
// U+009F).
bool isControl(char32_t codePoint) noexcept;

enum class TextFault {
    none,
    invalid_utf8,    // not well-formed UTF-8 (stray continuation, truncated or
                     // overlong sequence, surrogate, past U+10FFFF)
    control,         // a control character `allowedControls` does not list
    display_unsafe,  // isDisplayUnsafe
};

// The first fault of `text`. `allowedControls` lists the ASCII control
// characters that are allowed (tab, LF and CR for an intent).
TextFault textFault(std::string_view text, std::string_view allowedControls = {}) noexcept;

// `text` without its control characters, its display-unsafe characters and
// the bytes that are not well-formed UTF-8: a client's name (sanitised, never
// refused).
std::string withoutUnsafeCharacters(std::string_view text);

}  // namespace siann::command
