#include "siann/hash/merkle.hpp"

#include <algorithm>

namespace siann::hash {

DocumentHashError::DocumentHashError(std::string code, const std::string& message)
    : std::runtime_error(message), code_(std::move(code)) {}

Digest leafHash(std::span<const std::uint8_t> leafInput) noexcept {
    Sha256 hasher;
    const std::uint8_t prefix = 0x00;
    hasher.update(std::span<const std::uint8_t>(&prefix, 1));
    hasher.update(leafInput);
    return hasher.finish();
}

Digest nodeHash(const Digest& left, const Digest& right) noexcept {
    Sha256 hasher;
    const std::uint8_t prefix = 0x01;
    hasher.update(std::span<const std::uint8_t>(&prefix, 1));
    hasher.update(left);
    hasher.update(right);
    return hasher.finish();
}

Digest treeHash(std::span<const Digest> leafHashes) {
    if (leafHashes.empty()) {
        return sha256(std::string_view{});
    }
    if (leafHashes.size() == 1) {
        return leafHashes.front();
    }
    std::size_t k = 1;
    while (k * 2 < leafHashes.size()) {
        k *= 2;
    }
    return nodeHash(treeHash(leafHashes.first(k)), treeHash(leafHashes.subspan(k)));
}

bool isValidEntityType(std::string_view type) noexcept {
    if (type.empty() || type.size() > 32 || type[0] < 'a' || type[0] > 'z') {
        return false;
    }
    return std::all_of(type.begin(), type.end(), [](char c) {
        return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
    });
}

bool isValidEntityId(std::string_view id) noexcept {
    if (id.empty() || id.size() > 64) {
        return false;
    }
    return std::all_of(id.begin(), id.end(), [](char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
    });
}

Digest documentHash(std::vector<EntityLeaf> leaves) {
    struct Keyed {
        std::string key;
        Digest digest;
    };
    std::vector<Keyed> keyed;
    keyed.reserve(leaves.size());
    for (auto& leaf : leaves) {
        if (!isValidEntityType(leaf.type)) {
            throw DocumentHashError("invalid_entity_type", "invalid entity type '" + leaf.type + "'");
        }
        if (!isValidEntityId(leaf.id)) {
            throw DocumentHashError("invalid_entity_id", "invalid entity id '" + leaf.id + "'");
        }
        keyed.push_back({leaf.type + ":" + leaf.id, leaf.entityHash});
    }
    // Keys are ASCII, so std::string comparison is byte order.
    std::sort(keyed.begin(), keyed.end(), [](const Keyed& a, const Keyed& b) { return a.key < b.key; });

    std::vector<Digest> leafHashes;
    leafHashes.reserve(keyed.size());
    for (std::size_t i = 0; i < keyed.size(); ++i) {
        if (i > 0 && keyed[i - 1].key == keyed[i].key) {
            throw DocumentHashError("duplicate_entity", "duplicate entity '" + keyed[i].key + "'");
        }
        std::vector<std::uint8_t> input(keyed[i].key.begin(), keyed[i].key.end());
        input.push_back(0x00);
        input.insert(input.end(), keyed[i].digest.begin(), keyed[i].digest.end());
        leafHashes.push_back(leafHash(input));
    }
    return treeHash(leafHashes);
}

}  // namespace siann::hash
