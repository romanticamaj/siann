#include "siann/host/juce_plugin_host.hpp"

namespace siann::host {

struct MainThreadLoop::Impl {};

MainThreadLoop::MainThreadLoop() = default;
MainThreadLoop::~MainThreadLoop() = default;

bool MainThreadLoop::runUntil(const std::function<bool()>&, std::chrono::milliseconds) {
    return false;
}

struct JucePluginHost::Impl {};

JucePluginHost::JucePluginHost() = default;
JucePluginHost::~JucePluginHost() = default;

std::vector<PluginDescriptor> JucePluginHost::scan() {
    throw PluginError("plugin_load_failed", "not implemented");
}

std::vector<PluginDescriptor> JucePluginHost::scanPath(const std::string&) {
    throw PluginError("plugin_load_failed", "not implemented");
}

std::unique_ptr<PluginInstance> JucePluginHost::instantiate(const PluginDescriptor&, std::int64_t, int) {
    throw PluginError("plugin_load_failed", "not implemented");
}

}  // namespace siann::host
