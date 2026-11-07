#include "siann/host/clap_plugin_host.hpp"

// A stub until the implementation lands: the tests below it fail for that reason.

namespace siann::host {

struct ClapPluginHost::Impl {};

ClapPluginHost::ClapPluginHost() : impl_(std::make_unique<Impl>()) {}
ClapPluginHost::~ClapPluginHost() = default;

std::vector<PluginDescriptor> ClapPluginHost::scan() { throw PluginError("plugin_load_failed", "not implemented"); }

std::vector<PluginDescriptor> ClapPluginHost::scanPath(const std::string&) {
    throw PluginError("plugin_load_failed", "not implemented");
}

std::unique_ptr<PluginInstance> ClapPluginHost::instantiate(const PluginDescriptor&, std::int64_t, int) {
    throw PluginError("plugin_load_failed", "not implemented");
}

void ClapPluginHost::runMainThreadCallbacks() {}

void ClapPluginHost::setWakeHandler(std::function<void()>) {}

}  // namespace siann::host
