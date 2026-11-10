#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "siann/host/editor_window.hpp"

// host::EditorWindowFactory (m5-clap-editor-window; architecture spec, "siann-host:
// two targets, one interface"): the window a CLAP editor embeds into, supplied by
// the desktop target. Header-only: this executable links nothing but the header.

namespace {

struct Recording {
    std::vector<std::string> calls;
};

class RecordingWindow final : public siann::host::EditorWindow {
public:
    RecordingWindow(Recording& recording, std::uintptr_t handle) : recording_(recording), handle_(handle) {}
    ~RecordingWindow() override { recording_.calls.push_back("destroyed"); }

    std::uintptr_t nativeHandle() const override { return handle_; }
    void setContentSize(int width, int height) override {
        recording_.calls.push_back("size " + std::to_string(width) + "x" + std::to_string(height));
    }
    void show() override { recording_.calls.push_back("show"); }
    void hide() override { recording_.calls.push_back("hide"); }
    void toFront() override { recording_.calls.push_back("front"); }
    void applyOwner(siann::host::EditorOwner owner) override {
        recording_.calls.push_back("owner " + std::to_string(owner.nativeWindow));
    }

private:
    Recording& recording_;
    std::uintptr_t handle_;
};

class RecordingFactory final : public siann::host::EditorWindowFactory {
public:
    explicit RecordingFactory(Recording& recording) : recording_(recording) {}

    std::unique_ptr<siann::host::EditorWindow> create(const std::string& title, siann::host::EditorOwner owner,
                                                      std::function<void()> onCloseButton) override {
        recording_.calls.push_back("create " + title + " " + std::to_string(owner.nativeWindow));
        closeButton = std::move(onCloseButton);
        return std::make_unique<RecordingWindow>(recording_, 42);
    }

    std::function<void()> closeButton;

private:
    Recording& recording_;
};

}  // namespace

TEST_CASE("editor window: a factory makes the window an editor embeds into", "[host][editor]") {
    Recording recording;
    RecordingFactory factory(recording);
    siann::host::EditorWindowFactory& any = factory;
    bool closed = false;
    auto window = any.create("Plugin", siann::host::EditorOwner{7}, [&] { closed = true; });
    REQUIRE(window != nullptr);
    CHECK(window->nativeHandle() == 42);
    window->setContentSize(320, 200);
    window->show();
    window->toFront();
    window->applyOwner(siann::host::EditorOwner{9});
    window->hide();
    factory.closeButton();
    CHECK(closed);
    window.reset();
    CHECK(recording.calls == std::vector<std::string>{"create Plugin 7", "size 320x200", "show", "front", "owner 9",
                                                      "hide", "destroyed"});
}
