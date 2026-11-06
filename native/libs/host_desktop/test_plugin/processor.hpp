#pragma once

// A known delay for the hosting tests (M0, plugin-set gate): stereo audio comes
// out delayed by exactly the latency the plugin declares, so a host's latency
// report can be checked against audio.
//
// Parameters: "latency" (off: 64 frames, on: 512 frames), "gain" (0 to 1),
// "futureState" (getStateInformation then writes a state version this plugin
// does not read, which is how a test gets a blob the plugin must reject) and
// "nudgeGain" (turning it on moves "gain" to 0.5 later, on the message thread,
// the way an editor edit reaches a host).
//
// State blob: magic "SIANNTP1", version u32, gain f32, latency u8, little endian.

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>
#include <cstdint>

namespace siann::test_plugin {

class Processor final : public juce::AudioProcessor,
                        private juce::AudioProcessorParameter::Listener,
                        private juce::AsyncUpdater {
public:
    static constexpr int shortLatency = 64;
    static constexpr int longLatency = 512;
    static constexpr float nudgedGain = 0.5f;

    Processor();
    ~Processor() override;

    const juce::String getName() const override { return "SIANN Test Plugin"; }
    void prepareToPlay(double sampleRate, int maximumExpectedSamplesPerBlock) override;
    void releaseResources() override {}
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;
    using juce::AudioProcessor::processBlock;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
    double getTailLengthSeconds() const override { return 0.0; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destination) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

private:
    static constexpr int ringFrames = 1024;  // a power of two above longLatency

    void parameterValueChanged(int parameterIndex, float newValue) override;
    void parameterGestureChanged(int, bool) override {}
    void handleAsyncUpdate() override;
    void applyLatency();

    juce::AudioParameterBool* latency_;
    juce::AudioParameterFloat* gain_;
    juce::AudioParameterBool* futureState_;
    juce::AudioParameterBool* nudgeGain_;
    std::atomic<int> delayFrames_{shortLatency};
    int activeDelay_ = shortLatency;
    int writeIndex_ = 0;
    std::array<std::array<float, ringFrames>, 2> ring_{};
};

}  // namespace siann::test_plugin
