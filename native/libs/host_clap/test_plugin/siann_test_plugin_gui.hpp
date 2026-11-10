#pragma once

// siann_test_plugin's editor view (m5-clap-editor-window): a child view that fills
// itself with one flat colour, made with the platform's own API and no toolkit, so
// CI proves a host's window takes an embedded CLAP editor. A Win32 child window, an
// NSView (siann_test_plugin_gui_mac.mm), or an X11 window on its own display
// connection when the build found X11 (SIANN_TEST_PLUGIN_X11). Without one of them
// the plugin offers no gui extension. Main thread only.

#include <cstdint>

#if defined(_WIN32) || defined(__APPLE__) || defined(SIANN_TEST_PLUGIN_X11)
#define SIANN_TEST_PLUGIN_HAS_VIEW 1
#else
#define SIANN_TEST_PLUGIN_HAS_VIEW 0
#endif

namespace siann_test_plugin_gui {

#if SIANN_TEST_PLUGIN_HAS_VIEW
// A hidden child of parent (an HWND, an NSView, an X11 Window) of the given size in
// the API's units; null when the platform refuses.
void* createView(std::uintptr_t parent, std::uint32_t width, std::uint32_t height);
void resizeView(void* view, std::uint32_t width, std::uint32_t height);
void showView(void* view, bool visible);
void destroyView(void* view);
// From clap_entry.deinit: what the views registered with the platform goes.
void releaseViews();
#endif

}  // namespace siann_test_plugin_gui
