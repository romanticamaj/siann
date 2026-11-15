#include "siann/graph/nodes.hpp"

#include <algorithm>
#include <climits>
#include <cmath>
#include <numbers>
#include <stdexcept>

namespace siann::graph {

float gainFromMilliDb(std::int32_t milliDb) noexcept {
    if (milliDb == INT32_MIN) {
        return 0.0f;
    }
    return static_cast<float>(std::pow(10.0, static_cast<double>(milliDb) / 20'000.0));
}

ClipPlayerNode::ClipPlayerNode(int channels, std::vector<Clip> clips) : channels_(channels), clips_(std::move(clips)) {
    std::stable_sort(clips_.begin(), clips_.end(),
                     [](const Clip& a, const Clip& b) { return a.timelineStart < b.timelineStart; });
}

void ClipPlayerNode::process(const ProcessContext& context, std::span<const AudioBufferView>,
                             const AudioBufferView& output) noexcept {
    output.clear();
    if (!context.rolling) {
        return;  // stopped: silence (the position is the context's, so nothing moves)
    }
    const std::int64_t blockEnd = context.blockStart + context.frames;
    for (const Clip& clip : clips_) {
        if (clip.timelineStart >= blockEnd) {
            break;  // sorted by start
        }
        const std::int64_t clipEnd = clip.timelineStart + clip.length;
        const std::int64_t from = std::max(context.blockStart, clip.timelineStart);
        const std::int64_t to = std::min(blockEnd, clipEnd);
        if (from >= to || !clip.media) {
            continue;
        }
        const PlanarAudio& media = *clip.media;
        for (std::int64_t t = from; t < to; ++t) {
            const std::int64_t frame = clip.sourceStart + (t - clip.timelineStart);
            if (frame < 0 || frame >= media.frames) {
                continue;
            }
            const auto i = static_cast<std::size_t>(t - context.blockStart);
            const auto f = static_cast<std::size_t>(frame);
            if (media.channels == channels_) {
                for (int c = 0; c < channels_; ++c) {
                    output.channel(c)[i] += media.data[static_cast<std::size_t>(c)][f] * clip.gain;
                }
            } else if (media.channels == 1) {
                const float v = media.data[0][f] * clip.gain;
                for (int c = 0; c < channels_; ++c) {
                    output.channel(c)[i] += v;
                }
            } else if (channels_ == 1 && media.channels == 2) {
                output.channel(0)[i] += 0.5f * (media.data[0][f] + media.data[1][f]) * clip.gain;
            } else {
                const int shared = std::min(channels_, media.channels);
                for (int c = 0; c < shared; ++c) {
                    output.channel(c)[i] += media.data[static_cast<std::size_t>(c)][f] * clip.gain;
                }
            }
        }
    }
}

TrackFaderNode::TrackFaderNode(int inputChannels, std::int32_t gainMilliDb, std::int32_t pan, bool mute,
                               bool soloSilenced)
    : inputChannels_(inputChannels), gainMilliDb_(gainMilliDb), pan_(pan), mute_(mute), soloSilenced_(soloSilenced) {
    retarget(0);
}

void TrackFaderNode::retarget(int rampFrames) noexcept {
    float left = 0.0f;
    float right = 0.0f;
    if (!mute_ && !soloSilenced_) {
        const float gain = gainFromMilliDb(gainMilliDb_);
        const double p = std::clamp(static_cast<double>(pan_) / 10'000.0, -1.0, 1.0);
        if (inputChannels_ == 1) {
            const double theta = (p + 1.0) * std::numbers::pi / 4.0;
            left = gain * static_cast<float>(std::cos(theta));
            right = gain * static_cast<float>(std::sin(theta));
        } else {
            left = gain * static_cast<float>(std::min(1.0, 1.0 - p));
            right = gain * static_cast<float>(std::min(1.0, 1.0 + p));
        }
    }
    leftTarget_ = left;
    rightTarget_ = right;
    if (rampFrames <= 0) {
        left_ = left;
        right_ = right;
        remaining_ = 0;
        return;
    }
    remaining_ = rampFrames;
    leftStep_ = (left - left_) / static_cast<float>(rampFrames);
    rightStep_ = (right - right_) / static_cast<float>(rampFrames);
}

void TrackFaderNode::setParameter(std::uint32_t paramId, double value, int rampFrames) noexcept {
    if (std::isnan(value)) {
        return;
    }
    switch (paramId) {
        case kGainMilliDb:
            gainMilliDb_ = value <= static_cast<double>(INT32_MIN)
                               ? INT32_MIN
                               : static_cast<std::int32_t>(std::lround(std::clamp(
                                     value, static_cast<double>(kMinGainMilliDb), static_cast<double>(kMaxGainMilliDb))));
            break;
        case kPan:
            pan_ = static_cast<std::int32_t>(std::lround(std::clamp(value, -10'000.0, 10'000.0)));
            break;
        case kMute:
            mute_ = value != 0.0;
            break;
        default:
            return;
    }
    retarget(rampFrames);
}

void TrackFaderNode::process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                             const AudioBufferView& output) noexcept {
    const AudioBufferView& in = inputs[0];
    const float* l = in.channel(0);
    const float* r = inputChannels_ >= 2 ? in.channel(1) : in.channel(0);
    for (int i = 0; i < context.frames; ++i) {
        if (remaining_ > 0) {
            if (--remaining_ == 0) {
                left_ = leftTarget_;  // land exactly on the target
                right_ = rightTarget_;
            } else {
                left_ += leftStep_;
                right_ += rightStep_;
            }
        }
        output.channel(0)[i] = l[i] * left_;
        output.channel(1)[i] = r[i] * right_;
    }
}

void BusNode::process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                      const AudioBufferView& output) noexcept {
    for (int c = 0; c < channels_; ++c) {
        for (int i = 0; i < context.frames; ++i) {
            output.channel(c)[i] = inputs[0].channel(c)[i] * gain_;
        }
    }
}

void MeterNode::process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                        const AudioBufferView& output) noexcept {
    const AudioBufferView& in = inputs[0];
    for (int c = 0; c < channels_; ++c) {
        const float* src = in.channel(c);
        float* dst = output.channel(c);
        float peak = 0.0f;
        double sumSquares = 0.0;
        for (int i = 0; i < context.frames; ++i) {
            const float v = src[i];
            dst[i] = v;
            peak = std::max(peak, std::abs(v));
            sumSquares += static_cast<double>(v) * static_cast<double>(v);
        }
        if (c < kMaxMeterChannels) {
            const auto k = static_cast<std::size_t>(c);
            reading_.peak[k] = peak;
            reading_.rms[k] = context.frames > 0
                                  ? static_cast<float>(std::sqrt(sumSquares / static_cast<double>(context.frames)))
                                  : 0.0f;
        }
    }
    reading_.channels = std::min(channels_, kMaxMeterChannels);
}

FakeLatencyNode::FakeLatencyNode(int channels, std::int64_t latency, std::int64_t maxLatency)
    : channels_(channels), latency_(latency), maxLatency_(maxLatency), requested_(latency) {
    if (latency < 0 || maxLatency < latency) {
        throw std::invalid_argument("FakeLatency needs 0 <= latency <= maxLatency");
    }
}

bool FakeLatencyNode::requestLatency(std::int64_t samples) noexcept {
    if (samples < 0 || samples > maxLatency_) {
        return false;
    }
    requested_.store(samples, std::memory_order_release);
    return true;
}

void FakeLatencyNode::prepare(int) {
    ring_.assign(static_cast<std::size_t>(channels_), std::vector<float>(static_cast<std::size_t>(maxLatency_), 0.0f));
    position_ = 0;
}

void FakeLatencyNode::process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                              const AudioBufferView& output) noexcept {
    const std::int64_t requested = requested_.load(std::memory_order_acquire);
    std::int64_t current = latency_.load(std::memory_order_relaxed);  // this thread is the only writer
    if (requested != current) {
        // A new latency: restart the delay line with silence, in place.
        current = requested;
        position_ = 0;
        for (auto& ring : ring_) {
            std::fill(ring.begin(), ring.begin() + static_cast<std::ptrdiff_t>(current), 0.0f);
        }
        latency_.store(current, std::memory_order_release);
    }
    if (current == 0) {
        for (int c = 0; c < channels_; ++c) {
            for (int i = 0; i < context.frames; ++i) {
                output.channel(c)[i] = inputs[0].channel(c)[i];
            }
        }
        return;
    }
    const auto length = static_cast<std::size_t>(current);
    for (int c = 0; c < channels_; ++c) {
        auto& ring = ring_[static_cast<std::size_t>(c)];
        std::size_t pos = position_;
        for (int i = 0; i < context.frames; ++i) {
            output.channel(c)[i] = ring[pos];
            ring[pos] = inputs[0].channel(c)[i];
            if (++pos == length) {
                pos = 0;
            }
        }
    }
    position_ = (position_ + static_cast<std::size_t>(context.frames)) % length;
}

