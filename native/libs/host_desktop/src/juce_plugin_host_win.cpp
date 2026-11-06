#include "editor_platform.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace siann::host::editor_platform {

void applyOwner(std::uintptr_t window, std::uintptr_t owner) {
    if (window == 0 || owner == 0) {
        return;
    }
    // GWLP_HWNDPARENT sets the owner of a top-level window, also across
    // processes. A stale owner leaves the editor unowned rather than failing it.
    if (IsWindow(reinterpret_cast<HWND>(owner))) {
        SetWindowLongPtrW(reinterpret_cast<HWND>(window), GWLP_HWNDPARENT, static_cast<LONG_PTR>(owner));
    }
}

}  // namespace siann::host::editor_platform
