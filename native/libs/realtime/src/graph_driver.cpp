#include "siann/realtime/graph_driver.hpp"

#include <algorithm>
#include <stdexcept>

#include "siann/realtime/recorder.hpp"

namespace siann::realtime {

GraphDriver::GraphDriver(Options options) : options_(options) {
    if (options_.fadeFrames <= 0) {
        throw std::invalid_argument("fadeFrames must be positive");
    }
}

GraphDriver::~GraphDriver() {
    if (state_ == DriverState::realtime) {
        stop();
    }
}

std::uint64_t GraphDriver::publish(std::unique_ptr<graph::PreparedGraph> graph) {
    if (!graph) {
        throw std::invalid_argument("cannot publish a null graph");
    }
    const std::uint64_t epoch = nextEpoch_++;
    owned_.emplace(epoch, std::move(graph));
    if (state_ == DriverState::stopped) {
        installDirectly(epoch);
    } else if (inFlight_ || state_ != DriverState::realtime) {
        if (waiting_) {
            retire(*waiting_);  // superseded before it was ever sent
        }
        waiting_ = epoch;
    } else {
        send(epoch);
    }
    return epoch;
}

void GraphDriver::start(host::AudioDevice& device, const host::AudioDeviceConfig& config) {
    if (state_ != DriverState::stopped) {
        throw std::logic_error("the graph driver is already running");
    }
    deviceStatus_ = device.open(config);
    deviceLost_.store(false, std::memory_order_release);
    device.setOnStopped([this](bool) { deviceLost_.store(true, std::memory_order_release); });
    device_ = &device;
    state_ = DriverState::realtime;
    // The live graph is already in current_; starting the device thread
    // publishes it to the callback.
    device.start([this](const host::AudioBufferView& in, const host::AudioBufferView& out) { process(in, out); });
}

void GraphDriver::attachRecorder(Recorder* recorder) {
    if (state_ != DriverState::stopped) {
        throw std::logic_error("attach a recorder while the driver is stopped");
    }
    recorder_ = recorder;
}

void GraphDriver::stop() {
    if (state_ != DriverState::realtime) {
        return;
    }
    state_ = DriverState::stopping;
    device_->stop();  // returns after the callback has exited
    finishStop();
}

void GraphDriver::poll() {
    if (state_ == DriverState::stopped) {
        drainParams();  // nobody else drives the graph; apply changes here
        TransportCommand command;
        while (transportInbox_.pop(command)) {
            applyLocate(command);
        }
        return;
    }
    if (state_ != DriverState::realtime) {
        return;
    }
    if (deviceLost_.load(std::memory_order_acquire)) {
        stop();
        return;
    }
    drainRetired();
    if (inFlight_ && std::chrono::steady_clock::now() - sentAt_ > options_.ackTimeout) {
        ++watchdogTrips_;
        stop();
    }
}

bool GraphDriver::pushParam(const ParamChange& change) noexcept {
    return paramInbox_.push(change);
}

bool GraphDriver::pushLocate(const TransportCommand& command) noexcept {
    return transportInbox_.push(command);
}

void GraphDriver::applyLocate(const TransportCommand& command) noexcept {
    playhead_.store(command.position, std::memory_order_release);
    if (current_ != nullptr) {
        current_->locate(command.generation, command.position);
    }
}

void GraphDriver::send(std::uint64_t epoch) {
    if (!graphInbox_.push(Handoff{owned_.at(epoch).get(), epoch})) {
        throw std::logic_error("graphInbox full with no transition in flight");
    }
    inFlight_ = epoch;
    sentAt_ = std::chrono::steady_clock::now();
}

void GraphDriver::installDirectly(std::uint64_t epoch) {
    const std::uint64_t old = liveEpoch_;
    current_ = owned_.at(epoch).get();
    currentEpoch_ = epoch;
    liveEpoch_ = epoch;
    riseRemaining_ = options_.fadeFrames;
    if (old != 0 && old != epoch) {
        retire(old);
    }
}

void GraphDriver::retire(std::uint64_t epoch) {
    owned_.erase(epoch);
}

void GraphDriver::drainRetired() {
    Handoff h;
    while (retireOutbox_.pop(h)) {
        if (h.epoch != 0) {
            retire(h.epoch);
        }
        if (inFlight_) {
            liveEpoch_ = *inFlight_;
            inFlight_.reset();
        }
    }
    if (!inFlight_ && waiting_) {
        const std::uint64_t epoch = *waiting_;
        waiting_.reset();
        send(epoch);
    }
}

void GraphDriver::finishStop() {
    // The callback has exited: the audio-side fields are ours again.
    Handoff h;
    while (graphInbox_.pop(h)) {
        next_ = h;  // a graph sent but never picked up
    }
    if (next_.graph != nullptr) {
        if (current_ != nullptr && currentEpoch_ != next_.epoch) {
            retire(currentEpoch_);
        }
        current_ = next_.graph;
        currentEpoch_ = next_.epoch;
        next_ = {};
    }
    duckActive_ = false;
    duckRemaining_ = 0;
    if (locatePending_) {
        applyLocate(pendingLocate_);
        locatePending_ = false;
    }
    if (retirePending_ && unsentRetire_.epoch != 0) {
        retire(unsentRetire_.epoch);
    }
    unsentRetire_ = {};
    retirePending_ = false;
    while (retireOutbox_.pop(h)) {
        if (h.epoch != 0) {
            retire(h.epoch);
        }
    }
    liveEpoch_ = currentEpoch_;
    inFlight_.reset();
    state_ = DriverState::stopped;
    device_ = nullptr;
    if (waiting_) {
        const std::uint64_t epoch = *waiting_;
        waiting_.reset();
        installDirectly(epoch);
    }
}

// ---- audio thread ----------------------------------------------------------

void GraphDriver::process(const host::AudioBufferView& input, const host::AudioBufferView& output) noexcept {
    if (recorder_ != nullptr) {
        // The input block lines up with the output block rendered from the
        // current playhead in this same callback.
        recorder_->capture(input, playhead_.load(std::memory_order_relaxed), playing_.load(std::memory_order_acquire));
    }
    if (retirePending_ && retireOutbox_.push(unsentRetire_)) {
        retirePending_ = false;
    }
    if (!duckActive_) {
        Handoff h;
        if (graphInbox_.pop(h)) {
            if (current_ == nullptr) {
                current_ = h.graph;
                currentEpoch_ = h.epoch;
                riseRemaining_ = options_.fadeFrames;
                if (!retireOutbox_.push(Handoff{nullptr, 0})) {  // acknowledge: nothing retired
                    unsentRetire_ = Handoff{nullptr, 0};
                    retirePending_ = true;
                }
            } else {
                next_ = h;
                duckActive_ = true;
                duckRemaining_ = options_.fadeFrames;
            }
        }
    }
    if (!duckActive_ && !locatePending_) {
        TransportCommand command;
        if (transportInbox_.pop(command)) {
            if (current_ == nullptr || !playing_.load(std::memory_order_acquire)) {
                applyLocate(command);  // nothing audible to fade
            } else {
                pendingLocate_ = command;
                locatePending_ = true;
                duckActive_ = true;
                duckRemaining_ = options_.fadeFrames;
            }
        }
    }

    drainParams();

    const int chunk = current_ != nullptr ? current_->maxBlockFrames() : output.frames;
    for (int offset = 0; offset < output.frames; offset += chunk) {
        renderBlock(output, offset, std::min(chunk, output.frames - offset));
    }

    if (duckActive_ && duckRemaining_ == 0) {
        if (next_.graph != nullptr) {
            const Handoff old{current_, currentEpoch_};
            current_ = next_.graph;
            currentEpoch_ = next_.epoch;
            next_ = {};
            if (!retireOutbox_.push(old)) {
                unsentRetire_ = old;
                retirePending_ = true;
            }
        } else if (locatePending_) {
            applyLocate(pendingLocate_);
            locatePending_ = false;
        }
        duckActive_ = false;
        riseRemaining_ = options_.fadeFrames;
    }
}

void GraphDriver::drainParams() noexcept {
    // Older epochs are dropped, the current epoch applies, and the first change
    // for a newer epoch waits until that graph has been swapped in.
    for (;;) {
        ParamChange change;
        if (paramHeld_) {
            change = heldParam_;
        } else if (!paramInbox_.pop(change)) {
            return;
        }
        if (change.epoch > currentEpoch_) {
            heldParam_ = change;
            paramHeld_ = true;
            return;
        }
        paramHeld_ = false;
        if (change.epoch == currentEpoch_ && current_ != nullptr) {
            current_->setParameter(change.slot, change.paramId, change.value, change.rampFrames);
        }
    }
}

void GraphDriver::renderBlock(const host::AudioBufferView& output, int offset, int frames) noexcept {
    const bool playing = playing_.load(std::memory_order_acquire);
    const std::int64_t position = playhead_.load(std::memory_order_relaxed);
    const host::AudioBufferView* source = nullptr;
    if (current_ != nullptr && playing) {
        current_->process(graph::ProcessContext{position, frames});
        source = &current_->output();
        playhead_.store(position + frames, std::memory_order_release);
    }
    const float fade = static_cast<float>(options_.fadeFrames);
    for (int i = 0; i < frames; ++i) {
        float gain = 1.0f;
        if (duckActive_) {
            gain = duckRemaining_ > 0 ? static_cast<float>(duckRemaining_) / fade : 0.0f;
            if (duckRemaining_ > 0) {
                --duckRemaining_;
            }
        } else if (riseRemaining_ > 0) {
            gain = 1.0f - static_cast<float>(riseRemaining_) / fade;
            --riseRemaining_;
        }
        for (int c = 0; c < output.channelCount; ++c) {
            float v = 0.0f;
            if (source != nullptr && c < source->channelCount) {
                v = source->channel(c)[i] * gain;
            }
            output.channel(c)[offset + i] = v;
        }
    }
}

}  // namespace siann::realtime
