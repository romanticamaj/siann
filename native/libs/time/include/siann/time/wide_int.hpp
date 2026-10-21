#pragma once

// Portable unsigned 128-bit arithmetic for exact time conversion. MSVC has no
// __int128, and conversions must be bit-identical on every platform.

#include <cstdint>
#include <stdexcept>

namespace siann::time::detail {

struct U128 {
    std::uint64_t hi = 0;
    std::uint64_t lo = 0;

    friend constexpr bool operator==(const U128&, const U128&) = default;
};

constexpr U128 fromU64(std::uint64_t v) noexcept {
    return {0, v};
}

constexpr bool less(const U128& a, const U128& b) noexcept {
    return a.hi < b.hi || (a.hi == b.hi && a.lo < b.lo);
}

constexpr U128 add(const U128& a, const U128& b) {
    const std::uint64_t lo = a.lo + b.lo;
    const std::uint64_t carry = lo < a.lo ? 1u : 0u;
    const std::uint64_t hiSum = a.hi + b.hi;
    const std::uint64_t hi = hiSum + carry;
    if (hiSum < a.hi || hi < hiSum) {
        throw std::overflow_error("128-bit addition overflow");
    }
    return {hi, lo};
}

// a - b, requires a >= b.
constexpr U128 sub(const U128& a, const U128& b) {
    if (less(a, b)) {
        throw std::underflow_error("128-bit subtraction underflow");
    }
    U128 r{a.hi - b.hi, a.lo - b.lo};
    if (a.lo < b.lo) {
        --r.hi;
    }
    return r;
}

constexpr U128 mul64(std::uint64_t a, std::uint64_t b) noexcept {
    const std::uint64_t aLo = a & 0xFFFFFFFFu;
    const std::uint64_t aHi = a >> 32;
    const std::uint64_t bLo = b & 0xFFFFFFFFu;
    const std::uint64_t bHi = b >> 32;

    const std::uint64_t ll = aLo * bLo;
    const std::uint64_t lh = aLo * bHi;
    const std::uint64_t hl = aHi * bLo;
    const std::uint64_t hh = aHi * bHi;

    const std::uint64_t mid = (ll >> 32) + (lh & 0xFFFFFFFFu) + (hl & 0xFFFFFFFFu);
    return {hh + (lh >> 32) + (hl >> 32) + (mid >> 32), (mid << 32) | (ll & 0xFFFFFFFFu)};
}

// a * b for a 128-bit a; throws if the product does not fit in 128 bits.
constexpr U128 mul(const U128& a, std::uint64_t b) {
    const U128 low = mul64(a.lo, b);
    const U128 high = mul64(a.hi, b);
    if (high.hi != 0) {
        throw std::overflow_error("128-bit multiplication overflow");
    }
    const std::uint64_t hi = low.hi + high.lo;
    if (hi < low.hi) {
        throw std::overflow_error("128-bit multiplication overflow");
    }
    return {hi, low.lo};
}

struct DivMod {
    U128 quotient;
    std::uint64_t remainder = 0;
};

// Long division of a 128-bit value by a non-zero 64-bit divisor.
constexpr DivMod divmod(const U128& n, std::uint64_t d) {
    if (d == 0) {
        throw std::domain_error("division by zero");
    }
    DivMod result;
    U128 remainder{};
    for (int bit = 127; bit >= 0; --bit) {
        // remainder = remainder * 2 + next bit of n
        remainder.hi = (remainder.hi << 1) | (remainder.lo >> 63);
        const std::uint64_t nextBit = bit >= 64 ? (n.hi >> (bit - 64)) & 1u : (n.lo >> bit) & 1u;
        remainder.lo = (remainder.lo << 1) | nextBit;
        if (!less(remainder, fromU64(d))) {
            remainder = sub(remainder, fromU64(d));
            if (bit >= 64) {
                result.quotient.hi |= std::uint64_t{1} << (bit - 64);
            } else {
                result.quotient.lo |= std::uint64_t{1} << bit;
            }
        }
    }
    result.remainder = remainder.lo;
    return result;
}

// n / d rounded to nearest, ties to even. Throws if the result exceeds 63 bits.
constexpr std::uint64_t divRoundHalfEven(const U128& n, std::uint64_t d) {
    const DivMod qr = divmod(n, d);
    if (qr.quotient.hi != 0 || qr.quotient.lo > (std::uint64_t{1} << 62)) {
        throw std::overflow_error("quotient out of range");
    }
    std::uint64_t q = qr.quotient.lo;
    const std::uint64_t r = qr.remainder;
    const std::uint64_t rest = d - r;  // r < d
    if (r > rest || (r == rest && (q & 1u) != 0)) {
        ++q;
    }
    return q;
}

}  // namespace siann::time::detail
