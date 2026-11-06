#pragma once

// A known delay for the hosting tests (M0, plugin-set gate): stereo audio comes
// out delayed by exactly the latency the plugin declares, so a host's latency
// report can be checked against audio.
//
// Parameters: "latency" (off: 64 frames, on: 512 frames), "gain" (0 to 1),
// "futureState" (getStateInformation then writes a state version this plugin
// does not read, which is how a test gets a blob the plugin must reject) and
// "nudgeGain" (turning it on moves "gain" to 0.5 later, on the message thread,
// the way an editor edit reaches a host). Its tail is what the delay line holds:
// none with "latency" off, longTailSeconds with it on.
//
// Probes for the host's side of things, none of them state:
// - "requestRestart": turning it on asks a VST3 host for
//   restartComponent(kReloadComponent | kIoChanged) on the message thread. Each
//   activation that restart causes takes restartWatch, as a heavy plugin's would,
//   and watches for processBlock running meanwhile. The plugin then sets
//   "overlapped" if it saw that and "restarted" to say the restart is over.
// - "watchRestore": with it on, setStateInformation takes restartWatch and watches
//   for processBlock in the same way, then sets "overlapped" if it saw that and
//   "restored" to say the restore is over.
// - getTailLengthSeconds answers wrongThreadTailSeconds on any thread but the one
//   that built the plugin: VST3 allows that one call on the UI thread only, so a
//   host that reads it from elsewhere gets a number it can be caught with.
// - "home:<directory>": the name says which directory holds the bundle this code
//   was loaded from, which tells two installs of the plugin apart.
//
// State blob: magic "SIANNTP1", version u32, gain f32, latency u8, little endian.

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <thread>

#include "vst3_restarter.hpp"

namespace siann::test_plugin {

class Processor final : public juce::AudioProcessor,
                        private juce::AudioProcessorParameter::Listener,
                        private juce::AsyncUpdater {
public:
    static constexpr int shortLatency = 64;
    static constexpr int longLatency = 512;
    static constexpr float nudgedGain = 0.5f;
    static constexpr auto restartWatch = std::chrono::milliseconds(20);
    static constexpr double longTailSeconds = 0.25;
    static constexpr double wrongThreadTailSeconds = 1.0;

    Processor();
    ~Processor() override;

    const juce::String getName() const override { return "SIANN Test Plugin"; }
    void prepareToPlay(double sampleRate, int maximumExpectedSamplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;
    using juce::AudioProcessor::processBlock;
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
    double getTailLengthSeconds() const override;
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

    juce::VST3ClientExtensions* getVST3ClientExtensions() override { return &restarter_; }

private:
    static constexpr int ringFrames = 1024;  // a power of two above longLatency

    void parameterValueChanged(int parameterIndex, float newValue) override;
    void parameterGestureChanged(int, bool) override {}
    void handleAsyncUpdate() override;
    void applyLatency();
    void watchForProcessBlock();
    void watchRestart();

    juce::AudioParameterBool* latency_;
    juce::AudioParameterFloat* gain_;
    juce::AudioParameterBool* futureState_;
    juce::AudioParameterBool* nudgeGain_;
    juce::AudioParameterBool* requestRestart_;
    juce::AudioParameterBool* overlapped_;
    juce::AudioParameterBool* restarted_;
    juce::AudioParameterBool* watchRestore_;
    juce::AudioParameterBool* restored_;
    Vst3Restarter restarter_;
    std::thread::id homeThread_ = std::this_thread::get_id();
    std::atomic<bool> nudgePending_{false};
    std::atomic<bool> restartRequested_{false};
    std::atomic<bool> restarting_{false};
    std::atomic<bool> restorePending_{false};
    std::atomic<bool> inProcessBlock_{false};
    std::atomic<bool> sawOverlap_{false};
    std::atomic<int> restartActivations_{0};
    std::atomic<int> delayFrames_{shortLatency};
    int activeDelay_ = shortLatency;
    int writeIndex_ = 0;
    std::array<std::array<float, ringFrames>, 2> ring_{};
};

}  // namespace siann::test_plugin
