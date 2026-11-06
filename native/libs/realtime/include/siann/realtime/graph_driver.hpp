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
// Latency changes (spec, "Latency model" and "State migration"): poll()
// drains the live graph's realtime outbox and answers a change itself with
// PreparedGraph::recompile(), published like any other graph. The recompiled
// graph shares the node instances and unchanged delay lines, keeps every slot
// (parameter changes for the original epoch still apply to it), and the
// transition ramps only the affected edges: they duck to zero in the old
// graph, stay at zero after the swap until the rebuilt delay lines are full
// (settleFrames()), then rise. Unaffected paths are untouched.
//
// When the recompile arrives while a rise is still running (the start-up or
// post-locate rise of the whole output, or the hold and rise after an earlier
// recompile), the swap ducks the whole output instead, but the affected edges
// are still held after it: the recompiled graph's own plus those the earlier
// hold still covers (their delay lines may still be filling), for whichever
// lasts longer. A recompile that fails (compensation limit) is flagged by
// latencyFault() until a later one succeeds.
//
// Any other publish (a structural edit) ducks the whole output, as does a
// locate ("ducks the master around the jump").
//
// Device-side SRC (spec, "Device-side SRC (M2)"): when the device opens at a
// rate other than the session rate (AudioDeviceConfig::sampleRate), the graph
// keeps running at the session rate in fixed blocks. Each step renders one
// block into a FIFO that holds exactly one block between steps (primed with
// silence) and feeds the oldest block to the output resampler; the device
// callback is filled from the resampler's output, carried over between
// callbacks. The output resampler is fed its lookahead in silence at start,
// so the output path delays the session by exactly srcOutputLatencyFrames.
// Device input goes through an input resampler to the recorder. Because the
// playhead runs up to one block further ahead than that latency, captured
// input is stamped with the playhead-equivalent position (the timeline
// position the output path reached for the matching device sample plus the
// reported SRC latency), which keeps the record offset exact.

#include <atomic>
#include <cstddef>
#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/host/interfaces.hpp"
#include "siann/rt/callback_timer.hpp"
#include "siann/rt/latest_mailbox.hpp"
#include "siann/rt/spsc_queue.hpp"

namespace siann::realtime {
class Recorder;
}

