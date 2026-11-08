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
// Nothing here takes a lock or allocates after construction; a ctest check
// (SiannNoLocks.cmake) keeps lock names out of this file's source.

#include <atomic>
#include <cstdint>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/host/interfaces.hpp"
#include "siann/rt/callback_timer.hpp"

namespace siann::graph {

using NowNanos = std::int64_t (*)() noexcept;

// std::chrono::steady_clock in nanoseconds.
std::int64_t steadyNowNanos() noexcept;

class PluginNode final : public Node {
public:
    PluginNode(host::PluginInstance& instance, int channels, std::int64_t sampleRate, bool timed,
               NowNanos now = &steadyNowNanos, rt::CallbackTimer* sharedTimer = nullptr);

    std::vector<int> inputPorts() const override { return {channels_}; }
    int outputChannels() const override { return channels_; }
    // The instance's latency (read every block by the graph), 0 while bypassed.
    std::int64_t latency() const override;
    void process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                 const AudioBufferView& output) noexcept override;

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
    std::atomic<bool> bypass_{false};
};

}  // namespace siann::graph
