#pragma once

// The window a plugin editor embeds into (architecture spec, "siann-host: two
// targets, one interface"; m5-clap-editor-window). A CLAP plugin's gui extension
// draws into a child view it makes inside a window the host hands it; ClapPluginHost
// has no window of its own, so it takes a factory at construction. The desktop
// target supplies one (siann-host-desktop's JuceEditorWindowFactory), the headless
// target none. Header-only interfaces; everything here runs on the main thread.

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "siann/host/interfaces.hpp"

namespace siann::host {

// One top-level native window with a title bar and a close button: owned by the
// given window on Windows, floating on macOS, a plain window on Linux, as the
// JUCE formats' editors are.
class EditorWindow {
public:
    virtual ~EditorWindow() = default;

    // The platform's handle of the window, the parent a plugin embeds into: an
    // HWND on Windows, an NSView (the window's content view) on macOS, an X11
    // Window on Linux. Valid from creation, before show(), and never 0.
    virtual std::uintptr_t nativeHandle() const = 0;
    // The size of what the plugin draws, in the units its gui extension uses
    // (physical pixels on Windows and Linux, points on macOS).
    virtual void setContentSize(int width, int height) = 0;
    virtual void show() = 0;
    virtual void hide() = 0;
    // Brings the window forward and gives it focus.
    virtual void toFront() = 0;
    // Opening an open editor applies the owner again (EditorOwner, interfaces.hpp).
    virtual void applyOwner(EditorOwner owner) = 0;
};

class EditorWindowFactory {
public:
    virtual ~EditorWindowFactory() = default;

    // A new window, created hidden. onCloseButton runs on the main thread when the
    // user presses the window's close button, outside the window's own event, so
    // it may destroy the window; it may also run after the window is gone, and the
    // caller guards what it captures. Throws std::runtime_error when the platform
    // makes no window.
    virtual std::unique_ptr<EditorWindow> create(const std::string& title, EditorOwner owner,
                                                 std::function<void()> onCloseButton) = 0;
};

}  // namespace siann::host
