#include "siann/rt/realtime_thread.hpp"

#include <atomic>

#if defined(__has_feature)
#if __has_feature(realtime_sanitizer)
#define SIANN_HAS_RTSAN 1
#endif
#endif

#ifdef SIANN_HAS_RTSAN
// The RealtimeSanitizer runtime interface (compiler-rt, LLVM 20). Enter and
// exit are what Clang emits around a [[clang::nonblocking]] function; calling
// them from the scope ties the sanitizer's realtime context to
// ScopedRealtimeThread without the attribute, whose function-effect analysis
// would flag every unannotated callee (architecture spec, "Realtime rules and
// enforcement"). The calls nest: the runtime keeps a depth per thread.
extern "C" {
void __rtsan_realtime_enter();
void __rtsan_realtime_exit();
void __rtsan_disable();
void __rtsan_enable();
}
#endif

namespace siann::rt {

namespace {
thread_local bool tRealtime = false;
std::atomic<std::uint64_t> gViolations{0};
}  // namespace

bool isRealtimeThread() noexcept {
    return tRealtime;
}

bool realtimeSanitizerActive() noexcept {
#ifdef SIANN_HAS_RTSAN
    return true;
#else
    return false;
#endif
}

ScopedRealtimeThread::ScopedRealtimeThread() noexcept : previous_(tRealtime) {
    tRealtime = true;
#ifdef SIANN_HAS_RTSAN
    __rtsan_realtime_enter();
#endif
}

ScopedRealtimeThread::~ScopedRealtimeThread() {
#ifdef SIANN_HAS_RTSAN
    __rtsan_realtime_exit();
#endif
    tRealtime = previous_;
}

ScopedRealtimeSanitizerDisabler::ScopedRealtimeSanitizerDisabler() noexcept {
#ifdef SIANN_HAS_RTSAN
    __rtsan_disable();
#endif
}

ScopedRealtimeSanitizerDisabler::~ScopedRealtimeSanitizerDisabler() {
#ifdef SIANN_HAS_RTSAN
    __rtsan_enable();
#endif
}

std::uint64_t allocationViolations() noexcept {
    return gViolations.load(std::memory_order_relaxed);
}

namespace detail {
void recordAllocationViolation() noexcept {
    gViolations.fetch_add(1, std::memory_order_relaxed);
}
}  // namespace detail

}  // namespace siann::rt
