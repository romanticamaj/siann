#pragma once

// A clock for the graph driver's callback timing that advances a fixed step per
// reading, so a callback timed between two readings lasts exactly one step: a
// known deadline miss, or none, for `--fake-callback-nanos` and for tests. One
// run at a time per process.

#include <cstdint>

namespace siann::host {

// The deadline check multiplies the step by the device rate: 1000 s per
// callback is already absurd and stays far from overflow.
inline constexpr std::int64_t kMaxFakeCallbackNanos = 1'000'000'000'000;

// Sets the step and restarts the clock. Before the device starts.
void setFakeCallbackNanos(std::int64_t nanos) noexcept;

// For PlaybackOptions::callbackClock. Audio thread only, atomics only.
std::int64_t fakeCallbackClock() noexcept;

}  // namespace siann::host
