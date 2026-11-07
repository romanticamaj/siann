#include "siann/host/fake_callback_clock.hpp"

#include <atomic>

namespace siann::host {

namespace {

std::atomic<std::int64_t> clockStep{0};
std::atomic<std::int64_t> clockNow{0};

}  // namespace

void setFakeCallbackNanos(std::int64_t nanos) noexcept {
    clockStep.store(nanos, std::memory_order_relaxed);
    clockNow.store(0, std::memory_order_relaxed);
}

std::int64_t fakeCallbackClock() noexcept {
    const std::int64_t step = clockStep.load(std::memory_order_relaxed);
    return clockNow.fetch_add(step, std::memory_order_relaxed) + step;
}

}  // namespace siann::host
