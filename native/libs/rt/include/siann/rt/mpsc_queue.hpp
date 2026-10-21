#pragma once

// Bounded multi-producer single-consumer queue (Dmitry Vyukov's bounded MPMC
// algorithm, used with one consumer). Producers on any thread, including
// plugin callbacks of unknown origin, never block, allocate or throw: push
// returns false when full. Used for `pluginEventAny`.

#include <atomic>
#include <cstddef>
#include <memory>
#include <type_traits>
#include <utility>

#include "siann/rt/spsc_queue.hpp"

namespace siann::rt {

#if defined(_MSC_VER)
#pragma warning(push)
#pragma warning(disable : 4324)  // padding from alignas is the point
#endif
template <typename T>
class MpscQueue {
    static_assert(std::is_nothrow_move_assignable_v<T>, "queue items must be nothrow move-assignable");
    static_assert(std::is_nothrow_default_constructible_v<T>, "queue items must be nothrow default-constructible");

public:
    explicit MpscQueue(std::size_t capacity) : mask_(roundUp(capacity) - 1), cells_(new Cell[mask_ + 1]) {
        for (std::size_t i = 0; i <= mask_; ++i) {
            cells_[i].sequence.store(i, std::memory_order_relaxed);
        }
    }

    MpscQueue(const MpscQueue&) = delete;
    MpscQueue& operator=(const MpscQueue&) = delete;

    std::size_t capacity() const noexcept { return mask_ + 1; }

    // Any thread. Returns false when full.
    bool push(T item) noexcept {
        std::size_t pos = enqueue_.load(std::memory_order_relaxed);
        for (;;) {
            Cell& cell = cells_[pos & mask_];
            const std::size_t seq = cell.sequence.load(std::memory_order_acquire);
            const auto diff = static_cast<std::ptrdiff_t>(seq) - static_cast<std::ptrdiff_t>(pos);
            if (diff == 0) {
                if (enqueue_.compare_exchange_weak(pos, pos + 1, std::memory_order_relaxed)) {
                    cell.value = std::move(item);
                    cell.sequence.store(pos + 1, std::memory_order_release);
                    return true;
                }
            } else if (diff < 0) {
                return false;  // full
            } else {
                pos = enqueue_.load(std::memory_order_relaxed);
            }
        }
    }

    // The single consumer. Returns false when empty.
    bool pop(T& out) noexcept {
        Cell& cell = cells_[dequeue_ & mask_];
        const std::size_t seq = cell.sequence.load(std::memory_order_acquire);
        if (static_cast<std::ptrdiff_t>(seq) - static_cast<std::ptrdiff_t>(dequeue_ + 1) < 0) {
            return false;  // empty, or a producer has claimed the cell but not finished writing
        }
        out = std::move(cell.value);
        cell.sequence.store(dequeue_ + mask_ + 1, std::memory_order_release);
        ++dequeue_;
        return true;
    }

private:
    struct Cell {
        std::atomic<std::size_t> sequence{0};
        T value{};
    };

    static std::size_t roundUp(std::size_t n) {
        std::size_t c = 1;
        while (c < n) {
            c <<= 1;
        }
        return c < 2 ? 2 : c;
    }

    const std::size_t mask_;
    const std::unique_ptr<Cell[]> cells_;
    alignas(kCacheLine) std::atomic<std::size_t> enqueue_{0};
    alignas(kCacheLine) std::size_t dequeue_ = 0;
};
#if defined(_MSC_VER)
#pragma warning(pop)
#endif

}  // namespace siann::rt
