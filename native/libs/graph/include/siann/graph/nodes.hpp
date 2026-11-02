#pragma once

// Built-in nodes for M1.

#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

#include "siann/graph/graph.hpp"

namespace siann::graph {

// Decoded media, planar, shared between clips and graphs.
struct PlanarAudio {
    int channels = 0;
    std::int64_t frames = 0;
    std::vector<std::vector<float>> data;  // channels x frames
};

// Linear gain for an integer milli-dB value; INT32_MIN (minus infinity) is 0.
float gainFromMilliDb(std::int32_t milliDb) noexcept;

// Plays scheduled regions of media on the timeline. Overlapping clips sum.
// Media channels map to the output: equal counts copy, mono feeds every
// output channel, stereo into mono averages, otherwise the first channels.
class ClipPlayerNode final : public Node {
public:
    struct Clip {
        std::int64_t timelineStart = 0;  // samples
        std::int64_t sourceStart = 0;    // media frames
        std::int64_t length = 0;         // frames
        float gain = 1.0f;
        std::shared_ptr<const PlanarAudio> media;
    };

    ClipPlayerNode(int channels, std::vector<Clip> clips);
    int outputChannels() const override { return channels_; }
    void process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                 const AudioBufferView& output) noexcept override;

private:
    int channels_;
    std::vector<Clip> clips_;  // sorted by timelineStart
};

// Track fader: gain, pan and mute, producing stereo. Mono input pans with the
// constant-power law (center -3 dB); stereo input uses linear balance (unity at
// center, the far side attenuated toward zero).
class TrackFaderNode final : public Node {
public:
    // Parameters for setParameter.
    static constexpr std::uint32_t kGainMilliDb = 1;  // INT32_MIN is minus infinity
    static constexpr std::uint32_t kPan = 2;          // [-10000, 10000]
    static constexpr std::uint32_t kMute = 3;         // 0 or 1: the track's own mute

    // soloSilenced: another track is soloed and this one is not. It silences
    // the fader independently of kMute, so a mute change cannot unsilence it.
    TrackFaderNode(int inputChannels, std::int32_t gainMilliDb, std::int32_t pan, bool mute,
                   bool soloSilenced = false);
    std::vector<int> inputPorts() const override { return {inputChannels_}; }
    int outputChannels() const override { return 2; }
    void process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                 const AudioBufferView& output) noexcept override;
    void setParameter(std::uint32_t paramId, double value, int rampFrames) noexcept override;

    // Current (ramping) per-side gains.
    float leftGain() const noexcept { return left_; }
    float rightGain() const noexcept { return right_; }

private:
    void retarget(int rampFrames) noexcept;

    int inputChannels_;
    std::int32_t gainMilliDb_;
    std::int32_t pan_;
    bool mute_;
    bool soloSilenced_;
    float left_ = 0.0f;
    float right_ = 0.0f;
    float leftStep_ = 0.0f;
    float rightStep_ = 0.0f;
    float leftTarget_ = 0.0f;
    float rightTarget_ = 0.0f;
    int remaining_ = 0;
};

// A summing bus with a fixed gain.
class BusNode final : public Node {
public:
    explicit BusNode(int channels, float gain = 1.0f) : channels_(channels), gain_(gain) {}
    std::vector<int> inputPorts() const override { return {channels_}; }
    int outputChannels() const override { return channels_; }
    void process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                 const AudioBufferView& output) noexcept override;

private:
    int channels_;
    float gain_;
};

// Passes its input through unchanged and measures each block: per channel,
// the peak max|x| and the RMS sqrt(mean(x^2)). The reading is replaced every
// block, never held. compile() lists every MeterNode (meteredNodes()).
class MeterNode final : public Node {
public:
    explicit MeterNode(int channels) : channels_(channels) {}
    std::vector<int> inputPorts() const override { return {channels_}; }
    int outputChannels() const override { return channels_; }
    void process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                 const AudioBufferView& output) noexcept override;

    const MeterReading& reading() const noexcept { return reading_; }

private:
    int channels_;
    MeterReading reading_{};
};

// Delays its input by its latency and reports it. Used to test PDC.
//
// The latency can change at runtime, like a plugin reporting a new latency:
// requestLatency() stores the request (any thread); process() picks it up at
// the start of its next block on the audio thread, restarts the delay line
// with silence and reports the new latency() from then on. The delay line is
// allocated for maxLatency in prepare(), so the switch never allocates.
class FakeLatencyNode final : public Node {
public:
    // Throws std::invalid_argument unless 0 <= latency <= maxLatency.
    FakeLatencyNode(int channels, std::int64_t latency, std::int64_t maxLatency);
    FakeLatencyNode(int channels, std::int64_t latency) : FakeLatencyNode(channels, latency, latency) {}
    std::vector<int> inputPorts() const override { return {channels_}; }
    int outputChannels() const override { return channels_; }
    // The latency in effect for the current block. Written by process(), so
    // the control side can read it while the graph plays (a recompile does).
    std::int64_t latency() const override { return latency_.load(std::memory_order_acquire); }
    std::int64_t maxLatency() const noexcept { return maxLatency_; }
    void prepare(int maxBlockFrames) override;
    void process(const ProcessContext& context, std::span<const AudioBufferView> inputs,
                 const AudioBufferView& output) noexcept override;

    // Any thread. Rejects (returns false, nothing changes) a request outside
    // [0, maxLatency]; the latest accepted request wins at the next block.
    bool requestLatency(std::int64_t samples) noexcept;

private:
    int channels_;
    std::atomic<std::int64_t> latency_;
    std::int64_t maxLatency_;
    std::atomic<std::int64_t> requested_;
    std::vector<std::vector<float>> ring_;  // maxLatency_ frames per channel; latency_ in use
    std::size_t position_ = 0;
};

}  // namespace siann::graph
