#include "device.hpp"
#include "siann/host/juce_audio_device.hpp"

namespace siann::engine_app {

std::unique_ptr<host::AudioDevice> hardwareDevice() {
    return std::make_unique<host::JuceAudioDevice>();
}

}  // namespace siann::engine_app
