#pragma once

// PluginHost backed by JUCE (architecture spec, "siann-host"; ADR-0017): VST3
// everywhere, AU on macOS. JUCE stays behind this header: callers never include
// JUCE. Everything here runs on the main thread except what interfaces.hpp says
// otherwise.
//
// State blobs are the envelope of state_envelope.hpp.

#include <chrono>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "siann/host/interfaces.hpp"
#include "siann/host/plugin_error.hpp"

namespace siann::host {

// The process's main thread as JUCE's message thread (architecture spec,
// "Process model"). Construct it on the main thread before any plugin and keep
// it for as long as plugins live. On macOS the engine starts as an accessory
// application.
class MainThreadLoop {
public:
    MainThreadLoop();
    ~MainThreadLoop();
    MainThreadLoop(const MainThreadLoop&) = delete;
    MainThreadLoop& operator=(const MainThreadLoop&) = delete;

    // Dispatches messages until predicate holds; false when timeout came first.
    bool runUntil(const std::function<bool()>& predicate, std::chrono::milliseconds timeout);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

class JucePluginHost final : public PluginHost {
public:
    JucePluginHost();
    ~JucePluginHost() override;
    JucePluginHost(const JucePluginHost&) = delete;
    JucePluginHost& operator=(const JucePluginHost&) = delete;

    std::vector<PluginDescriptor> scan(const std::vector<std::string>& extraDirectories = {}) override;
    // Throws plugin_not_found when the path does not exist and plugin_load_failed
    // when it holds no plugin this host can load.
    std::vector<PluginDescriptor> scanPath(const std::string& path) override;
    // Loads the bundle at the descriptor's path, never another install of the same
    // uid. Without a path the uid must have exactly one known install. Throws
    // plugin_not_found when neither names a plugin and plugin_load_failed when it
    // does not load.
    std::unique_ptr<PluginInstance> instantiate(const PluginDescriptor& descriptor, std::int64_t sampleRate,
                                                int maxBlockFrames) override;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

namespace testing {

// Tests only: reports a processor change through the instance's listener on the
// calling thread, as a plugin that reports from that thread does. Throws
// bad_parameter for an instance of another host.
void reportProcessorChange(PluginInstance& instance, bool latency, bool parameterInfo, bool program);

}  // namespace testing

}  // namespace siann::host
