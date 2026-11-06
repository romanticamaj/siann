#pragma once

// PluginHost backed by JUCE (architecture spec, "siann-host"; ADR-0017): VST3
// everywhere, AU on macOS. JUCE stays behind this header: callers never include
// JUCE. Everything here runs on the main thread except what interfaces.hpp says
// otherwise.
//
// State blobs are an envelope around the plugin's own state, little endian:
// magic "SIANNPS1", version u32, uid length u32, uid, payload length u64, payload.

#include <chrono>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "siann/host/interfaces.hpp"

namespace siann::host {

class PluginError : public std::runtime_error {
public:
    PluginError(std::string code, const std::string& message) : std::runtime_error(message), code_(std::move(code)) {}

    // One of: plugin_not_found, plugin_load_failed, bad_state, editor_failed.
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

// The process's main thread as JUCE's message thread (architecture spec,
// "Process model"). Construct it on the main thread, before any plugin and after
// nothing else that uses JUCE, and keep it for as long as plugins live. On macOS
// the engine starts as an accessory application.
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

    std::vector<PluginDescriptor> scan() override;
    // Throws plugin_not_found when the path does not exist and plugin_load_failed
    // when it holds no plugin this host can load.
    std::vector<PluginDescriptor> scanPath(const std::string& path) override;
    // Throws plugin_not_found when the descriptor's format is unknown here and
    // plugin_load_failed when the plugin does not load.
    std::unique_ptr<PluginInstance> instantiate(const PluginDescriptor& descriptor, std::int64_t sampleRate,
                                                int maxBlockFrames) override;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::host
