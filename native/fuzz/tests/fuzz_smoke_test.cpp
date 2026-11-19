// The fuzz harnesses as a deterministic ctest on every OS (m5b-nightly-quality,
// acceptance item 3): every committed corpus file, then a bounded count of
// inputs from fixed seeds (random bytes and corpus mutations, splitmix64), so
// MSVC, GCC and Clang feed the same bytes. A crash or an exception escaping a
// harness fails the test; afterwards the server still answers.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

#include "siann/fuzz/harness.hpp"

namespace fs = std::filesystem;

namespace {

constexpr std::uint64_t kSeeds[] = {1, 2, 0x5149414e4eULL};
constexpr std::size_t kIterationsPerSeed = 700;  // about 2,000 inputs per target
constexpr std::size_t kMaxLength = 2048;

std::vector<std::string> corpus(const std::string& target) {
    const fs::path dir = fs::path(SIANN_FUZZ_CORPUS_DIR) / target;
    REQUIRE(fs::is_directory(dir));
    std::vector<fs::path> files;
    for (const auto& entry : fs::directory_iterator(dir)) {
        if (entry.is_regular_file()) {
            files.push_back(entry.path());
        }
    }
    std::sort(files.begin(), files.end());  // the same order everywhere
    std::vector<std::string> out;
    for (const auto& file : files) {
        std::ifstream in(file, std::ios::binary);
        out.emplace_back(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
    }
    REQUIRE(out.size() >= 3);
    return out;
}

// A harness takes the bytes as libFuzzer's LLVMFuzzerTestOneInput does.
using Harness = void (*)(const std::uint8_t*, std::size_t);

void feed(Harness harness, const std::string& bytes) {
    harness(reinterpret_cast<const std::uint8_t*>(bytes.data()), bytes.size());
}

// Every committed seed file of the target, then the seeded inputs.
void smoke(const std::string& target, Harness harness) {
    const auto seeds = corpus(target);
    for (std::size_t i = 0; i < seeds.size(); ++i) {
        INFO(target << " corpus entry " << i);
        REQUIRE_NOTHROW(feed(harness, seeds[i]));
    }
    // The empty input, as libFuzzer starts with it.
    REQUIRE_NOTHROW(harness(nullptr, 0));
    for (const std::uint64_t seed : kSeeds) {
        siann::fuzz::SplitMix64 rng(seed);
        for (std::size_t i = 0; i < kIterationsPerSeed; ++i) {
            const std::string input = siann::fuzz::mutate(rng, seeds, kMaxLength);
            INFO(target << " seed " << seed << " input " << i);
            REQUIRE_NOTHROW(feed(harness, input));
        }
    }
}

}  // namespace

TEST_CASE("splitmix64 gives the published sequence on every compiler", "[fuzz]") {
    // The reference implementation's first outputs from seed 0.
    siann::fuzz::SplitMix64 rng(0);
    CHECK(rng.next() == 0xe220a8397b1dcdafULL);
    CHECK(rng.next() == 0x6e789e6aa1b965f4ULL);
    CHECK(rng.next() == 0x06c45d188009454fULL);
    siann::fuzz::SplitMix64 bounded(7);
    for (int i = 0; i < 1000; ++i) {
        CHECK(bounded.below(3) < 3);
    }
}

TEST_CASE("mutations are deterministic and bounded", "[fuzz]") {
    const std::vector<std::string> seeds{"{\"a\":1}", "[1,2,3]", ""};
    siann::fuzz::SplitMix64 a(42);
    siann::fuzz::SplitMix64 b(42);
    for (int i = 0; i < 500; ++i) {
        const std::string x = siann::fuzz::mutate(a, seeds, 64);
        CHECK(x == siann::fuzz::mutate(b, seeds, 64));
        CHECK(x.size() <= 64);
    }
}

TEST_CASE("fuzz smoke: one protocol text frame", "[fuzz]") {
    smoke("protocol_frame", siann::fuzz::protocolFrame);
    CHECK(siann::fuzz::protocolStillAnswers());
    siann::fuzz::reset();
}

TEST_CASE("fuzz smoke: JSON requests over the WebSocket", "[fuzz]") {
    smoke("ws_request", siann::fuzz::wsRequest);
    CHECK(siann::fuzz::protocolStillAnswers());
    siann::fuzz::reset();
}

TEST_CASE("fuzz smoke: the binary meter frame decoder", "[fuzz]") {
    smoke("meter_frame", siann::fuzz::meterFrame);
}

TEST_CASE("fuzz smoke: the binary loudness frame decoder", "[fuzz]") {
    smoke("loudness_frame", siann::fuzz::loudnessFrame);
}

TEST_CASE("fuzz smoke: MCP HTTP bodies", "[fuzz]") {
    smoke("mcp_http", siann::fuzz::mcpHttp);
    CHECK(siann::fuzz::mcpHttpStillAnswers());
    siann::fuzz::reset();
}

TEST_CASE("fuzz smoke: command and plan JSON", "[fuzz]") {
    smoke("command_json", siann::fuzz::commandJson);
}

TEST_CASE("the decoders' committed seeds are frames they accept", "[fuzz]") {
    // The corpora start from real frames (fixtures/protocol), so the fuzzer
    // begins past the header checks.
    std::size_t meters = 0;
    for (const std::string& seed : corpus("meter_frame")) {
        meters += siann::fuzz::meterFrameDecodes(reinterpret_cast<const std::uint8_t*>(seed.data()), seed.size()) ? 1 : 0;
    }
    CHECK(meters >= 1);
    std::size_t loudness = 0;
    for (const std::string& seed : corpus("loudness_frame")) {
        loudness +=
            siann::fuzz::loudnessFrameDecodes(reinterpret_cast<const std::uint8_t*>(seed.data()), seed.size()) ? 1 : 0;
    }
    CHECK(loudness >= 1);
}
