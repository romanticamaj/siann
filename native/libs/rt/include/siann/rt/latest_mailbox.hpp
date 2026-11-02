#pragma once

// Latest-value-wins single-producer single-consumer mailbox (architecture
// spec, "Queues": meterOutbox). A triple buffer: the producer fills its own
// buffer and publishes it, replacing any value the consumer has not taken;
// the consumer takes the newest published value. Neither side ever waits,
// allocates or throws, and the consumer never reads a value older than the
// newest one published before its take().
//
// Exactly one thread may call back() and publish(), and exactly one thread
// may call take() and front().

#include <array>
#include <atomic>

namespace siann::rt {

template <typename T>
class LatestMailbox {
public:
    // All three buffers start as copies of `initial`, so a T that owns
    // storage (sized by the caller) is allocated here and never on publish.
    explicit LatestMailbox(const T& initial = T{}) : buffers_{initial, initial, initial} {}

    LatestMailbox(const LatestMailbox&) = delete;
    LatestMailbox& operator=(const LatestMailbox&) = delete;

    // Producer side: the buffer to fill. It stays the producer's until publish().
    T& back() noexcept { return buffers_[back_]; }

    // Producer side: makes back() the newest value. Returns true when that
    // replaced a value the consumer never took; back() is then that
    // superseded value, still readable until it is refilled.
    bool publish() noexcept {
        const unsigned previous = middle_.exchange(back_ | kFresh, std::memory_order_acq_rel);
        back_ = previous & kIndex;
        return (previous & kFresh) != 0;
    }

    // Consumer side: takes the newest published value into front(). Returns
    // false when nothing was published since the last take.
    bool take() noexcept {
        if ((middle_.load(std::memory_order_relaxed) & kFresh) == 0) {
            return false;
        }
        front_ = middle_.exchange(front_, std::memory_order_acq_rel) & kIndex;
        return true;
    }

    // Consumer side: the value of the last successful take().
    const T& front() const noexcept { return buffers_[front_]; }

private:
    static constexpr unsigned kIndex = 0x3;
    static constexpr unsigned kFresh = 0x4;

    std::array<T, 3> buffers_;
    unsigned front_ = 0;              // consumer's buffer
    std::atomic<unsigned> middle_{1};  // the hand-over buffer, plus kFresh when unread
    unsigned back_ = 2;               // producer's buffer
};

}  // namespace siann::rt
