#pragma once

// RFC 6962 Merkle Tree Hash and the SIANN document hash built on it.
// Must pass fixtures/hash/rfc6962.json and fixtures/hash/document.json, the
// same fixtures as the Node bridge (src/hash/merkle.js).

#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "siann/hash/sha256.hpp"

namespace siann::hash {

Digest leafHash(std::span<const std::uint8_t> leafInput) noexcept;
Digest nodeHash(const Digest& left, const Digest& right) noexcept;

// RFC 6962 MTH over already leaf-hashed entries. Empty input gives SHA-256("").
Digest treeHash(std::span<const Digest> leafHashes);

struct EntityLeaf {
    std::string type;  // ^[a-z][a-z0-9_]{0,31}$
    std::string id;    // ^[A-Za-z0-9_-]{1,64}$
    Digest entityHash{};
};

class DocumentHashError : public std::runtime_error {
public:
    DocumentHashError(std::string code, const std::string& message);

    // One of: invalid_entity_type, invalid_entity_id, duplicate_entity.
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

bool isValidEntityType(std::string_view type) noexcept;
bool isValidEntityId(std::string_view id) noexcept;

// Sorts by the ASCII bytes of "<type>:<id>"; leaf input is
// "<type>:<id>" || 0x00 || entityHash. Input order does not matter.
Digest documentHash(std::vector<EntityLeaf> leaves);

}  // namespace siann::hash
