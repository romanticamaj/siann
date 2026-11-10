#include "siann/host/juce_editor_window.hpp"

#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <stdexcept>
#include <utility>

#include "editor_platform.hpp"
#include "juce_editor_window_impl.hpp"

namespace siann::host {

namespace desktop {

namespace {

// The window an editor lives in. A top-level one, so the platform can own it
// (Windows) or float it (macOS); everything that would recreate its peer happens
// here, before anyone reads the handle.
class EditorDocumentWindow final : public juce::DocumentWindow {
public:
    // Parameter names unlike JUCE's members (ResizableWindow has a `resizable`): GCC's -Wshadow.
    EditorDocumentWindow(const juce::String& windowTitle, std::unique_ptr<juce::Component> view, bool canResize,
                         std::function<void()> onCloseButton)
        : juce::DocumentWindow(windowTitle, juce::Colours::black, juce::DocumentWindow::closeButton, true),
          onCloseButton_(std::move(onCloseButton)) {
        setUsingNativeTitleBar(true);
        setContentOwned(view.release(), true);
        setResizable(canResize, false);
        setAlwaysOnTop(editor_platform::editorsFloat);
    }

    void closeButtonPressed() override {
        // Not from inside the window's own event: the callback may destroy it.
        juce::MessageManager::callAsync([callback = onCloseButton_] {
            if (callback) {
                callback();
            }
        });
    }

private:
    std::function<void()> onCloseButton_;
};

class DesktopEditorWindow final : public EditorWindow {
public:
    DesktopEditorWindow(const juce::String& title, EditorOwner owner, std::unique_ptr<juce::Component> view,
                        bool canResize, std::function<void()> onCloseButton)
        : window_(std::make_unique<EditorDocumentWindow>(title, std::move(view), canResize, std::move(onCloseButton))) {
        if (nativeHandle() == 0) {
            throw std::runtime_error("the editor window has no native handle");
        }
        applyOwner(owner);
    }

    ~DesktopEditorWindow() override {
        window_.reset();
        if (shown_) {
            editor_platform::editorClosed();
        }
    }

    DesktopEditorWindow(const DesktopEditorWindow&) = delete;
    DesktopEditorWindow& operator=(const DesktopEditorWindow&) = delete;

    std::uintptr_t nativeHandle() const override {
        auto* peer = window_->getPeer();
        return peer == nullptr ? 0 : reinterpret_cast<std::uintptr_t>(peer->getNativeHandle());
    }

    // Physical pixels in, JUCE's logical ones out, except on macOS, where both are points.
    void setContentSize(int width, int height) override {
        double scale = 1.0;
#if !defined(__APPLE__)
        if (auto* peer = window_->getPeer(); peer != nullptr && peer->getPlatformScaleFactor() > 0.0) {
            scale = peer->getPlatformScaleFactor();
        }
#endif
        if (auto* content = window_->getContentComponent(); content != nullptr) {
            content->setSize(static_cast<int>(std::lround(width / scale)),
                             static_cast<int>(std::lround(height / scale)));
        }
    }

    void show() override {
        if (!shown_) {
            window_->centreWithSize(window_->getWidth(), window_->getHeight());
            window_->setVisible(true);
            shown_ = true;
            editor_platform::editorOpened();
            editor_platform::editorShown(nativeHandle());
        } else {
            window_->setVisible(true);
        }
    }

    void hide() override { window_->setVisible(false); }

    void toFront() override {
        window_->toFront(true);
        editor_platform::editorRaised();
    }

    void applyOwner(EditorOwner owner) override { editor_platform::applyOwner(nativeHandle(), owner.nativeWindow); }

private:
    std::unique_ptr<EditorDocumentWindow> window_;
    bool shown_ = false;
};

}  // namespace

std::unique_ptr<EditorWindow> makeEditorWindow(const juce::String& title, EditorOwner owner,
                                               std::unique_ptr<juce::Component> content, bool resizable,
                                               std::function<void()> onCloseButton) {
    return std::make_unique<DesktopEditorWindow>(title, owner, std::move(content), resizable, std::move(onCloseButton));
}

}  // namespace desktop

struct JuceEditorWindowFactory::Impl {
    juce::ScopedJuceInitialiser_GUI gui;
};

JuceEditorWindowFactory::JuceEditorWindowFactory() : impl_(std::make_unique<Impl>()) {}

JuceEditorWindowFactory::~JuceEditorWindowFactory() = default;

std::unique_ptr<EditorWindow> JuceEditorWindowFactory::create(const std::string& title, EditorOwner owner,
                                                              std::function<void()> onCloseButton) {
    // An empty view the plugin's own child view covers; black until it draws.
    auto content = std::make_unique<juce::Component>();
    content->setSize(1, 1);
    return desktop::makeEditorWindow(juce::String::fromUTF8(title.c_str(), static_cast<int>(title.size())), owner,
                                     std::move(content), false, std::move(onCloseButton));
}

}  // namespace siann::host