namespace siann::realtime {

enum class DriverState { stopped, realtime, offline, stopping };

namespace detail {
// A graph passed between the control side and the audio thread. Defined at
// namespace scope: GCC cannot evaluate the default member initializers of a
// class nested in a still-incomplete class for the queue's noexcept checks.
struct Handoff {
    graph::PreparedGraph* graph = nullptr;
    std::uint64_t epoch = 0;
    // The epoch whose slots this graph keeps: its own, or for a latency
    // recompile the family of the graph it was recompiled from.
    std::uint64_t family = 0;
};

// The readings of every MeterNode for one block, in schedule order. `entries`
// is sized once on the control side; the audio thread fills its first `count`.
struct MeterFrame {
    struct Entry {
        graph::NodeId slot = 0;
        graph::MeterReading reading{};
    };
    std::uint64_t epoch = 0;
    std::int64_t blockStart = 0;
    int frames = 0;
    std::size_t count = 0;
    std::vector<Entry> entries;
};
}  // namespace detail

// A transport command for the audio thread (revision 3.1, "Locate"). The
// dispatcher sends a locate only after the butler is ready for its generation
// (or its timeout passed). `play` starts the transport at the same block
// boundary: play from stop is a locate to the current position with `play`.
struct TransportCommand {
    std::uint64_t generation = 0;
    std::int64_t position = 0;
    bool play = false;
};

// A node of the graph with `epoch` reported a new latency (pluginEventRt for
// built-in nodes). The driver answers with a recompile.
struct LatencyChange {
    std::uint64_t epoch = 0;
    graph::NodeId slot = 0;
    std::int64_t latency = 0;
};

// A latency change the driver could not compensate (spec, "Latency model":
// paths above the compensation limit are flagged, not silently misaligned).
// The recompile for `latency` on `slot` of the graph with `epoch` failed with
// a GraphError; that graph keeps playing with its old, now wrong compensation.
struct LatencyFault {
    std::uint64_t epoch = 0;
    graph::NodeId slot = 0;
    std::int64_t latency = 0;
    std::string code;  // GraphError::code(), e.g. compensation_limit
    std::string message;
};

// What the engine tells users and agents about device-side SRC.
struct ResamplingState {
    bool active = false;
    std::int64_t deviceRate = 0;
    std::int64_t sessionRate = 0;
    std::int64_t addedLatencyFrames = 0;  // session frames, output plus input SRC
};

// The latency model's inputs for the running (or last started) device, all in
// session frames (spec, "Latency model"). Device latencies are converted from
// the device rate, rounding to nearest.
struct LatencyReport {
    std::int64_t sessionRate = 0;
    std::int64_t deviceRate = 0;
    std::int64_t inputLatencyFrames = 0;
    std::int64_t outputLatencyFrames = 0;
    std::int64_t srcOutputLatencyFrames = 0;  // output resampler lookahead plus the primed FIFO block
    std::int64_t srcInputLatencyFrames = 0;   // input resampler lookahead
    std::int64_t monitoredPathLatencyFrames = 0;  // 0 in M2: the master path has no latency yet
    // A captured block stamped t lands at t - recordOffsetFrames.
    std::int64_t recordOffsetFrames = 0;
};

// One parameter change for the audio thread (revision 3.1, "Two channels into
// the audio thread"). `slot` is a node of the graph with `epoch`.
struct ParamChange {
    std::uint64_t epoch = 0;
    graph::NodeId slot = 0;
    std::uint32_t paramId = 0;
    double value = 0.0;
    int rampFrames = 0;
};

// One meter reading for the dispatcher (spec, "Queues": meterOutbox). `slot`
// is a MeterNode of the graph with `epoch`; the reading covers the `frames`
// frames from timeline position `blockStart`, measured inside the graph, so
// before the driver's duck and rise fades.
struct MeterSample {
    std::uint64_t epoch = 0;
    graph::NodeId slot = 0;
    std::int64_t blockStart = 0;
    int frames = 0;
    graph::MeterReading reading{};
};

class GraphDriver {
public:
    static constexpr std::size_t kDefaultMeterCapacity = 1024;

    struct Options {
        int fadeFrames = 240;  // 5 ms at 48 kHz
        std::chrono::milliseconds ackTimeout{500};
        // MeterNodes metered per block; readings of further ones are dropped
        // and counted.
        std::size_t meterCapacity = kDefaultMeterCapacity;
        // Called on the control side (inside publish, poll or stop, never on
        // the audio thread) after a graph was retired and destroyed: swapped
        // out and acknowledged, superseded before it was sent, or released by
        // stop. The owner frees what only that graph used, such as streams.
        // A latency recompile shares the node instances of the graph it came
        // from, so the callback fires once per family: with the epoch
        // publish() returned, when the last graph of that family is retired.
        std::function<void(std::uint64_t epoch)> onRetired;
        // The clock each device callback is timed with, in nanoseconds; nullptr
        // is the steady clock. Tests pass one they advance themselves.
        std::int64_t (*nowNanos)() noexcept = nullptr;
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

    // The control dispatcher's thread only. While playing, the audio thread
    // ducks the output, moves the playhead, tells the graph (so streaming
    // nodes switch to the prepared data) and fades back in. While stopped,
    // the next poll() applies it. A command with `play` starts the transport
    // unless pause() named its generation or a later one.
    //
    // The last applied locate is replayed on every graph that becomes live
    // afterwards, so a graph compiled before a locate but swapped in after it
    // still follows that locate (nodes ignore a generation they already follow).
    bool pushLocate(const TransportCommand& command) noexcept;

    // The control dispatcher's thread only (the single meterOutbox consumer).
    // meterOutbox is latest-value-wins (spec, "Queues"): every processed block
    // publishes one frame with a sample per MeterNode of the live graph and
    // replaces the frame the dispatcher has not read yet, so a read after any
    // stall returns the newest block, never a stale one. popMeter() returns
    // the samples of the newest frame not read yet, one per call, and false
    // when there is none.
    bool popMeter(MeterSample& sample) noexcept;
    // Samples that never reached the dispatcher: those of superseded frames
    // and of MeterNodes past meterCapacity().
    std::uint64_t meterDrops() const noexcept { return meterDrops_.load(std::memory_order_relaxed); }
    std::size_t meterCapacity() const noexcept { return options_.meterCapacity; }

