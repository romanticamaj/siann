#pragma once

// Marks the current thread as realtime (architecture spec, "Realtime rules and
// enforcement"). Test executables that link `siann_rt_alloc_guard` replace the
// global operator new and delete; any allocation or free on a marked thread is
// counted as a violation, so tests can prove the audio path does not allocate.

#include <cstdint>

namespace siann::rt {

bool isRealtimeThread() noexcept;

class ScopedRealtimeThread {
public:
    ScopedRealtimeThread() noexcept;
    ~ScopedRealtimeThread();
    ScopedRealtimeThread(const ScopedRealtimeThread&) = delete;
    ScopedRealtimeThread& operator=(const ScopedRealtimeThread&) = delete;

private:
    bool previous_;
};

// Allocations and frees seen on realtime threads. Always 0 unless the
// allocation guard is linked.
std::uint64_t allocationViolations() noexcept;

namespace detail {
void recordAllocationViolation() noexcept;
}

}  // namespace siann::rt
