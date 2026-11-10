#include "device.hpp"
#include "siann/host/juce_audio_device.hpp"

namespace siann::engine_app {

std::unique_ptr<host::AudioDevice> hardwareDevice() {
    return std::make_unique<host::JuceAudioDevice>();
}

std::vector<protocol::DeviceDescription> listHardwareDevices() {
    std::vector<protocol::DeviceDescription> out;
    for (const host::DeviceDescription& one : host::JuceAudioDevice::listOutputDevices()) {
        out.push_back({one.type + "/" + one.name, one.type, one.name, one.isDefault, false});
    }
    return out;
}

}  // namespace siann::engine_app
