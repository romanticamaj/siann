#pragma once

// A small JSON value and a strict I-JSON (RFC 7493) parser for hashed data.
// Numbers are IEEE doubles, as in RFC 8785. Strings are valid UTF-8.
// General-purpose, non-hashed JSON I/O uses nlohmann/json instead.

#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace siann::json {

class Value;
using Array = std::vector<Value>;
using Member = std::pair<std::string, Value>;
using Object = std::vector<Member>;  // insertion order; keys are unique

class Value {
public:
    // Lowercase enumerators, as in std::chars_format, so they do not shadow the
    // Array and Object aliases.
    enum class Kind { null, boolean, number, string, array, object };

    Value() noexcept = default;
    Value(std::nullptr_t) noexcept {}
    Value(bool b) noexcept : data_(b) {}
    Value(double d) noexcept : data_(d) {}
    Value(int i) noexcept : data_(static_cast<double>(i)) {}
    Value(const char* s) : data_(std::string(s)) {}
    Value(std::string s) noexcept : data_(std::move(s)) {}
    Value(Array a) noexcept : data_(std::move(a)) {}
    Value(Object o) noexcept : data_(std::move(o)) {}

    Kind kind() const noexcept { return static_cast<Kind>(data_.index()); }
    bool isNull() const noexcept { return kind() == Kind::null; }

    // Throw std::bad_variant_access on a kind mismatch.
    bool asBool() const { return std::get<bool>(data_); }
    double asNumber() const { return std::get<double>(data_); }
    const std::string& asString() const { return std::get<std::string>(data_); }
    const Array& asArray() const { return std::get<Array>(data_); }
    const Object& asObject() const { return std::get<Object>(data_); }

    // Object member lookup; nullptr if absent or not an object.
    const Value* find(std::string_view key) const noexcept;

private:
    std::variant<std::nullptr_t, bool, double, std::string, Array, Object> data_{nullptr};
};

class ParseError : public std::runtime_error {
public:
    ParseError(std::string code, std::size_t offset, const std::string& message);

    // One of: syntax, trailing_content, too_deep, invalid_utf8,
    // lone_surrogate, duplicate_key, number_out_of_range.
    const std::string& code() const noexcept { return code_; }
    std::size_t offset() const noexcept { return offset_; }

private:
    std::string code_;
    std::size_t offset_;
};

struct ParseOptions {
    std::size_t maxDepth = 256;
};

Value parse(std::string_view text, const ParseOptions& options = {});

}  // namespace siann::json
