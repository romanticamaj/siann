#include "device.hpp"

#include <algorithm>
#include <string>
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
    // Input devices that are no output device (m5b-engine-record): usable as an
    // inputId only. Channel counts stay unknown here: the engine counts them on
    // the device it has open, never by creating another driver instance.
    for (const host::DeviceDescription& one : host::JuceAudioDevice::listInputDevices()) {
        const std::string id = one.type + "/" + one.name;
        const bool listed = std::any_of(out.begin(), out.end(),
                                        [&](const protocol::DeviceDescription& entry) { return entry.id == id; });
        if (!listed) {
            protocol::DeviceDescription input{id, one.type, one.name, false, false};
            input.outputChannels = 0;
            out.push_back(std::move(input));
        }
    }
    return out;
}

}  // namespace siann::engine_app
