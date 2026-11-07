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
    // editor_failed.
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

}  // namespace siann::host
