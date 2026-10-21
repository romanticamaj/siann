#include "siann/rt/realtime_thread.hpp"

#include <atomic>

namespace siann::rt {

namespace {
thread_local bool tRealtime = false;
std::atomic<std::uint64_t> gViolations{0};
}  // namespace

bool isRealtimeThread() noexcept {
    return tRealtime;
}

ScopedRealtimeThread::ScopedRealtimeThread() noexcept : previous_(tRealtime) {
    tRealtime = true;
}

ScopedRealtimeThread::~ScopedRealtimeThread() {
    tRealtime = previous_;
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
