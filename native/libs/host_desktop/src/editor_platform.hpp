#pragma once

// The platform half of editor windows (architecture spec, "Process model"), kept
// out of the JUCE translation unit: windows.h and AppKit stay in their own files.
// Main thread only.
//
// Windows: an editor is owned by the given window across processes, through
// GWLP_HWNDPARENT, for z-order. macOS cannot do that: editors float, and the
// engine, an accessory application, becomes a regular one while any editor is
// open so it can take focus.

#include <cstdint>

namespace siann::host::editor_platform {

inline void applyOwner(std::uintptr_t, std::uintptr_t) {}
inline void startInBackground() {}
inline void editorOpened() {}
inline void editorRaised() {}
inline void editorClosed() {}

}  // namespace siann::host::editor_platform
