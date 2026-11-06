#pragma once

// The one thing siann_test_plugin needs from the VST3 SDK: asking the host for a
// restart JUCE's wrapper never asks for by itself. The SDK stays in the .cpp.

#include <juce_audio_processors/juce_audio_processors.h>

namespace siann::test_plugin {

class Vst3Restarter final : public juce::VST3ClientExtensions {
public:
    void setIComponentHandler(Steinberg::FUnknown* handler) override { handler_ = handler; }
    // Message thread. Does nothing outside a VST3 host.
    void restart();

private:
    Steinberg::FUnknown* handler_ = nullptr;
};

}  // namespace siann::test_plugin
