#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

#include "siann/hash/sha256.hpp"

using siann::hash::Digest;
using siann::hash::Sha256;
using siann::hash::formatHash;
using siann::hash::parseHash;
using siann::hash::sha256;
using siann::hash::toHex;

TEST_CASE("SHA-256 matches the FIPS 180-4 example vectors", "[sha256]") {
    CHECK(toHex(sha256(std::string_view{})) ==
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    CHECK(toHex(sha256("abc")) ==
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    CHECK(toHex(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")) ==
          "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
}

TEST_CASE("SHA-256 of one million 'a' characters", "[sha256]") {
    const std::string million(1'000'000, 'a');
    CHECK(toHex(sha256(million)) ==
          "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

TEST_CASE("Incremental updates give the same digest at every split point", "[sha256]") {
    const std::string message = "The quick brown fox jumps over the lazy dog, twice over, "
                                "to cross a 64-byte block boundary and then some more.";
    const Digest whole = sha256(message);
    for (std::size_t split = 0; split <= message.size(); ++split) {
        Sha256 hasher;
        hasher.update(std::string_view(message).substr(0, split));
        hasher.update(std::string_view(message).substr(split));
        INFO("split " << split);
        CHECK(hasher.finish() == whole);
    }
}

TEST_CASE("finish resets the hasher for reuse", "[sha256]") {
    Sha256 hasher;
    hasher.update("abc");
    const Digest first = hasher.finish();
    hasher.update("abc");
    CHECK(hasher.finish() == first);
}

TEST_CASE("Hash text form round-trips and rejects other forms", "[sha256]") {
    const Digest digest = sha256("abc");
    const std::string text = formatHash(digest);
    CHECK(text == "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    REQUIRE(parseHash(text).has_value());
    CHECK(*parseHash(text) == digest);

    CHECK_FALSE(parseHash("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    CHECK_FALSE(parseHash("sha256:BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"));
    CHECK_FALSE(parseHash("sha256:ba7816bf"));
    CHECK_FALSE(parseHash("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad00"));
    CHECK_FALSE(parseHash("sha256:zz7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
}
