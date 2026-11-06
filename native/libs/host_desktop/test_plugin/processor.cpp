#include "processor.hpp"

#include <cstring>

namespace siann::test_plugin {

namespace {

constexpr char stateMagic[8] = {'S', 'I', 'A', 'N', 'N', 'T', 'P', '1'};
constexpr std::uint32_t stateVersion = 1;
constexpr std::uint32_t futureStateVersion = 2;
constexpr std::size_t stateSize = sizeof(stateMagic) + sizeof(std::uint32_t) + sizeof(float) + 1;

}  // namespace

Processor::Processor()
    : juce::AudioProcessor(BusesProperties()
                               .withInput("Input", juce::AudioChannelSet::stereo(), true)
                               .withOutput("Output", juce::AudioChannelSet::stereo(), true)) {
    latency_ = new juce::AudioParameterBool(juce::ParameterID{"latency", 1}, "latency", false);
    gain_ = new juce::AudioParameterFloat(juce::ParameterID{"gain", 1}, "gain",
                                          juce::NormalisableRange<float>(0.0f, 1.0f), 1.0f);
    futureState_ = new juce::AudioParameterBool(juce::ParameterID{"futureState", 1}, "futureState", false);
    nudgeGain_ = new juce::AudioParameterBool(juce::ParameterID{"nudgeGain", 1}, "nudgeGain", false);
    addParameter(latency_);
    addParameter(gain_);
    addParameter(futureState_);
    addParameter(nudgeGain_);
    latency_->addListener(this);
    nudgeGain_->addListener(this);
    setLatencySamples(shortLatency);
}

Processor::~Processor() {
    cancelPendingUpdate();
    nudgeGain_->removeListener(this);
    latency_->removeListener(this);
}

void Processor::applyLatency() {
    const int frames = latency_->get() ? longLatency : shortLatency;
    delayFrames_.store(frames, std::memory_order_release);
    setLatencySamples(frames);
}

void Processor::parameterValueChanged(int parameterIndex, float newValue) {
    if (parameterIndex == nudgeGain_->getParameterIndex()) {
        if (newValue >= 0.5f) {
            triggerAsyncUpdate();
        }
        return;
    }
    applyLatency();
}

// What an editor does when the user moves a control.
void Processor::handleAsyncUpdate() {
    gain_->beginChangeGesture();
    gain_->setValueNotifyingHost(nudgedGain);
    gain_->endChangeGesture();
}

void Processor::prepareToPlay(double, int) {
    for (auto& channel : ring_) {
        channel.fill(0.0f);
    }
    writeIndex_ = 0;
    activeDelay_ = delayFrames_.load(std::memory_order_acquire);
    applyLatency();
}

bool Processor::isBusesLayoutSupported(const BusesLayout& layouts) const {
    return layouts.getMainInputChannelSet() == juce::AudioChannelSet::stereo() &&
           layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
}

void Processor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) {
    const int delay = delayFrames_.load(std::memory_order_acquire);
    if (delay != activeDelay_) {
        // What is in the ring was delayed by the old amount; drop it so the new
        // latency is exact from here on.
        for (auto& channel : ring_) {
            channel.fill(0.0f);
        }
        activeDelay_ = delay;
    }
    const float gain = gain_->get();
    const int frames = buffer.getNumSamples();
    const int channels = juce::jmin(buffer.getNumChannels(), static_cast<int>(ring_.size()));
    constexpr int mask = ringFrames - 1;
    for (int c = 0; c < channels; ++c) {
        float* samples = buffer.getWritePointer(c);
        auto& ring = ring_[static_cast<std::size_t>(c)];
        for (int i = 0; i < frames; ++i) {
            const int write = (writeIndex_ + i) & mask;
            ring[static_cast<std::size_t>(write)] = samples[i];
            samples[i] = ring[static_cast<std::size_t>((write - delay) & mask)] * gain;
        }
    }
    writeIndex_ = (writeIndex_ + frames) & mask;
}

juce::AudioProcessorEditor* Processor::createEditor() {
    return new juce::GenericAudioProcessorEditor(*this);
}

void Processor::getStateInformation(juce::MemoryBlock& destination) {
    juce::MemoryOutputStream stream(destination, false);
    stream.write(stateMagic, sizeof(stateMagic));
    stream.writeInt(static_cast<int>(futureState_->get() ? futureStateVersion : stateVersion));
    stream.writeFloat(gain_->get());
    stream.writeByte(latency_->get() ? 1 : 0);
}

void Processor::setStateInformation(const void* data, int sizeInBytes) {
    if (sizeInBytes < 0 || static_cast<std::size_t>(sizeInBytes) != stateSize ||
        std::memcmp(data, stateMagic, sizeof(stateMagic)) != 0) {
        return;
    }
    juce::MemoryInputStream stream(data, static_cast<std::size_t>(sizeInBytes), false);
    stream.skipNextBytes(sizeof(stateMagic));
    if (static_cast<std::uint32_t>(stream.readInt()) != stateVersion) {
        return;  // a version this plugin does not know changes nothing
    }
    *gain_ = stream.readFloat();
    *latency_ = stream.readByte() != 0;
}

}  // namespace siann::test_plugin

// The entry point every JUCE plugin wrapper links against.
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
    return new siann::test_plugin::Processor();
}
