#pragma once

// The graph driver (architecture spec, revision 3.1, "Graph ownership" and
// "Publishing and retiring graphs"). It decides who owns the live graph,
// publishes new graphs with duck-and-swap, keeps at most one structural
// transition in flight, and retires old graphs only after the audio thread
// acknowledges the swap.
//
// Control-side methods (publish, start, stop, poll and the transport calls)
// must be called from one non-realtime thread. process() runs on the audio
// thread inside the device callback and never allocates, locks or blocks.
//
// M2 step 1 ducks the whole output during a transition; ducking only the
// affected paths follows once the compiler reports them.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>

#include "siann/graph/graph.hpp"
#include "siann/host/interfaces.hpp"
#include "siann/rt/spsc_queue.hpp"

namespace siann::realtime {

enum class DriverState { stopped, realtime, offline, stopping };

namespace detail {
// A graph passed between the control side and the audio thread. Defined at
// namespace scope: GCC cannot evaluate the default member initializers of a
// class nested in a still-incomplete class for the queue's noexcept checks.
struct Handoff {
    graph::PreparedGraph* graph = nullptr;
    std::uint64_t epoch = 0;
};
}  // namespace detail

// One parameter change for the audio thread (revision 3.1, "Two channels into
// the audio thread"). `slot` is a node of the graph with `epoch`.
struct ParamChange {
    std::uint64_t epoch = 0;
    graph::NodeId slot = 0;
    std::uint32_t paramId = 0;
    double value = 0.0;
    int rampFrames = 0;
};

class GraphDriver {
public:
    struct Options {
        int fadeFrames = 240;  // 5 ms at 48 kHz
        std::chrono::milliseconds ackTimeout{500};
    };

    explicit GraphDriver(Options options);
    ~GraphDriver();
    GraphDriver(const GraphDriver&) = delete;
    GraphDriver& operator=(const GraphDriver&) = delete;

    // Control side. Takes ownership; returns the graph's epoch.
    std::uint64_t publish(std::unique_ptr<graph::PreparedGraph> graph);

    // Opens and starts the device. The live graph (if any) is handed over
    // before the device starts; device blocks larger than the graph's maximum
    // block size are processed in chunks.
    void start(host::AudioDevice& device, const host::AudioDeviceConfig& config);

    // Stops the device (blocking until its callback has exited), installs a
    // pending graph if one was still in the inbox, retires everything else.
    void stop();

    // Handles swap acknowledgements, device loss and the watchdog.
    void poll();

    // The control dispatcher's thread only (the single paramInbox producer).
    // Returns false when the queue is full. While stopped, queued changes are
    // applied to the live graph on the next poll(); the consumer moves between
    // the audio thread and the control side only across a device start or stop.
    bool pushParam(const ParamChange& change) noexcept;

    // Transport, applied at the next block. M2 step 1 uses atomics; the
    // dispatcher and paramInbox replace them.
    void play() noexcept { playing_.store(true, std::memory_order_release); }
    void pause() noexcept { playing_.store(false, std::memory_order_release); }
    std::int64_t playhead() const noexcept { return playhead_.load(std::memory_order_acquire); }

    DriverState state() const noexcept { return state_; }
    std::uint64_t liveEpoch() const noexcept { return liveEpoch_; }
    bool transitionInFlight() const noexcept { return inFlight_.has_value(); }
    std::size_t ownedGraphs() const noexcept { return owned_.size(); }
    std::uint64_t watchdogTrips() const noexcept { return watchdogTrips_; }

private:
    using Handoff = detail::Handoff;

    void process(const host::AudioBufferView& input, const host::AudioBufferView& output) noexcept;
    void renderBlock(const host::AudioBufferView& output, int offset, int frames) noexcept;
    void drainParams() noexcept;
    void send(std::uint64_t epoch);
    void installDirectly(std::uint64_t epoch);
    void retire(std::uint64_t epoch);
    void drainRetired();
    void finishStop();

    Options options_;
    DriverState state_ = DriverState::stopped;
    host::AudioDevice* device_ = nullptr;

    // Control side: every graph this driver owns, by epoch.
    std::map<std::uint64_t, std::unique_ptr<graph::PreparedGraph>> owned_;
    std::uint64_t nextEpoch_ = 1;
    std::uint64_t liveEpoch_ = 0;
    std::optional<std::uint64_t> inFlight_;
    std::optional<std::uint64_t> waiting_;  // newest graph published during a transition
    std::chrono::steady_clock::time_point sentAt_{};
    std::uint64_t watchdogTrips_ = 0;
    std::atomic<bool> deviceLost_{false};

    // Audio side.
    rt::SpscQueue<Handoff> graphInbox_{2};
    rt::SpscQueue<Handoff> retireOutbox_{2};
    rt::SpscQueue<ParamChange> paramInbox_{1024};
    ParamChange heldParam_{};
    bool paramHeld_ = false;  // heldParam_ waits for a newer graph to be swapped in
    graph::PreparedGraph* current_ = nullptr;
    std::uint64_t currentEpoch_ = 0;
    Handoff next_{};
    Handoff unsentRetire_{};
    bool retirePending_ = false;  // unsentRetire_ holds an acknowledgement to retry
    int duckRemaining_ = 0;
    int riseRemaining_ = 0;
    std::atomic<std::int64_t> playhead_{0};
    std::atomic<bool> playing_{false};
};

}  // namespace siann::realtime
