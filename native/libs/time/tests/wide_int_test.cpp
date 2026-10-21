#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <limits>
#include <stdexcept>

#include "siann/time/wide_int.hpp"

using namespace siann::time::detail;

namespace {
constexpr std::uint64_t kMax = std::numeric_limits<std::uint64_t>::max();
}

TEST_CASE("mul64 gives the full 128-bit product", "[wide_int]") {
    CHECK(mul64(0, kMax) == U128{0, 0});
    CHECK(mul64(kMax, 1) == U128{0, kMax});
    CHECK(mul64(kMax, 2) == U128{1, kMax - 1});
    // (2^64 - 1)^2 = 2^128 - 2^65 + 1
    CHECK(mul64(kMax, kMax) == U128{kMax - 1, 1});
    CHECK(mul64(0x1'0000'0000ull, 0x1'0000'0000ull) == U128{1, 0});
}

TEST_CASE("add and sub carry and borrow across words", "[wide_int]") {
    CHECK(add(U128{0, kMax}, U128{0, 1}) == U128{1, 0});
    CHECK(sub(U128{1, 0}, U128{0, 1}) == U128{0, kMax});
    CHECK_THROWS_AS(add(U128{kMax, kMax}, U128{0, 1}), std::overflow_error);
    CHECK_THROWS_AS(add(U128{kMax, 0}, U128{1, 0}), std::overflow_error);
    CHECK_THROWS_AS(sub(U128{0, 1}, U128{0, 2}), std::underflow_error);
}

TEST_CASE("mul of a 128-bit value by 64 bits", "[wide_int]") {
    CHECK(mul(U128{1, 0}, 3) == U128{3, 0});
    CHECK(mul(U128{0, kMax}, kMax) == U128{kMax - 1, 1});
    CHECK_THROWS_AS(mul(U128{kMax, 0}, 2), std::overflow_error);
}

TEST_CASE("divmod by a 64-bit divisor", "[wide_int]") {
    const DivMod a = divmod(U128{1, 0}, 3);  // 2^64 / 3
    CHECK(a.quotient == U128{0, 0x5555'5555'5555'5555ull});
    CHECK(a.remainder == 1);

    const DivMod b = divmod(mul64(kMax, kMax), kMax);
    CHECK(b.quotient == U128{0, kMax});
    CHECK(b.remainder == 0);

    const DivMod c = divmod(U128{0, 7}, 10);
    CHECK(c.quotient == U128{0, 0});
    CHECK(c.remainder == 7);

    CHECK_THROWS_AS(divmod(U128{0, 1}, 0), std::domain_error);
}

TEST_CASE("divRoundHalfEven rounds ties to even", "[wide_int]") {
    CHECK(divRoundHalfEven(fromU64(25), 10) == 2);  // 2.5 -> 2
    CHECK(divRoundHalfEven(fromU64(35), 10) == 4);  // 3.5 -> 4
    CHECK(divRoundHalfEven(fromU64(26), 10) == 3);
    CHECK(divRoundHalfEven(fromU64(24), 10) == 2);
    CHECK(divRoundHalfEven(fromU64(5), 10) == 0);   // 0.5 -> 0
    CHECK(divRoundHalfEven(fromU64(15), 10) == 2);  // 1.5 -> 2
    CHECK(divRoundHalfEven(fromU64(1), 3) == 0);
    CHECK(divRoundHalfEven(fromU64(2), 3) == 1);
    CHECK_THROWS_AS(divRoundHalfEven(U128{1, 0}, 1), std::overflow_error);
}
