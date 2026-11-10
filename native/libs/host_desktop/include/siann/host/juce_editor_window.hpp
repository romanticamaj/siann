#pragma once

// The desktop target's editor windows (architecture spec, "siann-host: two targets,
// one interface"; m5-clap-editor-window): what ClapPluginHost embeds a CLAP editor
// into, and the same window the JUCE formats' editors live in. A juce::DocumentWindow
// with a native title bar, on the desktop from creation so its handle exists before
// it shows: an HWND owned by the given window through GWLP_HWNDPARENT on Windows, an
// NSView whose window floats (with FullScreenAuxiliary) on macOS, an X11 Window on
// Linux. Those are what clap_window_t carries for win32, cocoa and x11. JUCE stays
// behind this header. Main thread only, with a MainThreadLoop alive.

#include <functional>
#include <memory>
#include <string>

#include "siann/host/editor_window.hpp"

namespace siann::host {

class JuceEditorWindowFactory final : public EditorWindowFactory {
public:
    JuceEditorWindowFactory();
    ~JuceEditorWindowFactory() override;
    JuceEditorWindowFactory(const JuceEditorWindowFactory&) = delete;
    JuceEditorWindowFactory& operator=(const JuceEditorWindowFactory&) = delete;

    // A window holding an empty view sized by setContentSize, which converts the
    // plugin's physical pixels to JUCE's logical ones (points on macOS stay as they
    // are). Its close button calls onCloseButton from a later message.
    std::unique_ptr<EditorWindow> create(const std::string& title, EditorOwner owner,
                                         std::function<void()> onCloseButton) override;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::host
