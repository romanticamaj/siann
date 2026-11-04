#pragma once

// Bounded multi-producer, single-consumer queue between the protocol threads
// and the command thread (spec "Queues": commandInbox). Not realtime: it uses
// a mutex. Producers never wait: a full inbox refuses the item and the caller
// answers queue_full.

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <mutex>
#include <utility>
#include <vector>

namespace siann::protocol::detail {

template <class T>
class RequestInbox {
public:
    explicit RequestInbox(std::size_t capacity) : capacity_(capacity == 0 ? 1 : capacity) {}

    // False when the inbox is full.
    bool tryPush(T item) {
        {
            std::lock_guard lock(mutex_);
            if (items_.size() >= capacity_) {
                return false;
            }
            items_.push_back(std::move(item));
        }
        changed_.notify_one();
        return true;
    }

    std::vector<T> drain() {
        std::lock_guard lock(mutex_);
        return take();
    }

    // Waits until an item arrives, wake() is called or the timeout expires.
    template <class Rep, class Period>
    std::vector<T> waitDrain(std::chrono::duration<Rep, Period> timeout) {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, timeout, [this] { return !items_.empty() || woken_; });
        woken_ = false;
        return take();
    }

    void wake() {
        {
            std::lock_guard lock(mutex_);
            woken_ = true;
        }
        changed_.notify_all();
    }

private:
    std::vector<T> take() {
        std::vector<T> out;
        out.reserve(items_.size());
        for (auto& item : items_) {
            out.push_back(std::move(item));
        }
        items_.clear();
        return out;
    }

    const std::size_t capacity_;
    std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<T> items_;
    bool woken_ = false;
};

}  // namespace siann::protocol::detail
