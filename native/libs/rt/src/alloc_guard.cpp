// Replaces the global allocation functions for test executables. Linked only
// through the siann_rt_alloc_guard object library. Allocations still succeed;
// on a realtime-marked thread they are counted as violations.

#include <cstdlib>
#include <new>

#include "siann/rt/realtime_thread.hpp"

namespace {

void* allocate(std::size_t size) {
    if (siann::rt::isRealtimeThread()) {
        siann::rt::detail::recordAllocationViolation();
    }
    void* p = std::malloc(size == 0 ? 1 : size);
    if (p == nullptr) {
        throw std::bad_alloc();
    }
    return p;
}

void release(void* p) noexcept {
    if (p != nullptr && siann::rt::isRealtimeThread()) {
        siann::rt::detail::recordAllocationViolation();
    }
    std::free(p);
}

}  // namespace

void* operator new(std::size_t size) {
    return allocate(size);
}
void* operator new[](std::size_t size) {
    return allocate(size);
}
void* operator new(std::size_t size, const std::nothrow_t&) noexcept {
    try {
        return allocate(size);
    } catch (...) {
        return nullptr;
    }
}
void* operator new[](std::size_t size, const std::nothrow_t&) noexcept {
    try {
        return allocate(size);
    } catch (...) {
        return nullptr;
    }
}
void operator delete(void* p) noexcept {
    release(p);
}
void operator delete[](void* p) noexcept {
    release(p);
}
void operator delete(void* p, std::size_t) noexcept {
    release(p);
}
void operator delete[](void* p, std::size_t) noexcept {
    release(p);
}
void operator delete(void* p, const std::nothrow_t&) noexcept {
    release(p);
}
void operator delete[](void* p, const std::nothrow_t&) noexcept {
    release(p);
}
