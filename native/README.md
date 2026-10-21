# SIANN native engine

C++20 code for the native SIANN engine described in the
[native DAW architecture](../docs/superpowers/specs/2026-10-14-siann-native-daw-architecture.md)
and accepted by [ADR-0016](../docs/adr/0016-build-native-cpp-daw-engine.md).

The core builds with no JUCE and no third-party runtime dependencies. Tests use
Catch2, fetched and pinned by CMake.

## Modules

| Module | Target | Contents |
|---|---|---|
| `libs/hash` (`siann-hash`) | `siann::hash` | SHA-256, strict I-JSON parser for hashed data, RFC 8785 JCS, RFC 6962 Merkle tree and the SIANN document hash |
| `libs/time` (`siann-time`) | `siann::time` | `AudioTime`, `MusicTime`, `Position`, step `TempoMap`, exact tick and sample conversion through superclocks |
| `libs/model` (`siann-model`) | `siann::model` | Immutable session document (root, media, track, clip) with structural sharing, strict JSON load and save, validation, entity and document hashes, diff |

`siann-hash` sits below `siann-model` and `siann-command`. It must pass the same
fixtures as the Node bridge (`src/hash/`): `fixtures/jcs/cases.json`,
`fixtures/hash/rfc6962.json` and `fixtures/hash/document.json`. `siann-time`
must match `fixtures/time/conversions.json`, generated with BigInt arithmetic by
`scripts/generate-time-fixtures.js`. `siann-model` must reproduce the entity and
document hashes in `fixtures/model/session-document-v1.json`, which the Node
bridge's hash code computes.

## Build and test

Windows (Visual Studio 2022 or Build Tools with the C++ workload; the helper
puts MSVC, CMake and Ninja on PATH):

```bat
cd native
tools\msvc-env.cmd cmake --preset dev
tools\msvc-env.cmd cmake --build --preset dev
tools\msvc-env.cmd ctest --preset dev
```

macOS and Linux (CMake 3.25 or newer, Ninja, a C++20 compiler):

```sh
cd native
cmake --preset dev
cmake --build --preset dev
ctest --preset dev
```

The `dev` preset treats warnings as errors. CI builds and tests on Windows,
macOS and Linux (`.github/workflows/ci.yml`).

## Rules

- Hashed data never goes through a general JSON library: it is parsed with
  `siann::json::parse` and serialized with `siann::jcs::canonicalize`.
- Fixture expectations come from external sources (RFC 8785, RFC 6962 /
  Certificate Transparency, FIPS 180-4) or from a separate generator
  (`scripts/generate-hash-fixtures.js`), never from the implementation under
  test.
