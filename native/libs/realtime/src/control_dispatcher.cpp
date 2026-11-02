#include "siann/realtime/control_dispatcher.hpp"

#include <vector>

namespace siann::realtime {

void ControlDispatcher::setParameter(const ParamKey& key, double value, int rampFrames) {
    std::lock_guard lock(mutex_);
    pending_[key] = Pending{value, rampFrames};
}

void ControlDispatcher::beginGesture(const ParamKey& key) {
    std::lock_guard lock(mutex_);
    gestures_[key] = Gesture{};
}

void ControlDispatcher::updateGesture(const ParamKey& key, double value, int rampFrames) {
    std::lock_guard lock(mutex_);
    auto it = gestures_.find(key);
    if (it == gestures_.end()) {
        it = gestures_.emplace(key, Gesture{}).first;  // an update implies a gesture
    }
    it->second.value = value;
    pending_[key] = Pending{value, rampFrames};
}

std::optional<double> ControlDispatcher::endGesture(const ParamKey& key) {
    std::lock_guard lock(mutex_);
    const auto it = gestures_.find(key);
    if (it == gestures_.end()) {
        return std::nullopt;
    }
    const std::optional<double> value = it->second.value;
    gestures_.erase(it);
    return value;
}

void ControlDispatcher::graphPublished(std::uint64_t epoch, std::map<std::string, graph::NodeId> slots,
                                       std::map<std::string, graph::NodeId> meterSlots) {
    std::lock_guard lock(mutex_);
    epoch_ = epoch;
    slots_ = std::move(slots);
    meterEntities_.clear();
    for (auto& [entity, slot] : meterSlots) {
        meterEntities_[slot] = entity;
    }
    meters_.clear();  // slots of the old graph mean nothing in the new one
    // The new graph was compiled from the document, which does not contain
    // values held by open gestures: re-send them with the new epoch.
    for (const auto& [key, gesture] : gestures_) {
        if (gesture.value) {
            pending_[key] = Pending{*gesture.value, 0};
        }
    }
}

std::size_t ControlDispatcher::tick() {
    std::vector<std::pair<ParamKey, ParamChange>> batch;
    {
        std::lock_guard lock(mutex_);
        // Latest value wins: the driver hands over the newest metered block
        // (superseded blocks never arrive). Samples of an older graph are
        // dropped.
        MeterSample sample;
        while (driver_.popMeter(sample)) {
            if (sample.epoch != epoch_) {
                continue;
            }
            const auto entity = meterEntities_.find(sample.slot);
            if (entity == meterEntities_.end()) {
                continue;
            }
            meters_.insert_or_assign(entity->second, sample);
            meterPlayhead_ = sample.blockStart;  // in arrival order, so a locate back shows
        }
        for (auto it = pending_.begin(); it != pending_.end();) {
            const auto slot = slots_.find(it->first.entity);
            if (slot == slots_.end()) {
                ++it;  // not addressable in this graph yet; keep it
                continue;
            }
            batch.push_back({it->first, ParamChange{epoch_, slot->second, it->first.paramId, it->second.value,
                                                    it->second.rampFrames}});
            it = pending_.erase(it);
        }
    }
    std::size_t pushed = 0;
    std::vector<std::pair<ParamKey, ParamChange>> unsent;
    for (const auto& [key, change] : batch) {
        if (driver_.pushParam(change)) {
            ++pushed;
        } else {
            unsent.push_back({key, change});
        }
    }
    if (!unsent.empty()) {
        std::lock_guard lock(mutex_);
        for (const auto& [key, change] : unsent) {
            // A newer value may have arrived meanwhile; it wins.
            pending_.try_emplace(key, Pending{change.value, change.rampFrames});
        }
    }
    return pushed;
}

std::size_t ControlDispatcher::pendingCount() const {
    std::lock_guard lock(mutex_);
    return pending_.size();
}

bool ControlDispatcher::gestureOpen(const ParamKey& key) const {
    std::lock_guard lock(mutex_);
    return gestures_.count(key) != 0;
}

std::optional<MeterSample> ControlDispatcher::meter(const std::string& entity) const {
    std::lock_guard lock(mutex_);
    const auto it = meters_.find(entity);
    if (it == meters_.end()) {
        return std::nullopt;
    }
    return it->second;
}

std::int64_t ControlDispatcher::meterPlayhead() const {
    std::lock_guard lock(mutex_);
    return meterPlayhead_;
}

}  // namespace siann::realtime
