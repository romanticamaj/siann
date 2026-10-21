#include "siann/hash/sha256.hpp"

#include <algorithm>
#include <cstring>

namespace siann::hash {
namespace {

constexpr std::array<std::uint32_t, 64> kRoundConstants = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

constexpr std::array<std::uint32_t, 8> kInitialState = {
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
};

constexpr std::uint32_t rotr(std::uint32_t x, int n) noexcept {
    return (x >> n) | (x << (32 - n));
}

constexpr char kHexDigits[] = "0123456789abcdef";

int hexValue(char c) noexcept {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    return -1;
}

}  // namespace

Sha256::Sha256() noexcept {
    reset();
}

void Sha256::reset() noexcept {
    state_ = kInitialState;
    bufferSize_ = 0;
    totalBytes_ = 0;
}

void Sha256::compress(const std::uint8_t* block) noexcept {
    std::array<std::uint32_t, 64> w{};
    for (std::size_t i = 0; i < 16; ++i) {
        w[i] = (std::uint32_t{block[i * 4]} << 24) | (std::uint32_t{block[i * 4 + 1]} << 16) |
               (std::uint32_t{block[i * 4 + 2]} << 8) | std::uint32_t{block[i * 4 + 3]};
    }
    for (std::size_t i = 16; i < 64; ++i) {
        const std::uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        const std::uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    std::uint32_t a = state_[0];
    std::uint32_t b = state_[1];
    std::uint32_t c = state_[2];
    std::uint32_t d = state_[3];
    std::uint32_t e = state_[4];
    std::uint32_t f = state_[5];
    std::uint32_t g = state_[6];
    std::uint32_t h = state_[7];

    for (std::size_t i = 0; i < 64; ++i) {
        const std::uint32_t s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const std::uint32_t choose = (e & f) ^ (~e & g);
        const std::uint32_t temp1 = h + s1 + choose + kRoundConstants[i] + w[i];
        const std::uint32_t s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
        const std::uint32_t temp2 = s0 + majority;
        h = g;
        g = f;
        f = e;
        e = d + temp1;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2;
    }

    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
}

void Sha256::update(std::span<const std::uint8_t> data) noexcept {
    totalBytes_ += data.size();
    std::size_t offset = 0;
    if (bufferSize_ > 0) {
        const std::size_t take = std::min(buffer_.size() - bufferSize_, data.size());
        std::memcpy(buffer_.data() + bufferSize_, data.data(), take);
        bufferSize_ += take;
        offset = take;
        if (bufferSize_ < buffer_.size()) {
            return;
        }
        compress(buffer_.data());
        bufferSize_ = 0;
    }
    while (data.size() - offset >= buffer_.size()) {
        compress(data.data() + offset);
        offset += buffer_.size();
    }
    const std::size_t rest = data.size() - offset;
    if (rest > 0) {
        std::memcpy(buffer_.data(), data.data() + offset, rest);
        bufferSize_ = rest;
    }
}

void Sha256::update(std::string_view data) noexcept {
    update(std::span<const std::uint8_t>(reinterpret_cast<const std::uint8_t*>(data.data()), data.size()));
}

Digest Sha256::finish() noexcept {
    const std::uint64_t bitLength = totalBytes_ * 8;
    const std::uint8_t pad = 0x80;
    update(std::span<const std::uint8_t>(&pad, 1));
    const std::uint8_t zero = 0;
    while (bufferSize_ != 56) {
        update(std::span<const std::uint8_t>(&zero, 1));
    }
    std::array<std::uint8_t, 8> length{};
    for (std::size_t i = 0; i < 8; ++i) {
        length[i] = static_cast<std::uint8_t>(bitLength >> (56 - 8 * i));
    }
    update(length);

    Digest digest{};
    for (std::size_t i = 0; i < 8; ++i) {
        digest[i * 4] = static_cast<std::uint8_t>(state_[i] >> 24);
        digest[i * 4 + 1] = static_cast<std::uint8_t>(state_[i] >> 16);
        digest[i * 4 + 2] = static_cast<std::uint8_t>(state_[i] >> 8);
        digest[i * 4 + 3] = static_cast<std::uint8_t>(state_[i]);
    }
    reset();
    return digest;
}

Digest sha256(std::string_view data) noexcept {
    Sha256 hasher;
    hasher.update(data);
    return hasher.finish();
}

Digest sha256(std::span<const std::uint8_t> data) noexcept {
    Sha256 hasher;
    hasher.update(data);
    return hasher.finish();
}

std::string toHex(const Digest& digest) {
    std::string out;
    out.reserve(digest.size() * 2);
    for (const std::uint8_t byte : digest) {
        out.push_back(kHexDigits[byte >> 4]);
        out.push_back(kHexDigits[byte & 0x0f]);
    }
    return out;
}

std::string formatHash(const Digest& digest) {
    return "sha256:" + toHex(digest);
}

std::optional<Digest> parseHash(std::string_view text) noexcept {
    constexpr std::string_view prefix = "sha256:";
    if (text.size() != prefix.size() + 64 || text.substr(0, prefix.size()) != prefix) {
        return std::nullopt;
    }
    const std::string_view hex = text.substr(prefix.size());
    Digest digest{};
    for (std::size_t i = 0; i < digest.size(); ++i) {
        const int high = hexValue(hex[i * 2]);
        const int low = hexValue(hex[i * 2 + 1]);
        if (high < 0 || low < 0) {
            return std::nullopt;
        }
        digest[i] = static_cast<std::uint8_t>((high << 4) | low);
    }
    return digest;
}

}  // namespace siann::hash
