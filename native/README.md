# SIANN native engine

C++20 code for the native SIANN engine described in the
[native DAW architecture](../docs/superpowers/specs/2026-10-14-siann-native-daw-architecture.md)
and accepted by [ADR-0016](../docs/adr/0016-build-native-cpp-daw-engine.md).

The core builds with no JUCE. Third-party code is fetched and pinned by commit
in `cmake/SiannThirdParty.cmake`: dr_libs (WAV decoding, public domain / MIT-0)
and r8brain-free-src (offline resampling, MIT). Tests use Catch2, also pinned.

## Modules

| Module | Target | Contents |
|---|---|---|
| `libs/hash` (`siann-hash`) | `siann::hash` | SHA-256, strict I-JSON parser for hashed data, RFC 8785 JCS, RFC 6962 Merkle tree and the SIANN document hash |
| `libs/time` (`siann-time`) | `siann::time` | `AudioTime`, `MusicTime`, `Position`, step `TempoMap`, exact tick and sample conversion through superclocks |
| `libs/midi` (`siann-midi`) | `siann::midi` | MIDI 1.0 messages, event lists in MusicTime ticks, Standard MIDI File read and write (formats 0 and 1, tempo and meter) |
| `libs/model` (`siann-model`) | `siann::model` | Immutable session document (root, media, track, clip) with structural sharing, strict JSON load and save, validation, entity and document hashes, diff |
| `libs/command` (`siann-command`) | `siann::command` | Command catalog (pure document transforms with declared effects checked against the diff), transactions, revision history with undo and redo |
| `libs/io` (`siann-io`) | `siann::io` | Durable file primitives: append with flush, atomic replace, directory flush |
| `libs/media` (`siann-media`) | `siann::media` | WAV decoding (dr_wav), 32-bit float WAV encoding, offline sample-rate conversion (r8brain) |
| `libs/session` (`siann-session`) | `siann::session` | Session bundle, journal records with checksums (write-ahead log), checkpoints, crash recovery, the `media.import` job |
| `libs/host_api` (`siann-host-api`) | `siann::host_api` | Buffer views, block events, and the draft `AudioDevice`, `MidiDevice`, `PluginHost` and `MediaReader` interfaces (no implementation) |
| `libs/graph` (`siann-graph`) | `siann::graph` | Graph builder and compiler with per-edge plugin delay compensation, allocation-free processing, clip player, track fader, bus and `FakeLatency` nodes |
| `libs/engine` (`siann-engine`) | `siann::engine` | Media loading with hash checks, document-to-graph compilation, latency-aligned offline render |

`siann-hash` sits below `siann-model` and `siann-command`. It must pass the same
fixtures as the Node bridge (`src/hash/`): `fixtures/jcs/cases.json`,
`fixtures/hash/rfc6962.json` and `fixtures/hash/document.json`. `siann-time`
must match `fixtures/time/conversions.json`, generated with BigInt arithmetic by
`scripts/generate-time-fixtures.js`. `siann-model` must reproduce the entity and
document hashes in `fixtures/model/session-document-v1.json`, which the Node
bridge's hash code computes.

## siann-cli

`apps/cli` builds `siann-cli`, the headless command line for M1. Every command
prints one JSON object (`{"ok":true,...}` or `{"ok":false,"error":{...}}`); exit
code 0 is success, 1 a command failure, 2 a usage error.

```sh
siann-cli create Song.siann --name "Demo"
siann-cli import Song.siann kick.wav --media-id med_kick
siann-cli plan Song.siann @plan.json        # a JSON array of commands, one revision
siann-cli exec Song.siann @command.json     # one command
siann-cli undo Song.siann
siann-cli render Song.siann mix.wav
siann-cli verify Song.siann                 # replays the journal, checks the checkpoint
siann-cli info Song.siann
siann-cli commands
```

`--actor` and `--time` set the revision envelope; `--time` defaults to the
current UTC time.

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
