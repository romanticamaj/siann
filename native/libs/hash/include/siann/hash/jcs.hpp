#pragma once

// RFC 8785 JSON Canonicalization Scheme. Must pass fixtures/jcs/cases.json,
// the same fixtures as the Node bridge (src/hash/jcs.js).

#include <stdexcept>
#include <string>

#include "siann/hash/json.hpp"

namespace siann::jcs {

class CanonicalizeError : public std::runtime_error {
public:
    CanonicalizeError(std::string code, std::string pointer, const std::string& message);

    // One of: non_finite_number, invalid_utf8, duplicate_key.
    const std::string& code() const noexcept { return code_; }
    // JSON Pointer (RFC 6901) to the offending value; "/" for the root.
    const std::string& pointer() const noexcept { return pointer_; }

private:
    std::string code_;
    std::string pointer_;
};

std::string canonicalize(const json::Value& value);

// ECMAScript Number::toString for a finite double; -0 formats as "0".
std::string formatNumber(double value);

// "sha256:<hex>" over the UTF-8 bytes of canonicalize(value).
std::string sha256Jcs(const json::Value& value);

}  // namespace siann::jcs
