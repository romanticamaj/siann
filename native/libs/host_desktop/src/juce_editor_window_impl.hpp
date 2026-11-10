#pragma once

// Inside siann-host-desktop: the one window class every desktop editor lives in, a
// CLAP plugin's embedded view (JuceEditorWindowFactory) and a VST3 or AU plugin's
// juce::AudioProcessorEditor (JucePluginInstance) alike. Main thread only.

#include <juce_gui_basics/juce_gui_basics.h>

#include <functional>
#include <memory>

#include "siann/host/editor_window.hpp"

namespace siann::host::desktop {

// A hidden top-level window owning content, sized to it, on the desktop already, so
// nativeHandle() is valid at once and stays the same until it goes. The close button
// calls onCloseButton from a later message, never inside the window's own event.
// The first show() counts an open editor for the platform (editor_platform.hpp), and
// the window's end counts it closed.
std::unique_ptr<EditorWindow> makeEditorWindow(const juce::String& title, EditorOwner owner,
                                               std::unique_ptr<juce::Component> content, bool resizable,
                                               std::function<void()> onCloseButton);

}  // namespace siann::host::desktop
