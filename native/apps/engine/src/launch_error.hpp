#pragma once

#include <stdexcept>
#include <string>
#include <utility>

namespace siann::engine_app {

// A launch the engine refuses: exit 1 with {ok:false, error:{code, message}}.
class LaunchError : public std::runtime_error {
public:
    LaunchError(std::string code, const std::string& message) : std::runtime_error(message), code_(std::move(code)) {}
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

}  // namespace siann::engine_app
