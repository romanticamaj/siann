#include "siann/realtime/transport.hpp"

#include <stdexcept>

namespace siann::realtime {

Transport::Transport(GraphDriver& driver, Butler& butler, Options options)
    : driver_(driver), butler_(butler), options_(options) {
    if (options_.readyTimeout.count() < 0) {
        throw std::invalid_argument("readyTimeout must not be negative");
    }
}

void Transport::locate(std::int64_t target) {
    std::lock_guard lock(mutex_);
    const bool play = pending_ && pending_->play;
    pending_ = Pending{++generation_, target, play, std::nullopt};
    butler_.seek(generation_, target);
}

void Transport::play() {
    std::lock_guard lock(mutex_);
    if (playingLocked()) {
        return;
    }
    if (pending_) {
        pending_->play = true;  // the pending locate carries the start
        return;
    }
    pending_ = Pending{++generation_, positionLocked(), true, std::nullopt};
    butler_.seek(generation_, pending_->target);
}

void Transport::stop() {
    std::lock_guard lock(mutex_);
    if (pending_) {
        pending_->play = false;  // still a locate, no longer a start
    }
    if (sent_) {
        sent_->play = false;
    }
    driver_.pause(sent_ ? sent_->generation : 0);
}

std::size_t Transport::tick(std::chrono::steady_clock::time_point now) {
    std::lock_guard lock(mutex_);
    if (!pending_) {
        return 0;
    }
    if (!pending_->seenAt) {
        pending_->seenAt = now;
    }
    const bool ready = butler_.ready(pending_->generation);
    const bool late = !ready && now - *pending_->seenAt >= options_.readyTimeout;
    if (!ready && !late) {
        return 0;
    }
    if (!driver_.pushLocate(TransportCommand{pending_->generation, pending_->target, pending_->play})) {
        return 0;  // transportInbox full: retry on the next tick
    }
    if (late) {
        ++lateLocates_;
    }
    sent_ = Sent{pending_->generation, pending_->target, pending_->play};
    pending_.reset();
    return 1;
}

bool Transport::sentUnapplied() const noexcept {
    return sent_ && driver_.appliedLocate() < sent_->generation;
}

bool Transport::playingLocked() const noexcept {
    return driver_.playing() || (pending_ && pending_->play) || (sentUnapplied() && sent_->play);
}

std::int64_t Transport::positionLocked() const noexcept {
    if (pending_) {
        return pending_->target;
    }
    if (sentUnapplied()) {
        return sent_->target;
    }
    return driver_.playhead();
}

bool Transport::playing() const {
    std::lock_guard lock(mutex_);
    return playingLocked();
}

std::int64_t Transport::position() const {
    std::lock_guard lock(mutex_);
    return positionLocked();
}

std::uint64_t Transport::generation() const {
    std::lock_guard lock(mutex_);
    return generation_;
}

bool Transport::pendingLocate() const {
    std::lock_guard lock(mutex_);
    return pending_.has_value();
}

std::uint64_t Transport::lateLocates() const {
    std::lock_guard lock(mutex_);
    return lateLocates_;
}

Transport::Status Transport::status() const {
    std::lock_guard lock(mutex_);
    return Status{playingLocked(), positionLocked(), generation_, pending_.has_value(), lateLocates_,
                  butler_.underruns()};
}

}  // namespace siann::realtime
