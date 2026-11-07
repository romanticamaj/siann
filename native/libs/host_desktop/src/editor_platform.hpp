#pragma once

// The platform half of editor windows (architecture spec, "Process model"), kept
// out of the JUCE translation unit: windows.h and AppKit stay in their own files.
// Main thread only.
//
// Windows: an editor is owned by the given window across processes, through
// GWLP_HWNDPARENT, for z-order. macOS cannot do that: editors float, at the
// floating window level so the Electron window cannot bury them, and the engine,
// an accessory application, becomes a regular one while any editor is open so it
// can take focus.

#include <cstdint>

namespace siann::host::editor_platform {

#if defined(_WIN32)
void applyOwner(std::uintptr_t window, std::uintptr_t owner);
// A file that is no valid image, or a plugin missing a DLL, must fail the load:
// by default Windows opens a modal box instead, and in a headless engine nobody
// can answer it, so the load never returns. Process-wide, as a plugin may load
// its dependencies from any thread.
void failLoadsWithoutDialogs();
#else
inline void applyOwner(std::uintptr_t, std::uintptr_t) {}
inline void failLoadsWithoutDialogs() {}
#endif

#if defined(__APPLE__)
inline constexpr bool editorsFloat = true;
void startInBackground();
void editorOpened();
// The editor's window (by its content NSView) may join another application's
// fullscreen space: a floating window without this is hidden behind a
// fullscreen Electron.
void editorShown(std::uintptr_t view);
void editorRaised();
void editorClosed();
#else
inline constexpr bool editorsFloat = false;
inline void startInBackground() {}
inline void editorOpened() {}
inline void editorShown(std::uintptr_t) {}
inline void editorRaised() {}
inline void editorClosed() {}
#endif

}  // namespace siann::host::editor_platform
