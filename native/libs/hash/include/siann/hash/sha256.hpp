#pragma once

// SHA-256 (FIPS 180-4). Non-realtime code only.

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>

namespace siann::hash {

using Digest = std::array<std::uint8_t, 32>;

class Sha256 {
public:
    Sha256() noexcept;

    void update(std::span<const std::uint8_t> data) noexcept;
    void update(std::string_view data) noexcept;

    // Returns the digest and resets the object for reuse.
    Digest finish() noexcept;
    void reset() noexcept;

private:
    void compress(const std::uint8_t* block) noexcept;

    std::array<std::uint32_t, 8> state_{};
    std::array<std::uint8_t, 64> buffer_{};
    std::size_t bufferSize_ = 0;
    std::uint64_t totalBytes_ = 0;
};

Digest sha256(std::string_view data) noexcept;
Digest sha256(std::span<const std::uint8_t> data) noexcept;

// Lowercase hex, 64 characters.
std::string toHex(const Digest& digest);

// "sha256:" followed by lowercase hex: the SIANN hash text form.
std::string formatHash(const Digest& digest);

// Parses the SIANN hash text form. Uppercase hex and other forms are rejected.
std::optional<Digest> parseHash(std::string_view text) noexcept;

}  // namespace siann::hash
