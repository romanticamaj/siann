#pragma once

// The protocol server's way to the engine's plugin hosts (architecture spec,
// "siann-protocol", Protocol v0 item 19; "Commands and jobs", Jobs v0,
// plugins; m4-plugin-node). siann-protocol links no plugin host: the engine host
// implements this interface, as it does TransportPort, and hands it over in
// ServerOptions::pluginPort. Every call runs on the command thread (the
// engine's main thread in M4).

#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "siann/engine/offline.hpp"
#include "siann/model/document.hpp"

namespace siann::protocol {

struct PluginDescriptorInfo {
    std::string format;  // clap, vst3, au or lv2
    std::string uid;     // empty before the probe
    std::string name;
    std::string path;
};

// The six PluginHost capability flags.
struct PluginCapabilityFlags {
    bool sampleAccurateParameters = false;
    bool midiInput = false;
    bool midiOutput = false;
    bool sidechain = false;
    bool variableLatency = false;
    bool editor = false;
};

struct PluginInstantiateRequest {
    std::string slotId;   // chosen by the server, unused in the head document
    std::string trackId;  // exists in the head document
    std::int64_t index = 0;
    PluginDescriptorInfo descriptor;
    // A blob already in <bundle>/blobs to restore ("sha256:<hex>"); empty: the
    // plugin's default state, which the port returns in `state`.
    std::optional<std::string> stateBlob;
};

struct PluginInstantiateResult {
    PluginDescriptorInfo descriptor;  // as probed: the uid filled in
    // The default state the new instance saved (getState), when no blob was given;
    // the server writes it to <bundle>/blobs/<sha256 hex>.
    std::optional<std::vector<std::uint8_t>> state;
    int latencyFrames = 0;
    int tailFrames = 0;
    PluginCapabilityFlags capabilities;
};

struct PluginEditorState {
    std::string slotId;
    bool editorOpen = false;
    std::uint64_t nativeHandle = 0;  // the editor's top-level window; 0 when closed
};

// One plugin slot of the heard document, for engine.status plugins[].
struct PluginStatus {
    std::string slotId;
    std::string trackId;
    std::string format;
    std::string uid;
    bool running = false;  // false: "missing"
    std::optional<std::pair<std::string, std::string>> error;  // {code, message}
    // Empty for a missing plugin (JSON null).
    std::optional<PluginCapabilityFlags> capabilities;
    std::optional<int> latencyFrames;
    std::optional<int> tailFrames;
    std::optional<std::uint64_t> callbacks;
    std::optional<std::uint64_t> xruns;
    std::optional<double> maxCallbackMicros;
    std::optional<std::uint64_t> unmeasuredCallbacks;
    std::optional<std::uint64_t> midiOutputOverflows;
};

// Thrown by a port. Codes: not_found (no such slot), plugin_missing (the slot's
// plugin did not load), editor_failed, no_plugin_host, plugin_load_failed,
// plugin_not_found, bad_state.
class PluginPortError : public std::runtime_error {
public:
    PluginPortError(std::string code, const std::string& message)
        : std::runtime_error(message), code_(std::move(code)) {}

    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

class PluginPort {
public:
    virtual ~PluginPort() = default;

    // Probes and instantiates the plugin and holds the instance for
    // request.slotId until settle(). Throws PluginPortError.
    virtual PluginInstantiateResult instantiate(const PluginInstantiateRequest& request) = 0;
    // After the server's plugin.insert commit: inserted, the held instance
    // enters the instance table under the slot (described by `slot`), so the next
    // compile reuses it; otherwise it is destroyed.
    virtual void settle(const model::PluginSlot& slot, bool inserted) = 0;

    virtual PluginEditorState openEditor(const std::string& slotId) = 0;
    virtual PluginEditorState closeEditor(const std::string& slotId) = 0;

    // One per plugin slot of the heard document.
    virtual std::vector<PluginStatus> plugins() const = 0;
    // The formats this engine hosts ("clap", and "vst3" and "au" with JUCE).
    virtual std::vector<std::string> formats() const = 0;

    // render.start: one instance per slot of `document`, loaded from the slots'
    // state blobs on the command thread, for the render job to drive on the
    // offline-render thread. A slot that does not load passes through.
    virtual std::shared_ptr<engine::PluginNodeSource> instantiateForRender(const model::Document& document) = 0;
    // The set back on the command thread after its job ended, for destruction.
    virtual void destroyRenderInstances(std::shared_ptr<engine::PluginNodeSource> instances) = 0;
};

}  // namespace siann::protocol
