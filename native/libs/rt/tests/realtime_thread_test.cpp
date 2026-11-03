#include <catch2/catch_test_macros.hpp>

#include "siann/rt/realtime_thread.hpp"

using siann::rt::isRealtimeThread;
using siann::rt::realtimeSanitizerActive;
using siann::rt::ScopedRealtimeSanitizerDisabler;
using siann::rt::ScopedRealtimeThread;

#ifndef SIANN_TEST_EXPECT_RTSAN
#error "the rt test target must define SIANN_TEST_EXPECT_RTSAN from the SIANN_RTSAN option"
#endif

TEST_CASE("The RealtimeSanitizer hook follows the SIANN_RTSAN build option", "[rt][rtsan]") {
    // An RTSan build whose scope does not reach the sanitizer would pass
    // every realtime test without checking anything.
    CHECK(realtimeSanitizerActive() == (SIANN_TEST_EXPECT_RTSAN != 0));
}

TEST_CASE("Realtime scopes nest and restore the previous state", "[rt][rtsan]") {
    CHECK_FALSE(isRealtimeThread());
    bool inner = false;
    bool outerAfterInner = false;
    bool insideDisabler = false;
    {
        const ScopedRealtimeThread outer;
        {
            const ScopedRealtimeThread nested;
            inner = isRealtimeThread();
        }
        outerAfterInner = isRealtimeThread();
        {
            // Reason: checks that the disabler leaves the thread marked.
            const ScopedRealtimeSanitizerDisabler allowed;
            insideDisabler = isRealtimeThread();
        }
    }
    CHECK(inner);
    CHECK(outerAfterInner);
    CHECK(insideDisabler);  // the allocation guard still counts under the disabler
    CHECK_FALSE(isRealtimeThread());
}
