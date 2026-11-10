// Replaces the global allocation functions for siann_media_tests; see
// allocation_fuse.hpp. Disarmed (the default), it only forwards to malloc/free.

#include "support/allocation_fuse.hpp"

#include <atomic>
#include <cstdlib>
#include <new>

namespace {

std::atomic<std::size_t> armedLimit{0};  // 0: disarmed
std::atomic<std::size_t> largestRequest{0};
std::atomic<bool> fuseBlown{false};

void* allocate(std::size_t size) {
    const std::size_t limit = armedLimit.load(std::memory_order_relaxed);
    if (limit != 0) {
        std::size_t seen = largestRequest.load(std::memory_order_relaxed);
        while (size > seen && !largestRequest.compare_exchange_weak(seen, size, std::memory_order_relaxed)) {
        }
        if (size > limit) {
            fuseBlown.store(true, std::memory_order_relaxed);
            throw std::bad_alloc();
        }
    }
    void* p = std::malloc(size == 0 ? 1 : size);
    if (p == nullptr) {
        throw std::bad_alloc();
    }
    return p;
}

}  // namespace

namespace siann::media::testing {

AllocationFuse::AllocationFuse(std::size_t limitBytes) {
    largestRequest.store(0, std::memory_order_relaxed);
    fuseBlown.store(false, std::memory_order_relaxed);
    armedLimit.store(limitBytes == 0 ? 1 : limitBytes, std::memory_order_relaxed);
}

AllocationFuse::~AllocationFuse() {
    armedLimit.store(0, std::memory_order_relaxed);
}

std::size_t AllocationFuse::largest() const noexcept {
    return largestRequest.load(std::memory_order_relaxed);
}

bool AllocationFuse::blown() const noexcept {
    return fuseBlown.load(std::memory_order_relaxed);
}

}  // namespace siann::media::testing

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
    std::free(p);
}
void operator delete[](void* p) noexcept {
    std::free(p);
}
void operator delete(void* p, std::size_t) noexcept {
    std::free(p);
}
void operator delete[](void* p, std::size_t) noexcept {
    std::free(p);
}
void operator delete(void* p, const std::nothrow_t&) noexcept {
    std::free(p);
}
void operator delete[](void* p, const std::nothrow_t&) noexcept {
    std::free(p);
}