    // Immediate transport, applied at the next block. Transport (transport.hpp)
    // is the production path: it starts through pushLocate() and pauses here,
    // passing the newest generation it has sent so that a start still queued
    // in transportInbox cannot restart the transport.
    void play() noexcept { playing_.store(true); }
    void pause(std::uint64_t throughGeneration = 0) noexcept {
        if (throughGeneration > pausedThrough_.load()) {
            pausedThrough_.store(throughGeneration);
        }
        playing_.store(false);
    }
    bool playing() const noexcept { return playing_.load(); }
    std::int64_t playhead() const noexcept { return playhead_.load(std::memory_order_acquire); }
    // The generation of the last locate the audio thread (or poll() while
    // stopped) applied (0: none). Read it before playhead(): the playhead then
    // belongs to that locate or a newer one.
    std::uint64_t appliedLocate() const noexcept { return appliedLocate_.load(std::memory_order_acquire); }

    // Control side. poll() drains the live graph's realtime outbox and
    // recompiles once per poll that saw a change. Changes from a graph that is
    // already being replaced are dropped: a recompiled successor compares
    // its nodes' latencies itself and reports again, and any other graph was
    // compiled from the nodes' latencies of its own.
    std::uint64_t latencyRecompiles() const noexcept { return latencyRecompiles_; }
    // Recompiles that failed (GraphError, e.g. compensation_limit); the live
    // graph then keeps playing with its old compensation, and latencyFault()
    // says so until a later recompile or publish succeeds.
    std::uint64_t latencyRecompileFailures() const noexcept { return latencyRecompileFailures_; }
    // Set while the live graph is misaligned because its latest recompile
    // failed; cleared by the next successful recompile or publish.
    const std::optional<LatencyFault>& latencyFault() const noexcept { return latencyFault_; }
    const std::optional<LatencyChange>& lastLatencyChange() const noexcept { return lastLatencyChange_; }

    // Control side: the live graph (nullptr when none), for inspection only.
    const graph::PreparedGraph* liveGraph() const noexcept;

    // While stopped: the recorder receives every input block (its own
    // arming decides what is kept). Pass nullptr to detach.
    void attachRecorder(Recorder* recorder);

    // What the device reported when it was opened by start().
    const host::AudioDeviceStatus& deviceStatus() const noexcept { return deviceStatus_; }

    // Set by start() and kept after stop() until the next start().
    const ResamplingState& resampling() const noexcept { return resampling_; }
    const LatencyReport& latency() const noexcept { return latency_; }

    // Device frames the SRC path could not fill (output as silence). This is SRC
    // underfill, reported as `srcUnderruns`; it is not an xrun (deadline miss).
    std::uint64_t srcUnderruns() const noexcept { return srcUnderruns_.load(std::memory_order_acquire); }

    // Every device callback since start(), timed around process(): callbacks,
    // deadline misses (the spec's xruns, reported as `xruns`) and the longest
    // callback. Written on the audio thread with atomics only; read anywhere.
    // This is where a hosted plugin's wait will show once a graph node runs its
    // processBlock inside this callback (spec, "Realtime rules and enforcement",
    // ADR-0018; M4 plugin node).
    const rt::CallbackTimer& callbackTiming() const noexcept { return timing_; }

    DriverState state() const noexcept { return state_; }
    std::uint64_t liveEpoch() const noexcept { return liveEpoch_; }
    bool transitionInFlight() const noexcept { return inFlight_.has_value(); }
    std::size_t ownedGraphs() const noexcept { return owned_.size(); }
    std::uint64_t watchdogTrips() const noexcept { return watchdogTrips_; }

private:
    using Handoff = detail::Handoff;
    struct SrcPath;

