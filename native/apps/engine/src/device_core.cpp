#include "device.hpp"

namespace siann::engine_app {

std::unique_ptr<host::AudioDevice> hardwareDevice() {
    throw host::DeviceError("no_audio_backend",
                            "this siann-engine was built without an audio backend (configure with SIANN_WITH_JUCE=ON, "
                            "desktop preset); use --device fake");
}

std::vector<protocol::DeviceDescription> listHardwareDevices() {
    return {};
}

}  // namespace siann::engine_app
