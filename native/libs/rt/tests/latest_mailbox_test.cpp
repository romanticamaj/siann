#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <cstdint>
#include <thread>

#include "siann/rt/latest_mailbox.hpp"
#include "siann/rt/realtime_thread.hpp"

using siann::rt::LatestMailbox;
using siann::rt::ScopedRealtimeThread;
using siann::rt::allocationViolations;

TEST_CASE("Latest mailbox: the newest value wins and superseded ones are reported", "[rt][mailbox]") {
    LatestMailbox<int> box(-1);
    CHECK_FALSE(box.take());
    CHECK(box.front() == -1);

    box.back() = 1;
    CHECK_FALSE(box.publish());  // nothing unread was replaced
    CHECK(box.take());
    CHECK(box.front() == 1);
    CHECK_FALSE(box.take());  // read once
    CHECK(box.front() == 1);

    // The consumer stalls: every value but the last is superseded.
    int superseded = 0;
    for (int i = 2; i <= 1'000; ++i) {
        box.back() = i;
        if (box.publish()) {
            CHECK(box.back() == i - 1);  // the superseded value, still readable
            ++superseded;
        }
    }
    CHECK(superseded == 998);
    CHECK(box.take());
    CHECK(box.front() == 1'000);
    CHECK_FALSE(box.take());
}

TEST_CASE("Latest mailbox across two threads never goes back and ends on the last value", "[rt][mailbox]") {
    constexpr std::uint64_t kValues = 1'000'000;
    LatestMailbox<std::uint64_t> box(0);
    std::atomic<bool> done{false};
    std::uint64_t backwards = 0;
    std::uint64_t taken = 0;
    std::thread consumer([&] {
        std::uint64_t last = 0;
        for (;;) {
            const bool finished = done.load(std::memory_order_acquire);
            if (box.take()) {
                if (box.front() <= last) {
                    ++backwards;
                }
                last = box.front();
                ++taken;
            } else if (finished) {
                break;
            }
        }
    });
    std::uint64_t superseded = 0;
    {
        const ScopedRealtimeThread realtime;
        for (std::uint64_t i = 1; i <= kValues; ++i) {
            box.back() = i;
            superseded += box.publish() ? 1 : 0;
        }
    }
    done.store(true, std::memory_order_release);
    consumer.join();
    CHECK(backwards == 0);
    CHECK(box.front() == kValues);
    CHECK(taken + superseded == kValues);  // every value was either read or reported superseded
}

TEST_CASE("Latest mailbox operations do not allocate on a realtime thread", "[rt][alloc]") {
    LatestMailbox<std::uint64_t> box;
    const auto before = allocationViolations();
    {
        const ScopedRealtimeThread realtime;
        for (std::uint64_t i = 0; i < 1'000; ++i) {
            box.back() = i;
            box.publish();
            box.take();
        }
    }
    CHECK(allocationViolations() == before);
}
