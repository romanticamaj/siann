#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <cstdint>
#include <thread>
#include <vector>

#include "siann/rt/mpsc_queue.hpp"
#include "siann/rt/realtime_thread.hpp"
#include "siann/rt/spsc_queue.hpp"

using siann::rt::MpscQueue;
using siann::rt::ScopedRealtimeThread;
using siann::rt::SpscQueue;
using siann::rt::allocationViolations;

TEST_CASE("SPSC queue: capacity, order, full and empty", "[rt][spsc]") {
    SpscQueue<int> q(3);
    CHECK(q.capacity() == 4);
    int out = 0;
    CHECK_FALSE(q.pop(out));
    for (int i = 0; i < 4; ++i) {
        CHECK(q.push(i));
    }
    CHECK_FALSE(q.push(99));
    for (int round = 0; round < 10; ++round) {  // wrap around many times
        CHECK(q.pop(out));
        CHECK(out == round);
        CHECK(q.push(round + 4));
    }
    CHECK(q.sizeApprox() == 4);
}

TEST_CASE("SPSC queue across two threads keeps every item in order", "[rt][spsc]") {
    constexpr std::uint64_t kItems = 2'000'000;
    SpscQueue<std::uint64_t> q(1'024);
    std::uint64_t mismatches = 0;
    std::uint64_t received = 0;
    std::thread consumer([&] {
        std::uint64_t expected = 0;
        std::uint64_t value = 0;
        while (expected < kItems) {
            if (q.pop(value)) {
                mismatches += value != expected ? 1u : 0u;
                ++expected;
            }
        }
        received = expected;
    });
    for (std::uint64_t i = 0; i < kItems;) {
        if (q.push(i)) {
            ++i;
        }
    }
    consumer.join();
    CHECK(received == kItems);
    CHECK(mismatches == 0);
}

TEST_CASE("MPSC queue: every producer's items arrive once and in producer order", "[rt][mpsc]") {
    constexpr int kProducers = 4;
    constexpr std::uint32_t kPerProducer = 200'000;
    MpscQueue<std::uint64_t> q(256);
    std::atomic<int> started{0};
    std::vector<std::thread> producers;
    for (int p = 0; p < kProducers; ++p) {
        producers.emplace_back([&, p] {
            started.fetch_add(1);
            for (std::uint32_t i = 0; i < kPerProducer;) {
                if (q.push((static_cast<std::uint64_t>(p) << 32) | i)) {
                    ++i;
                }
            }
        });
    }
    std::vector<std::uint32_t> next(kProducers, 0);
    std::uint64_t outOfOrder = 0;
    std::uint64_t total = 0;
    std::uint64_t value = 0;
    while (total < static_cast<std::uint64_t>(kProducers) * kPerProducer) {
        if (q.pop(value)) {
            const auto producer = static_cast<std::size_t>(value >> 32);
            const auto index = static_cast<std::uint32_t>(value & 0xFFFFFFFFu);
            outOfOrder += index != next[producer] ? 1u : 0u;
            next[producer] = index + 1;
            ++total;
        }
    }
    for (auto& t : producers) {
        t.join();
    }
    CHECK(outOfOrder == 0);
    for (int p = 0; p < kProducers; ++p) {
        CHECK(next[static_cast<std::size_t>(p)] == kPerProducer);
    }
}

TEST_CASE("MPSC queue reports full without blocking", "[rt][mpsc]") {
    MpscQueue<int> q(2);
    CHECK(q.push(1));
    CHECK(q.push(2));
    CHECK_FALSE(q.push(3));
    int out = 0;
    CHECK(q.pop(out));
    CHECK(out == 1);
    CHECK(q.push(3));
}

TEST_CASE("Queue operations do not allocate on a realtime thread", "[rt][alloc]") {
    SpscQueue<std::uint64_t> spsc(64);
    MpscQueue<std::uint64_t> mpsc(64);
    const auto before = allocationViolations();
    {
        const ScopedRealtimeThread realtime;
        std::uint64_t v = 0;
        for (std::uint64_t i = 0; i < 1'000; ++i) {
            spsc.push(i);
            spsc.pop(v);
            mpsc.push(i);
            mpsc.pop(v);
        }
    }
    CHECK(allocationViolations() == before);
}

TEST_CASE("The allocation guard counts allocations on realtime threads only", "[rt][alloc]") {
    const auto before = allocationViolations();
    {
        auto* p = new int(1);  // not a realtime thread: allowed
        delete p;
    }
    CHECK(allocationViolations() == before);
    {
        const ScopedRealtimeThread realtime;
        auto* p = new int(2);
        delete p;
    }
    CHECK(allocationViolations() == before + 2);  // one new, one delete
    CHECK_FALSE(siann::rt::isRealtimeThread());
}
