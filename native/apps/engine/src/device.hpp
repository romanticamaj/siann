#pragma once

// The build's real audio device (device_desktop.cpp, device_core.cpp).

#include <memory>

#include "siann/host/interfaces.hpp"

namespace siann::engine_app {

// Throws host::DeviceError: a core-only build has no_audio_backend.
std::unique_ptr<host::AudioDevice> hardwareDevice();

}  // namespace siann::engine_app
