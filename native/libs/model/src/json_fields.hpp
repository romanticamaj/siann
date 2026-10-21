#pragma once

// Strict readers for entity JSON: every field must be known, typed and in
// range, so a document that loads always re-serializes to the same bytes.

#include <charconv>
#include <cmath>
#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <string_view>

#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/model/document.hpp"

namespace siann::model::detail {

class FieldReader {
public:
    FieldReader(const json::Value& value, std::string context) : context_(std::move(context)) {
        if (value.kind() != json::Value::Kind::object) {
            throw ModelError("invalid_field", context_ + " must be an object");
        }
        object_ = &value.asObject();
    }

    const json::Value& require(std::string_view key) {
        const json::Value* found = find(key);
        if (found == nullptr) {
            throw ModelError("missing_field", context_ + "." + std::string(key) + " is required");
        }
        return *found;
    }

    const json::Value* optional(std::string_view key) { return find(key); }

    std::string string(std::string_view key) {
        const json::Value& v = require(key);
        if (v.kind() != json::Value::Kind::string) {
            fail(key, "must be a string");
        }
        return v.asString();
    }

    bool boolean(std::string_view key) {
        const json::Value& v = require(key);
        if (v.kind() != json::Value::Kind::boolean) {
            fail(key, "must be a boolean");
        }
        return v.asBool();
    }

    // A JSON number that is an exact integer in [min, max].
    std::int64_t integer(std::string_view key, std::int64_t min, std::int64_t max) {
        return integerValue(require(key), key, min, max);
    }

    std::int64_t integerValue(const json::Value& v, std::string_view key, std::int64_t min, std::int64_t max) {
        if (v.kind() != json::Value::Kind::number) {
            fail(key, "must be a number");
        }
        const double d = v.asNumber();
        if (std::floor(d) != d || d < static_cast<double>(min) || d > static_cast<double>(max)) {
            fail(key, "must be an integer in range");
        }
        return static_cast<std::int64_t>(d);
    }

    // A 64-bit integer written as a canonical decimal string.
    std::int64_t int64String(std::string_view key) { return int64StringValue(require(key), key); }

    std::int64_t int64StringValue(const json::Value& v, std::string_view key) {
        if (v.kind() != json::Value::Kind::string) {
            fail(key, "must be a decimal string");
        }
        const std::string& text = v.asString();
        const std::string_view digits = !text.empty() && text[0] == '-' ? std::string_view(text).substr(1)
                                                                        : std::string_view(text);
        if (digits.empty() || (digits.size() > 1 && digits[0] == '0') || text == "-0") {
            fail(key, "must be a canonical decimal string");
        }
        std::int64_t out = 0;
        const auto result = std::from_chars(text.data(), text.data() + text.size(), out);
        if (result.ec != std::errc{} || result.ptr != text.data() + text.size()) {
            fail(key, "must be a 64-bit decimal string");
        }
        return out;
    }

    hash::Digest digest(std::string_view key) {
        const auto parsed = hash::parseHash(string(key));
        if (!parsed) {
            fail(key, "must be a sha256: hash");
        }
        return *parsed;
    }

    void expectSchema(std::string_view schema) {
        const std::string actual = string("schema");
        if (actual != schema) {
            throw ModelError("unsupported_version", context_ + " has schema " + actual + ", expected " +
                                                       std::string(schema));
        }
    }

    // Rejects fields that were never read.
    void finish() const {
        for (const auto& member : *object_) {
            if (used_.count(member.first) == 0) {
                throw ModelError("unknown_field", context_ + "." + member.first + " is not a known field");
            }
        }
    }

    [[noreturn]] void fail(std::string_view key, const std::string& message) const {
        throw ModelError("invalid_field", context_ + "." + std::string(key) + " " + message);
    }

private:
    const json::Value* find(std::string_view key) {
        for (const auto& member : *object_) {
            if (member.first == key) {
                used_.insert(member.first);
                return &member.second;
            }
        }
        return nullptr;
    }

    const json::Object* object_ = nullptr;
    std::string context_;
    std::set<std::string, std::less<>> used_;
};

}  // namespace siann::model::detail
