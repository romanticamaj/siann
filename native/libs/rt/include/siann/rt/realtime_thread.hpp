#pragma once

// Marks the current thread as realtime (architecture spec, "Realtime rules and
// enforcement"). Test executables that link `siann_rt_alloc_guard` replace the
// global operator new and delete; any allocation or free on a marked thread is
// counted as a violation, so tests can prove the audio path does not allocate.
//
// In a Clang RealtimeSanitizer build (SIANN_RTSAN=ON, -fsanitize=realtime) the
// scope is also the sanitizer's realtime context: any allocation, lock, sleep
// or blocking system call inside it is reported. Every audio callback runs in
// this scope (the devices open it around the callback), so the graph driver
// and everything it calls are covered.

#include <cstdint>

namespace siann::rt {

bool isRealtimeThread() noexcept;

// True when this build runs under RealtimeSanitizer.
bool realtimeSanitizerActive() noexcept;

class ScopedRealtimeThread {
public:
    ScopedRealtimeThread() noexcept;
    ~ScopedRealtimeThread();
    ScopedRealtimeThread(const ScopedRealtimeThread&) = delete;
    ScopedRealtimeThread& operator=(const ScopedRealtimeThread&) = delete;

private:
    bool previous_;
};

// Suspends RealtimeSanitizer reports on this thread for its lifetime; a no-op
// in other builds. The thread stays marked realtime, so the allocation guard
// still counts. Only for tests that break the rules on purpose (for example
// the allocation guard's own self-test); never in production code. Every use
// must state its reason in a comment next to it.
class ScopedRealtimeSanitizerDisabler {
public:
    ScopedRealtimeSanitizerDisabler() noexcept;
    ~ScopedRealtimeSanitizerDisabler();
    ScopedRealtimeSanitizerDisabler(const ScopedRealtimeSanitizerDisabler&) = delete;
    ScopedRealtimeSanitizerDisabler& operator=(const ScopedRealtimeSanitizerDisabler&) = delete;
};

// Allocations and frees seen on realtime threads. Always 0 unless the
// allocation guard is linked.
std::uint64_t allocationViolations() noexcept;

namespace detail {
void recordAllocationViolation() noexcept;
}

}  // namespace siann::rt
