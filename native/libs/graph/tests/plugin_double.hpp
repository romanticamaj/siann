#pragma once

// A test double for host::PluginInstance (host_api is header-only): delays its
// input by the latency it reports and scales it by `gain`, counts process()
// calls and advances a fake clock by `processNanos` in each, so a PluginNode's
// timer sees a slow block without a real wait.

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <vector>

#include "siann/host/interfaces.hpp"

namespace siann::test {

inline std::atomic<std::int64_t>& fakeClock() noexcept {
    static std::atomic<std::int64_t> clock{0};
    return clock;
}

inline std::int64_t fakeNow() noexcept {
    return fakeClock().load();
}

class NullControl final : public host::PluginControl {
public:
    std::vector<std::uint8_t> getState() override { return {}; }
    void setState(const std::vector<std::uint8_t>&) override {}
    std::vector<host::PluginParameterInfo> parameters() const override { return {}; }
    double getParameter(int) const override { return 0.0; }
    void setParameter(int, double) override {}
    void openEditor(host::EditorOwner) override { throw std::runtime_error("no editor"); }
    void closeEditor() override {}
    bool editorOpen() const override { return false; }
    std::uintptr_t editorNativeHandle() const override { return 0; }
    void setEventSink(std::function<void(const host::PluginEvent&)>) override {}
    void pollStale() override {}
};

class DoublePlugin final : public host::PluginInstance {
public:
    static constexpr int kMaxDelay = 4096;

    explicit DoublePlugin(int latency = 0, float gainValue = 1.0f) : gain(gainValue), latency_(latency) {
        for (auto& line : ring_) {
            line.assign(kMaxDelay, 0.0f);
        }
    }

    host::PluginCapabilities capabilities() const override { return {}; }
    int latencyFrames() const override { return latency_.load(); }
    int tailFrames() const override { return 0; }
    void process(const host::AudioBufferView& input, const host::AudioBufferView& output,
                 host::EventList events) noexcept override {
        if (calls.fetch_add(1) == 0 && sequence != nullptr) {
            firstCall = sequence->fetch_add(1);
        }
        lastEventCount.store(static_cast<int>(events.size()));
        // A copy of the block's events, into preallocated storage (no allocation here).
        receivedCount = 0;
        for (const host::BlockEvent& event : events) {
            if (receivedCount < received.size()) {
                received[receivedCount++] = event;
            }
        }
        fakeClock().fetch_add(processNanos.load());
        const int delay = latency_.load();
        for (int c = 0; c < output.channelCount; ++c) {
            auto& line = ring_[static_cast<std::size_t>(c % 2)];
            const float* in = input.channel(c < input.channelCount ? c : input.channelCount - 1);
            for (int i = 0; i < output.frames; ++i) {
                const std::size_t write = (position_ + static_cast<std::size_t>(i)) % kMaxDelay;
                line[write] = in[i];
                output.channel(c)[i] =
                    line[(write + kMaxDelay - static_cast<std::size_t>(delay)) % kMaxDelay] * gain;
            }
        }
        position_ = (position_ + static_cast<std::size_t>(output.frames)) % kMaxDelay;
    }
    host::PluginControl& control() override { return control_; }
    std::uint64_t midiOutputOverflows() const noexcept override { return 0; }

    void setLatency(int frames) noexcept { latency_.store(frames); }

    std::atomic<int> calls{0};
    std::atomic<int> lastEventCount{-1};
    // The events of the last process() call, up to the array's size.
    std::array<host::BlockEvent, 256> received{};
    std::size_t receivedCount = 0;
    std::atomic<std::int64_t> processNanos{0};
    float gain = 1.0f;
    // When set, the first process() call takes the next number from it.
    std::atomic<int>* sequence = nullptr;
    int firstCall = -1;

private:
    std::atomic<int> latency_;
    std::vector<float> ring_[2];
    std::size_t position_ = 0;
    NullControl control_;
};

}  // namespace siann::test
