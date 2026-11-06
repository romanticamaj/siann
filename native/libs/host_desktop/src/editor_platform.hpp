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

#if defined(_WIN32)
void applyOwner(std::uintptr_t window, std::uintptr_t owner);
#else
inline void applyOwner(std::uintptr_t, std::uintptr_t) {}
#endif

#if defined(__APPLE__)
void startInBackground();
void editorOpened();
void editorRaised();
void editorClosed();
#else
inline void startInBackground() {}
inline void editorOpened() {}
inline void editorRaised() {}
inline void editorClosed() {}
#endif

}  // namespace siann::host::editor_platform
