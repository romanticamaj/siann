// siann_test_plugin's editor view on Windows and X11 (siann_test_plugin_gui.hpp).
// Apart from the plugin's own file so windows.h and Xlib's macros stay out of it.

#include "siann_test_plugin_gui.hpp"

#if defined(_WIN32)

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace siann_test_plugin_gui {

namespace {

// Hosts look the view up by this name (FindWindowExW).
constexpr const wchar_t* viewClass = L"SiannTestPluginView";
constexpr COLORREF viewColour = RGB(0x2a, 0x6f, 0x97);

LRESULT CALLBACK viewProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    if (message == WM_ERASEBKGND) {
        RECT client{};
        GetClientRect(window, &client);
        HBRUSH brush = CreateSolidBrush(viewColour);
        FillRect(reinterpret_cast<HDC>(wParam), &client, brush);
        DeleteObject(brush);
        return 1;
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

// This library, not the host's executable: the class belongs to it, and goes with it.
HINSTANCE thisModule() {
    HMODULE module = nullptr;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       reinterpret_cast<LPCWSTR>(&viewProcedure), &module);
    return module;
}

bool registerClass() {
    WNDCLASSEXW existing{};
    existing.cbSize = sizeof(existing);
    if (GetClassInfoExW(thisModule(), viewClass, &existing)) {
        return true;
    }
    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = viewProcedure;
    windowClass.hInstance = thisModule();
    windowClass.hCursor = LoadCursorW(nullptr, reinterpret_cast<LPCWSTR>(IDC_ARROW));
    windowClass.lpszClassName = viewClass;
    return RegisterClassExW(&windowClass) != 0;
}

}  // namespace

void* createView(std::uintptr_t parent, std::uint32_t width, std::uint32_t height) {
    if (parent == 0 || !registerClass()) {
        return nullptr;
    }
    HWND view = CreateWindowExW(0, viewClass, L"", WS_CHILD | WS_CLIPSIBLINGS, 0, 0, static_cast<int>(width),
                                static_cast<int>(height), reinterpret_cast<HWND>(parent), nullptr, thisModule(),
                                nullptr);
    return view;
}

void resizeView(void* view, std::uint32_t width, std::uint32_t height) {
    SetWindowPos(static_cast<HWND>(view), nullptr, 0, 0, static_cast<int>(width), static_cast<int>(height),
                 SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
}

void showView(void* view, bool visible) { ShowWindow(static_cast<HWND>(view), visible ? SW_SHOW : SW_HIDE); }

void destroyView(void* view) { DestroyWindow(static_cast<HWND>(view)); }

void releaseViews() {
    // Fails, harmlessly, while a view of the class is alive.
    UnregisterClassW(viewClass, thisModule());
}

}  // namespace siann_test_plugin_gui

#elif defined(SIANN_TEST_PLUGIN_X11)

#include <X11/Xlib.h>

namespace siann_test_plugin_gui {

namespace {

constexpr unsigned long viewColour = 0x2a6f97;  // a TrueColor pixel

// Its own connection: the host's display is the host's, and a CLAP gets a Window id.
struct View {
    Display* display = nullptr;
    ::Window window = 0;
};

}  // namespace

void* createView(std::uintptr_t parent, std::uint32_t width, std::uint32_t height) {
    Display* display = XOpenDisplay(nullptr);
    if (display == nullptr || parent == 0) {
        if (display != nullptr) {
            XCloseDisplay(display);
        }
        return nullptr;
    }
    auto* view = new View;
    view->display = display;
    view->window = XCreateSimpleWindow(display, static_cast<::Window>(parent), 0, 0, width, height, 0, 0, viewColour);
    XFlush(display);
    return view;
}

void resizeView(void* view, std::uint32_t width, std::uint32_t height) {
    auto* x = static_cast<View*>(view);
    XResizeWindow(x->display, x->window, width, height);
    XFlush(x->display);
}

void showView(void* view, bool visible) {
    auto* x = static_cast<View*>(view);
    if (visible) {
        XMapWindow(x->display, x->window);
    } else {
        XUnmapWindow(x->display, x->window);
    }
    XFlush(x->display);
}

void destroyView(void* view) {
    auto* x = static_cast<View*>(view);
    XDestroyWindow(x->display, x->window);
    XCloseDisplay(x->display);
    delete x;
}

void releaseViews() {}

}  // namespace siann_test_plugin_gui

#endif