    void process(const host::AudioBufferView& input, const host::AudioBufferView& output) noexcept;
    std::int64_t nowNanos() const noexcept;  // audio thread: options_.nowNanos or the steady clock
    void renderBlock(const host::AudioBufferView& output, int offset, int frames, bool playing) noexcept;
    void processResampled(const host::AudioBufferView& input, const host::AudioBufferView& output,
                          bool playing) noexcept;
    void srcStep(bool playing) noexcept;
    void setUpResampling(const host::AudioDeviceConfig& config);
    void drainParams() noexcept;
    void pushMeters(std::int64_t position, int frames) noexcept;
    void applyLocate(const TransportCommand& command) noexcept;
    void replayLocate() noexcept;
    void send(std::uint64_t epoch);
    void installDirectly(std::uint64_t epoch);
    void retire(std::uint64_t epoch);
    void drainRetired();
    void handleLatencyChanges();
    std::uint64_t publishInFamily(std::unique_ptr<graph::PreparedGraph> graph, std::uint64_t family);
    void finishStop();

    Options options_;
    DriverState state_ = DriverState::stopped;
    host::AudioDevice* device_ = nullptr;
    host::AudioDeviceStatus deviceStatus_{};
    Recorder* recorder_ = nullptr;
    ResamplingState resampling_{};
    LatencyReport latency_{};
    std::unique_ptr<SrcPath> src_;  // built by start() when the rates differ
    std::atomic<std::uint64_t> srcUnderruns_{0};
    rt::CallbackTimer timing_;

    // Control side: every graph this driver owns, by epoch.
    std::map<std::uint64_t, std::unique_ptr<graph::PreparedGraph>> owned_;
    std::uint64_t nextEpoch_ = 1;
    std::uint64_t liveEpoch_ = 0;
    std::optional<std::uint64_t> inFlight_;
    std::optional<std::uint64_t> waiting_;  // newest graph published during a transition
    std::chrono::steady_clock::time_point sentAt_{};
    std::uint64_t watchdogTrips_ = 0;
    std::atomic<bool> deviceLost_{false};
    std::map<std::uint64_t, std::uint64_t> families_;  // epoch -> family, for every owned graph
    std::uint64_t latencyRecompiles_ = 0;
    std::uint64_t latencyRecompileFailures_ = 0;
    std::optional<LatencyFault> latencyFault_;
    std::optional<LatencyChange> lastLatencyChange_;

    // Audio side.
    rt::SpscQueue<Handoff> graphInbox_{2};
    rt::SpscQueue<Handoff> retireOutbox_{2};
    rt::SpscQueue<ParamChange> paramInbox_{1024};
    ParamChange heldParam_{};
    bool paramHeld_ = false;  // heldParam_ waits for a newer graph to be swapped in
    graph::PreparedGraph* current_ = nullptr;
    std::uint64_t currentEpoch_ = 0;
    std::uint64_t currentFamily_ = 0;
    Handoff next_{};
    Handoff unsentRetire_{};
    bool retirePending_ = false;  // unsentRetire_ holds an acknowledgement to retry
    rt::SpscQueue<TransportCommand> transportInbox_{64};
    TransportCommand pendingLocate_{};
    bool locatePending_ = false;
    TransportCommand lastLocate_{};  // replayed on each graph that becomes live
    bool duckActive_ = false;  // ducking for a graph swap or a locate
    // The duck in progress ramps only the recompiled graph's affected edges.
    bool pathDuck_ = false;
    // After a recompile's swap: frames until the held edges are fully up
    // (the hold while rebuilt delay lines fill, then the rise), and which
    // edges (the live graph's holdEdges()).
    int pathRise_ = 0;
    std::span<const std::uint8_t> pathEdges_;
    int duckRemaining_ = 0;
    int riseRemaining_ = 0;
    std::atomic<std::int64_t> playhead_{0};
    // Sequentially consistent: pause() and a starting locate must agree on
    // the final state (see applyLocate).
    std::atomic<bool> playing_{false};
    std::atomic<std::uint64_t> pausedThrough_{0};
    std::atomic<std::uint64_t> appliedLocate_{0};
    rt::LatestMailbox<detail::MeterFrame> meterOutbox_;
    std::size_t meterCursor_ = 0;  // dispatcher side: next entry of meterOutbox_.front()
    std::atomic<std::uint64_t> meterDrops_{0};
};

}  // namespace siann::realtime
