#pragma once

// The envelope around a plugin's own state, the same for every format, little
// endian: magic "SIANNPS1", version u32, uid length u32, uid, payload length u64,
// payload.

#include <cstdint>
#include <span>
#include <string>
#include <vector>

namespace siann::host {

std::vector<std::uint8_t> wrapPluginState(const std::string& uid, std::span<const std::uint8_t> payload);

// The payload inside `state`, which it points into. Throws PluginError bad_state on
// anything getState of the plugin named `uid` did not produce: not a blob, another
// version, another plugin, truncated.
std::span<const std::uint8_t> unwrapPluginState(std::span<const std::uint8_t> state, const std::string& uid);

}  // namespace siann::host
