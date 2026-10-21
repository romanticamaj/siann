#pragma once

// Bounded single-producer single-consumer queue (architecture spec, "Queues").
// All storage is allocated in the constructor; push and pop never allocate,
// lock or throw, so either side may be the realtime audio thread.
//
// Exactly one thread may call push and exactly one thread may call pop.

#include <atomic>
#include <cstddef>
#include <memory>
#include <new>
#include <type_traits>
#include <utility>

namespace siann::rt {

// A fixed 64 bytes: std::hardware_destructive_interference_size varies with
// compiler flags (GCC warns about using it in headers) and 64 fits every
// target platform.
inline constexpr std::size_t kCacheLine = 64;

#if defined(_MSC_VER)
#pragma warning(push)
#pragma warning(disable : 4324)  // padding from alignas is the point
#endif
template <typename T>
class SpscQueue {
public:
    // Holds at least `capacity` items (rounded up to a power of two).
    explicit SpscQueue(std::size_t capacity) : mask_(roundUp(capacity) - 1), slots_(new T[mask_ + 1]) {}

    SpscQueue(const SpscQueue&) = delete;
    SpscQueue& operator=(const SpscQueue&) = delete;

    std::size_t capacity() const noexcept { return mask_ + 1; }

    // Producer side. Returns false when full.
    bool push(T item) noexcept {
        checkItemType();
        const std::size_t tail = tail_.load(std::memory_order_relaxed);
        if (tail - headCache_ > mask_) {
            headCache_ = head_.load(std::memory_order_acquire);
            if (tail - headCache_ > mask_) {
                return false;
            }
        }
        slots_[tail & mask_] = std::move(item);
        tail_.store(tail + 1, std::memory_order_release);
        return true;
    }

    // Consumer side. Returns false when empty.
    bool pop(T& out) noexcept {
        const std::size_t head = head_.load(std::memory_order_relaxed);
        if (head == tailCache_) {
            tailCache_ = tail_.load(std::memory_order_acquire);
            if (head == tailCache_) {
                return false;
            }
        }
        out = std::move(slots_[head & mask_]);
        head_.store(head + 1, std::memory_order_release);
        return true;
    }

    // Approximate; exact only when both sides are idle.
    std::size_t sizeApprox() const noexcept {
        return tail_.load(std::memory_order_acquire) - head_.load(std::memory_order_acquire);
    }

private:
    // Checked where the queue is used rather than in the class body: GCC cannot
    // evaluate these traits for a type nested in a class still being defined.
    static constexpr void checkItemType() noexcept {
        static_assert(std::is_nothrow_move_assignable_v<T>, "queue items must be nothrow move-assignable");
        static_assert(std::is_nothrow_default_constructible_v<T>, "queue items must be nothrow default-constructible");
    }

    static std::size_t roundUp(std::size_t n) {
        std::size_t c = 1;
        while (c < n) {
            c <<= 1;
        }
        return c < 2 ? 2 : c;
    }

    const std::size_t mask_;
    const std::unique_ptr<T[]> slots_;
    alignas(kCacheLine) std::atomic<std::size_t> head_{0};  // written by the consumer
    std::size_t tailCache_ = 0;                             // consumer's copy of tail
    alignas(kCacheLine) std::atomic<std::size_t> tail_{0};  // written by the producer
    std::size_t headCache_ = 0;                             // producer's copy of head
};
#if defined(_MSC_VER)
#pragma warning(pop)
#endif

}  // namespace siann::rt
