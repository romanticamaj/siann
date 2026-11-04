# SIANN native engine

C++20 code for the native SIANN engine described in the
[native DAW architecture](../docs/superpowers/specs/2026-10-14-siann-native-daw-architecture.md)
and accepted by [ADR-0016](../docs/adr/0016-build-native-cpp-daw-engine.md).

The core builds with no JUCE. Third-party code is fetched and pinned by commit
in `cmake/SiannThirdParty.cmake`: dr_libs (WAV and FLAC decoding, public domain / MIT-0)
and r8brain-free-src (offline resampling, MIT), and IXWebSocket v11.4.6
(commit `2efe037c9cc96fd536774f17bdb5215161ee5087`, BSD-3-Clause per its
`LICENSE.txt`; HTTP and WebSocket for `siann-protocol`, built without zlib and
TLS because the server binds `127.0.0.1` only; TLS arrives with LAN mode). Tests
use Catch2, also pinned.

## Modules

| Module | Target | Contents |
|---|---|---|
| `libs/hash` (`siann-hash`) | `siann::hash` | SHA-256, strict I-JSON parser for hashed data, RFC 8785 JCS, RFC 6962 Merkle tree and the SIANN document hash |
| `libs/time` (`siann-time`) | `siann::time` | `AudioTime`, `MusicTime`, `Position`, step `TempoMap`, exact tick and sample conversion through superclocks |
| `libs/midi` (`siann-midi`) | `siann::midi` | MIDI 1.0 messages, event lists in MusicTime ticks, Standard MIDI File read and write (formats 0 and 1, tempo and meter) |
| `libs/model` (`siann-model`) | `siann::model` | Immutable session document (root, media, track, clip) with structural sharing, strict JSON load and save, validation, entity and document hashes, diff |
| `libs/command` (`siann-command`) | `siann::command` | Command catalog (pure document transforms with declared effects checked against the diff), transactions, revision history with undo and redo |
| `libs/io` (`siann-io`) | `siann::io` | Durable file primitives: append with flush, atomic replace, directory flush |
| `libs/media` (`siann-media`) | `siann::media` | WAV and FLAC decoding (dr_wav, dr_flac), streaming WAV reader, write-through WAV recorder with crash repair, 32-bit float WAV encoding, offline sample-rate conversion (r8brain) |
| `libs/session` (`siann-session`) | `siann::session` | Session bundle, journal records with checksums (write-ahead log), checkpoints, crash recovery, the `media.import` job, recorded takes (manifest, commit, recovery, discard) |
| `libs/host_api` (`siann-host-api`) | `siann::host_api` | Buffer views, block events, and the draft `AudioDevice`, `MidiDevice`, `PluginHost` and `MediaReader` interfaces (no implementation) |
| `libs/graph` (`siann-graph`) | `siann::graph` | Graph builder and compiler with per-edge plugin delay compensation, allocation-free processing, a realtime outbox for node latency changes, recompile with state migration (shared node instances and unchanged delay lines, affected edges marked), clip player, track fader, bus and `FakeLatency` (runtime latency changes) nodes |
| `libs/engine` (`siann-engine`) | `siann::engine` | Media loading with hash checks, document-to-graph compilation, latency-aligned offline render of a document or of any compiled graph (`renderGraph`) |
| `libs/rt` (`siann-rt`) | `siann::rt` | Lock-free SPSC and MPSC queues, realtime thread marker, allocation guard for tests |
| `libs/host_fake` (`siann-host-fake`) | `siann::host_fake` | Software audio device for tests: realtime thread, stop contract, unplug, stall, loopback, a fixed device rate |
| `libs/realtime` (`siann-realtime`) | `siann::realtime` | Graph driver (ownership states, duck-and-swap, retirement on acknowledgement, watchdog, latency changes answered by a recompile that ramps only the affected paths), realtime PDC null and offline/realtime parity tests, parameter channel and control dispatcher, transport (`transport.hpp`: play, stop and locate through the butler handshake with a ready timeout, on the driver's `transportInbox`), disk streaming (butler, two-slot rings, streaming player), recorder (input capture, write-through), device-side SRC (r8brain streaming resampler, one-block FIFO, resampling state and latency report) |
| `libs/playback` (`siann-playback`) | `siann::playback` | Playback assembly above `siann-engine` and `siann-realtime`: session document to streaming graph (streaming player and track fader per track, master bus) with the entity-to-slot map, playback engine owning the driver, dispatcher and butler, fader gestures committed as one revision; in-memory `MediaReader` for FLAC |
| `libs/protocol` (`siann-protocol`) | `siann::protocol` | Protocol server v0 (spec "siann-protocol"): per-launch token handshake in the first message, Origin allow list with the app scheme `siann://app`, request envelope with `sessionId` and idempotency `requestId`, one response per request with stable error codes, bounded inbox to the command thread, idempotency cache; the transport is a thin adapter interface with one IXWebSocket implementation (`127.0.0.1`, `GET /v0/health` with a bearer token) |
| `libs/host_desktop` (`siann-host-desktop`) | `siann::host_desktop` | JUCE 9 audio devices (WASAPI, ASIO, CoreAudio, ALSA) behind `AudioDevice`, opening at the device's own rate when it cannot run at the session's; built with `SIANN_WITH_JUCE=ON` (preset `desktop`), AGPLv3 per ADR-0017 |

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

Realtime commands (M2). `--device fake` is a paced software device with
loopback and runs anywhere; real devices (`devices`, a device id
`"<type>/<name>"`, or the default output) need the desktop build and report
`no_audio_backend` otherwise.

```sh
siann-cli devices
siann-cli play Song.siann --seconds 10 --device fake
siann-cli record Song.siann --track trk_vox --seconds 30   # without --seconds: until Ctrl+C
siann-cli recover Song.siann take_123        # commit a take left pending by a crash
siann-cli bench Bench.siann --tracks 32 --buffer 256 --seconds 60
```

`bench` generates the bundle when it does not exist and reports `callbacks`,
`xruns` (deadline misses: callbacks longer than their buffer period),
`maxCallbackMicros`, and disk `underruns` and SRC `srcUnderruns` separately.

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

The `dev` preset treats warnings as errors. The `desktop` preset adds the JUCE
host target (`SIANN_WITH_JUCE=ON`); its device tests run against the machine's
real audio hardware, output silence only, and skip when there is no device. CI builds and tests on Windows,
macOS and Linux (`.github/workflows/ci.yml`).

### RealtimeSanitizer (Linux or WSL, Clang 20+)

The `rtsan` preset builds everything with `-fsanitize=realtime`
(`SIANN_RTSAN=ON`). Each audio callback runs in `siann::rt::ScopedRealtimeThread`,
which is the sanitizer's realtime context in this build, so any allocation,
lock, sleep or blocking call on the audio path stops the test with a
`RealtimeSanitizer` report. The `siann_rtsan_canary_*` tests check that the
sanitizer is live. Install Clang 20 from apt.llvm.org (Ubuntu or WSL), then:

```sh
wget https://apt.llvm.org/llvm.sh && sudo bash llvm.sh 20
sudo apt-get install -y libclang-rt-20-dev ninja-build
cd native
cmake --preset rtsan -DCMAKE_CXX_COMPILER=clang++-20
cmake --build --preset rtsan
ctest --preset rtsan                      # sets RTSAN_OPTIONS=halt_on_error=1
build/rtsan/libs/realtime/siann_realtime_tests "[src]"
```

A test that breaks the rules on purpose opens
`siann::rt::ScopedRealtimeSanitizerDisabler` and says why in a comment;
production code never does. Configuring with another compiler fails.

## Rules

- Hashed data never goes through a general JSON library: it is parsed with
  `siann::json::parse` and serialized with `siann::jcs::canonicalize`.
- Fixture expectations come from external sources (RFC 8785, RFC 6962 /
  Certificate Transparency, FIPS 180-4) or from a separate generator
  (`scripts/generate-hash-fixtures.js`), never from the implementation under
  test.
