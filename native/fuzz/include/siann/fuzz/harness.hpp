#pragma once

// Fuzz harnesses for the engine's untrusted input (architecture spec, "Build,
// test and CI", Fuzz; m5b-nightly-quality). One function per target, shared by
// the two drivers: the libFuzzer executables of the Clang SIANN_FUZZ build
// (siann_fuzz_<target>, nightly, from native/fuzz/corpus/<target>/) and the
// seeded smoke ctest of every native build (fuzz_smoke_test.cpp). Each takes any
// bytes, as LLVMFuzzerTestOneInput does, and returns: a crash, a sanitizer
// report or an exception escaping it is a finding.
//
// The protocol targets drive one ProtocolServer over the in-memory transport
// (FakeTransport), with a session in a temporary bundle, created on first use
// and kept across inputs; the server pumps on the calling thread, so a run is
// deterministic.

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace siann::fuzz {

// In the two protocol targets every "$session" in the bytes becomes the
// server's (random) session id first, so a corpus request reaches its method
// instead of session_mismatch.

// protocol_frame: the protocol server's handling of one text frame, as the
// first (auth) frame of a new connection and as a frame on an authenticated one.
void protocolFrame(const std::uint8_t* data, std::size_t size);

// ws_request: the JSON request path over the WebSocket, after the upgrade and
// the token handshake: the bytes split on '\n' into a sequence of request frames
// on one authenticated connection (a commit, an undo, a fetch, ...).
void wsRequest(const std::uint8_t* data, std::size_t size);

// meter_frame and loudness_frame: the decoders of the realtime channel's binary
// meter and loudness frames (realtime_channel.hpp), as the app decodes them.
void meterFrame(const std::uint8_t* data, std::size_t size);
void loudnessFrame(const std::uint8_t* data, std::size_t size);

// mcp_http: the body of POST /v0/mcp, in the MCP session the harness
// initialized, through the adapter.
void mcpHttp(const std::uint8_t* data, std::size_t size);

// command_json: command and plan JSON, parsed, then validated against a small
// document.
void commandJson(const std::uint8_t* data, std::size_t size);

// Whether the decoders accept the bytes (the smoke test checks that the seeds
// are real frames).
bool meterFrameDecodes(const std::uint8_t* data, std::size_t size);
bool loudnessFrameDecodes(const std::uint8_t* data, std::size_t size);

// After a run: the server still answers a valid request (engine.capabilities
// on a new connection; tools/list over MCP).
bool protocolStillAnswers();
bool mcpHttpStillAnswers();

// Releases the shared server and its temporary bundle.
void reset();

// splitmix64 (Steele, Lea and Flood, 2014): the same numbers on every compiler,
// unlike the std distributions.
class SplitMix64 {
public:
    explicit SplitMix64(std::uint64_t seed) noexcept : state_(seed) {}
    std::uint64_t next() noexcept;
    // Uniform enough in [0, bound); bound > 0.
    std::size_t below(std::size_t bound) noexcept;

private:
    std::uint64_t state_;
};

// Random bytes, or a mutation of a corpus entry (bytes flipped, inserted,
// erased, duplicated, truncated, two entries spliced), of at most maxLength.
std::string mutate(SplitMix64& rng, const std::vector<std::string>& corpus, std::size_t maxLength);

}  // namespace siann::fuzz
