# ADR-0017: License The Desktop Engine Under AGPLv3, With ASIO

Date: 2026-10-22

Status: Accepted

## Context

The native architecture ([ADR-0016](0016-build-native-cpp-daw-engine.md)) uses
JUCE in the desktop host target for audio devices, plugin hosting and editor
windows, and requires the licensing decisions below before the first build that
links JUCE devices (M2). Facts checked on 2026-10-22:

- JUCE 9 is current (9.0.4 released 2026-10-12; 9.0.3 on 2026-09-28). Its modules
  are dual-licensed under AGPLv3 and the commercial JUCE 9 licence
  (`LICENSE.md` in juce-framework/JUCE).
- Steinberg made the ASIO SDK available under GPLv3 alongside its proprietary
  terms in October 2025, and JUCE 9 bundles the ASIO sources
  (`modules/juce_audio_devices/native/asio`).
- The VST3 SDK moved to the MIT licence with VST 3.8 (October 2025).
- This repository is GPL-2.0-or-later.

## Decision

1. **JUCE under AGPLv3.** Use JUCE 9 under the AGPLv3, pinned by commit to
   9.0.3, the newest release older than two weeks. No commercial JUCE licence.
2. **The desktop engine binary is conveyed under AGPLv3.** SIANN's own code stays
   GPL-2.0-or-later; its "or later" clause allows GPLv3, and GPLv3 section 13
   allows combining it with AGPLv3 code. Any distributed build that links JUCE is
   offered under the AGPLv3 as a whole. The headless target, which does not link
   JUCE, is unaffected.
3. **Ship ASIO.** Windows desktop builds enable ASIO using the GPLv3 ASIO SDK
   bundled with JUCE. GPLv3 code may be combined with the AGPLv3 work under
   GPLv3 section 13, so official ASIO builds are permitted.
4. **AGPL section 13 is honoured in the product.** Remote browser control and
   embedded devices are network interaction with the engine. The protocol exposes
   the corresponding source location (repository URL and the exact commit of the
   running build) to every client, and the UI shows it.
5. **VST3** is used through JUCE under the SDK's MIT licence.
6. **Rubber Band stays optional**, so no build depends on it.

## Consequences

- Third parties who modify and offer a SIANN desktop engine over a network must
  offer their source. A hardware partner wanting proprietary firmware would need
  the headless target (no JUCE) or a commercial JUCE licence.
- Contributors may not add dependencies whose licences are incompatible with
  AGPLv3 to the desktop target.
- The version pin moves to newer JUCE releases only once they are at least two
  weeks old, with the change recorded in `native/cmake`.
- The Apple Developer account exists (owned by the maintainer). Developer ID
  signing and notarization are set up at the end of M0, when there is an app
  bundle to sign; certificates and notarization keys will be stored as CI secrets
  only with the maintainer's confirmation at that time.
- `README.md` still describes the engine as Ardour-derived; it is updated with the
  other documents listed under "Documents made stale" in the architecture spec.