MonitorInputNode::MonitorInputNode(int channels, MonitorInputMode mode, int inputPort, int inputChannels,
                                   const MonitorGate* gate, int fadeFrames)
    : channels_(channels),
      mode_(mode),
      inputPort_(inputPort),
      inputChannels_(inputChannels),
      gate_(gate),
      fadeFrames_(std::max(fadeFrames, 1)) {
    if (channels < 1 || inputPort < 0 || inputChannels < 0 || inputChannels > 2) {
        throw std::invalid_argument("a monitor input needs channels >= 1, a port >= 0 and 0 to 2 input channels");
    }
}

void MonitorInputNode::prepare(int maxBlockFrames) {
    blend_.assign(static_cast<std::size_t>(std::max(maxBlockFrames, 0)), 0.0f);
}

bool MonitorInputNode::wantsInput(bool rolling) const noexcept {
    if (mode_ == MonitorInputMode::input) {
        return true;
    }
    if (gate_ == nullptr) {
        return false;
    }
    return rolling ? gate_->capturing.load(std::memory_order_acquire) : gate_->armed.load(std::memory_order_acquire);
}

void MonitorInputNode::process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                               const AudioBufferView& output) noexcept {
    const int frames = std::min(context.frames, static_cast<int>(blend_.size()));
    const int target = wantsInput(context.rolling) ? fadeFrames_ : 0;
    if (!primed_) {
        position_ = target;  // the first block starts where it is: the graph's own rise covers it
        primed_ = true;
    }
    const float fade = static_cast<float>(fadeFrames_);
    for (int i = 0; i < frames; ++i) {
        if (position_ < target) {
            ++position_;
        } else if (position_ > target) {
            --position_;
        }
        blend_[static_cast<std::size_t>(i)] = static_cast<float>(position_) / fade;
    }

    const AudioBufferView* in = context.input;
    const bool haveInput = in != nullptr && in->channels != nullptr && inputChannels_ > 0 &&
                           inputPort_ + inputChannels_ <= in->channelCount && in->frames >= frames;
    const AudioBufferView& clips = inputs[0];
    for (int c = 0; c < channels_; ++c) {
        const float* source = clips.channel(c);
        float* out = output.channel(c);
        // The input channel(s) this output channel takes: equal counts copy, mono
        // feeds every channel, stereo into mono averages.
        const float* first = nullptr;
        const float* second = nullptr;
        if (haveInput) {
            if (inputChannels_ == channels_) {
                first = in->channel(inputPort_ + c);
            } else if (inputChannels_ == 1) {
                first = in->channel(inputPort_);
            } else if (channels_ == 1) {
                first = in->channel(inputPort_);
                second = in->channel(inputPort_ + 1);
            } else {
                first = in->channel(inputPort_ + std::min(c, inputChannels_ - 1));
            }
        }
        for (int i = 0; i < frames; ++i) {
            const float blend = blend_[static_cast<std::size_t>(i)];
            float live = 0.0f;
            if (first != nullptr) {
                live = second != nullptr ? 0.5f * (first[i] + second[i]) : first[i];
            }
            out[i] = blend == 0.0f   ? source[i]
                     : blend == 1.0f ? live
                                     : source[i] * (1.0f - blend) + live * blend;
        }
    }
}

}  // namespace siann::graph
