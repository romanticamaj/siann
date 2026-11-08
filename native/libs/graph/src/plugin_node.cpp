#include "siann/graph/plugin_node.hpp"

#include <algorithm>
#include <chrono>

namespace siann::graph {

std::int64_t steadyNowNanos() noexcept {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

PluginNode::PluginNode(host::PluginInstance& instance, int channels, std::int64_t sampleRate, bool timed,
                       NowNanos now, rt::CallbackTimer* sharedTimer)
    : instance_(&instance),
      channels_(channels),
      sampleRate_(sampleRate),
      timed_(timed),
      now_(now != nullptr ? now : &steadyNowNanos),
      timer_(sharedTimer != nullptr ? sharedTimer : &ownTimer_) {}

std::int64_t PluginNode::latency() const {
    return bypassed() ? 0 : static_cast<std::int64_t>(std::max(0, instance_->latencyFrames()));
}

void PluginNode::process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                         const AudioBufferView& output) noexcept {
    const AudioBufferView& input = inputs[0];
    if (bypassed()) {
        for (int c = 0; c < output.channelCount; ++c) {
            const float* from = input.channel(std::min(c, input.channelCount - 1));
            std::copy(from, from + context.frames, output.channel(c));
        }
        return;
    }
    // The views the graph hands over cover maxBlockFrames; the instance sees this block.
    const AudioBufferView in{input.channels, input.channelCount, context.frames};
    const AudioBufferView out{output.channels, output.channelCount, context.frames};
    if (!timed_) {
        instance_->process(in, out, host::EventList{});
        return;
    }
    const std::int64_t started = now_();
    instance_->process(in, out, host::EventList{});
    timer_->record(context.frames, sampleRate_, now_() - started);
}

}  // namespace siann::graph
