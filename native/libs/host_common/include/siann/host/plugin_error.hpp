#pragma once

// The error every PluginHost throws, whichever format it hosts.

#include <stdexcept>
#include <string>
#include <utility>

namespace siann::host {

class PluginError : public std::runtime_error {
public:
    PluginError(std::string code, const std::string& message) : std::runtime_error(message), code_(std::move(code)) {}

    // One of: plugin_not_found, plugin_load_failed, bad_state, bad_parameter,
    // editor_failed, plugin_failed (the instance failed when its plugin threw, and
    // is replaced, never revived), and, from the engine's plugin registry rather
    // than a host (m5-plugin-registry, Protocol v0 item 21), plugin_not_registered
    // (no approved install of the uid, or a path no install has) and
    // plugin_not_approved (registered, not approved).
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

}  // namespace siann::host
