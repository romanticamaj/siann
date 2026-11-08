#pragma once

// A hosted plugin in the graph (architecture spec, "siann-graph and
// siann-engine" and "Realtime rules and enforcement"; m4-plugin-node).
//
// PluginNode wraps a PluginInstance it does not own: the instance table of
// siann-playback (or a render's own instance set) owns it and outlives every
// graph that holds the node. process() calls PluginInstance::process once per
// block, with SIANN's buffer views and an empty event list (no MIDI tracks
// before M6b; a plugin's output events are counted by its host adapter and
// dropped). The node is processed by one driver at a time: the graph driver's
// callback, or the offline render thread for the render's own instances.
//
// Timing: a timed node (the realtime path) measures each process() call with
// `now` into an rt::CallbackTimer, atomics only: a deadline miss is a call
// longer than the block's period at sampleRate. The timer is the node's own or
// one passed in, so the counters can outlive the node (the instance table keeps
// them per instance across recompiles). An untimed node (offline) records
// nothing. Bypass: the input is copied to the output and the instance is not
// called; a bypassed node reports no latency.
//
// Parameters (m4-crash-recovery; spec, Protocol v0 item 20): setParameter(index,
// value) from the graph driver, on the thread that processes the node and between
// blocks, keeps the latest value per parameter index in a fixed set of
// PendingParameters; the next processed block hands them to the instance as
// BlockEventKind::parameterValue events at offset 0 (CLAP delivers them; JUCE's
// formats discard block events, so the engine host sets theirs on the main thread
// instead). A bypassed node keeps them for the first block it processes again. Past
// kMaxPendingParameters different indices a new index is dropped and counted
// (droppedParameters()). The set is the node's own or one passed in, so values not
// yet delivered survive a recompile that builds a new node around the instance
// (the instance table keeps one per instance, like the timer).
//
// Nothing here takes a lock or allocates after construction; a ctest check
// (SiannNoLocks.cmake) keeps lock names out of this file's source.

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/host/interfaces.hpp"
#include "siann/rt/callback_timer.hpp"

namespace siann::graph {

using NowNanos = std::int64_t (*)() noexcept;

// std::chrono::steady_clock in nanoseconds.
std::int64_t steadyNowNanos() noexcept;

// Parameter values waiting for an instance's next processed block. set() and the
// block's events() / clear() run on the one thread that processes the instance's
// node; dropped() on any thread. Fixed storage: nothing allocates.
class PendingParameters {
public:
    static constexpr std::size_t kCapacity = 64;

    // The latest value per index wins; a new index when full is dropped and counted.
    void set(std::uint32_t index, double value) noexcept;
    std::span<const host::BlockEvent> events() const noexcept { return {events_.data(), count_}; }
    void clear() noexcept { count_ = 0; }
    std::uint64_t dropped() const noexcept { return dropped_.load(std::memory_order_relaxed); }

private:
    std::array<host::BlockEvent, kCapacity> events_{};
    std::size_t count_ = 0;
    std::atomic<std::uint64_t> dropped_{0};
};

class PluginNode final : public Node {
public:
    static constexpr std::size_t kMaxPendingParameters = PendingParameters::kCapacity;

    PluginNode(host::PluginInstance& instance, int channels, std::int64_t sampleRate, bool timed,
               NowNanos now = &steadyNowNanos, rt::CallbackTimer* sharedTimer = nullptr,
               PendingParameters* sharedParameters = nullptr);

    std::vector<int> inputPorts() const override { return {channels_}; }
    int outputChannels() const override { return channels_; }
    // The instance's latency (read every block by the graph), 0 while bypassed.
    std::int64_t latency() const override;
    void process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                 const AudioBufferView& output) noexcept override;
    // The driver, between blocks: `paramId` is the parameter's index in the
    // instance's parameter list, `value` normalized. rampFrames is not used: the
    // value lands at the start of the next processed block.
    void setParameter(std::uint32_t paramId, double value, int rampFrames) noexcept override;
    // Any thread: new parameter indices dropped because the pending set was full.
    std::uint64_t droppedParameters() const noexcept { return parameters_->dropped(); }

    // Any thread; takes effect at the next block.
    void setBypass(bool bypass) noexcept { bypass_.store(bypass, std::memory_order_release); }
    bool bypassed() const noexcept { return bypass_.load(std::memory_order_acquire); }

    // Any thread: the counters of the timer this node records into.
    const rt::CallbackTimer& timer() const noexcept { return *timer_; }
    host::PluginInstance& instance() const noexcept { return *instance_; }

private:
    host::PluginInstance* instance_;  // not owned
    int channels_;
    std::int64_t sampleRate_;
    bool timed_;
    NowNanos now_;
    rt::CallbackTimer ownTimer_;
    rt::CallbackTimer* timer_;
    PendingParameters ownParameters_;
    PendingParameters* parameters_;
    std::atomic<bool> bypass_{false};
};

}  // namespace siann::graph
