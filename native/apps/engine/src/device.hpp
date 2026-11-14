#pragma once

// The build's real audio device (device_desktop.cpp, device_core.cpp).

#include <memory>
#include <vector>

#include "siann/host/interfaces.hpp"
#include "siann/protocol/transport_port.hpp"

namespace siann::engine_app {

// Throws host::DeviceError: a core-only build has no_audio_backend.
std::unique_ptr<host::AudioDevice> hardwareDevice();

// The output devices hardwareDevice() can open, id "<type>/<name>" as --device
// takes it (the enumeration siann-cli devices prints), then the input devices
// that are no output device (outputChannels 0: an inputId only); current is
// left false and channel counts unknown. Empty in a core-only build.
std::vector<protocol::DeviceDescription> listHardwareDevices();

}  // namespace siann::engine_app
