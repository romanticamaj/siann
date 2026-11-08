#include "siann/graph/plugin_node.hpp"

#include <algorithm>
#include <chrono>

namespace siann::graph {

std::int64_t steadyNowNanos() noexcept {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

void PendingParameters::set(std::uint32_t index, double value) noexcept {
    for (std::size_t i = 0; i < count_; ++i) {
        if (events_[i].data0 == index) {
            events_[i].value = value;
            return;
        }
    }
    if (count_ == events_.size()) {
        dropped_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    events_[count_++] = host::BlockEvent{0, host::BlockEventKind::parameterValue, index, 0, value};
}

PluginNode::PluginNode(host::PluginInstance& instance, int channels, std::int64_t sampleRate, bool timed,
                       NowNanos now, rt::CallbackTimer* sharedTimer, PendingParameters* sharedParameters)
    : instance_(&instance),
      channels_(channels),
      sampleRate_(sampleRate),
      timed_(timed),
      now_(now != nullptr ? now : &steadyNowNanos),
      timer_(sharedTimer != nullptr ? sharedTimer : &ownTimer_),
      parameters_(sharedParameters != nullptr ? sharedParameters : &ownParameters_) {}

void PluginNode::setParameter(std::uint32_t paramId, double value, int rampFrames) noexcept {
    (void)rampFrames;
    parameters_->set(paramId, value);
}

std::int64_t PluginNode::latency() const {
    return bypassed() ? 0 : static_cast<std::int64_t>(std::max(0, instance_->latencyFrames()));
}

void PluginNode::process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                         const AudioBufferView& output) noexcept {
    const AudioBufferView& input = inputs[0];
    if (bypassed()) {
        // Pending parameters wait for the first block processed again.
        for (int c = 0; c < output.channelCount; ++c) {
            const float* from = input.channel(std::min(c, input.channelCount - 1));
            std::copy(from, from + context.frames, output.channel(c));
        }
        return;
    }
    // The views the graph hands over cover maxBlockFrames; the instance sees this block.
    const AudioBufferView in{input.channels, input.channelCount, context.frames};
    const AudioBufferView out{output.channels, output.channelCount, context.frames};
    const host::EventList events = parameters_->events();
    if (!timed_) {
        instance_->process(in, out, events);
        parameters_->clear();
        return;
    }
    const std::int64_t started = now_();
    instance_->process(in, out, events);
    timer_->record(context.frames, sampleRate_, now_() - started);
    parameters_->clear();
}

}  // namespace siann::graph
