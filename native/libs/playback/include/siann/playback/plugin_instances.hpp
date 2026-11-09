#pragma once

// Hosted plugins of the live graph and of a render (architecture spec,
// "State migration", "Threads and waiting rules" and "Commands and jobs", Jobs
// v0, plugins; m4-plugin-node).
//
// PluginInstanceTable maps a slot id to its entry: the loaded instance (or
// none: the slot is missing and passes audio through, its state blob kept in
// the document), the slot as the document has it, an error, the PluginNode
// counters (an rt::CallbackTimer per instance, so they outlive recompiles) and
// the pins. Every graph that holds a slot's node pins the entry, by the epoch
// GraphDriver::publish returned; retired(epoch) releases the pins, and an entry
// whose slot left the document is destroyed on the control thread once nothing
// pins it. So an instance survives every edit that keeps its slot: the next
// compile builds a new node around the same instance. Pins name the entry,
// not the slot id: a slot id that comes back with another plugin or state (a
// client's plugin.insert may reuse a removed id) gets a new entry at once, and
// the old one, out of the table's lookups, keeps processing in the graphs that
// pin it until they retired.
//
// Plugin events: each entry's sink pushes {entry, event} into one bounded
// rt::MpscQueue (pluginEventAny) and does nothing else; it runs on whatever
// thread the plugin reports from, the audio thread included, under the
// hosting wrapper's locks. tick() drains it on the control thread: a latency
// change needs nothing here (the node reports instance->latencyFrames() to the
// graph at its next block, and the driver recompiles); a restart calls
// pollStale() and reads the parameters again; a parameter edit is counted and
// dropped. A full queue sets the entry's resync flag; the tick then reads that
// entry's latency and parameters again.
//
// setBlocksComing(true) when the driver's device starts, false once it stopped
// (stop(), device_lost); an instance pinned while blocks are coming is told at
// once.
//
// Everything here runs on the control thread (the engine's main thread), except
// the sinks and the timers' writers.

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "siann/engine/offline.hpp"
#include "siann/graph/plugin_node.hpp"
#include "siann/host/interfaces.hpp"
#include "siann/host/plugin_registry.hpp"
#include "siann/model/document.hpp"
#include "siann/rt/callback_timer.hpp"
#include "siann/rt/mpsc_queue.hpp"

namespace siann::playback {

// The plugin hosts by format ("clap", "vst3", "au"); a format without one loads
// nothing (no_plugin_host).
using PluginHosts = std::map<std::string, host::PluginHost*>;

struct PluginProblem {
    std::string code;
    std::string message;
};

struct PluginInstanceStatus {
    std::string slotId;
    std::string trackId;
    std::string format;
    std::string uid;
    bool running = false;  // false: missing
    std::optional<PluginProblem> error;
    // The rest is empty or zero for a missing plugin.
    std::optional<host::PluginCapabilities> capabilities;
    int latencyFrames = 0;
    int tailFrames = 0;
    std::uint64_t callbacks = 0;
    std::uint64_t xruns = 0;
    std::uint64_t unmeasuredCallbacks = 0;
    std::int64_t maxCallbackNanos = 0;
    std::uint64_t midiOutputOverflows = 0;
    std::uint64_t midiOutputSysex = 0;
};

namespace detail {

// One report in pluginEventAny. At namespace scope so GCC sees the default member
// initializers when the queue checks its traits inside PluginInstanceTable.
struct IndexedPluginEvent {
    std::uint64_t entry = 0;
    host::PluginEvent event;
};

}  // namespace detail

// <bundle>/blobs/<hex> for "sha256:<hex>". Anything but "sha256:" and 64 lowercase
// hex digits (model::isStateBlobHash) throws host::PluginError("bad_state"), so a
// blob never names a file outside <bundle>/blobs.
std::filesystem::path blobPath(const std::filesystem::path& bundle, const std::string& stateBlob);

struct LoadedPlugin {
    std::unique_ptr<host::PluginInstance> instance;  // nullptr: missing
    std::optional<PluginProblem> error;              // why missing, or state_missing / bad_state
};

// Instantiates a slot's plugin and restores its state blob from <bundle>/blobs.
// Main thread. The plugin is the install `registry` resolves the slot's {format,
// uid} to (m5-plugin-registry, Protocol v0 item 21): the slot's path is only a
// hint between approved installs, never opened itself; a hint on a UNC path or
// inside the bundle is refused. No approved install: missing, plugin_not_registered
// or plugin_not_approved; a null registry registers nothing. A blob that is not
// there loads the default state (state_missing).
LoadedPlugin loadPlugin(const model::PluginSlot& slot, const PluginHosts& hosts, const host::PluginRegistry* registry,
                        const std::filesystem::path& bundle, std::int64_t sampleRate, int maxBlockFrames);

class PluginInstanceTable final : public engine::PluginNodeSource {
public:
    // `registry` (may be null: nothing loads) must outlive the table.
    PluginInstanceTable(PluginHosts hosts, const host::PluginRegistry* registry, std::filesystem::path bundle,
                        std::int64_t sampleRate, int maxBlockFrames, std::size_t eventCapacity = 1024);
    ~PluginInstanceTable() override;
    PluginInstanceTable(const PluginInstanceTable&) = delete;
    PluginInstanceTable& operator=(const PluginInstanceTable&) = delete;

    // An entry for every slot of the document (loading the new ones), the
    // others marked for destruction once nothing pins them.
    void sync(const model::Document& document);
    // An instance plugin.instantiate loaded for a slot about to be inserted, so
    // the next compile reuses it instead of loading the plugin again.
    void adopt(const model::PluginSlot& slot, std::unique_ptr<host::PluginInstance> instance,
               std::optional<PluginProblem> error = std::nullopt);

    // engine::PluginNodeSource: a timed node around the slot's instance, or
    // nullptr for a missing plugin. Records the slot for pinCompiled().
    std::unique_ptr<graph::Node> pluginNode(const model::PluginSlot& slot, int channels) const override;
    // The slots of the nodes made since the last call belong to the graph just
    // compiled: pinned until it is published and then retired.
    void pinCompiled();
    // That graph was published with `epoch`.
    void published(std::uint64_t epoch);
    // The graph family of `epoch` retired: releases its pins, destroys what
    // nothing pins and no document holds.
    void retired(std::uint64_t epoch);

    void setBlocksComing(bool coming);
    // Drains pluginEventAny and polls every instance (pollStale).
    void tick();

    host::PluginInstance* instance(std::string_view slotId) const noexcept;
    // Parameter indices below this reach the slot's node as block events: the
    // instance's parameter count when it was installed (0 for an unknown slot).
    std::size_t pendingParameterCapacity(std::string_view slotId) const noexcept;
    std::optional<PluginInstanceStatus> status(std::string_view slotId) const;
    // One per slot of the document, in track then insert order.
    std::vector<PluginInstanceStatus> status(const model::Document& document) const;
    // What the instance was last told by setBlocksComing; empty when never.
    std::optional<bool> blocksComingTold(std::string_view slotId) const;
    // Graphs (published or about to be) holding the node of the slot's entry.
    std::size_t pins(std::string_view slotId) const;
    std::size_t size() const noexcept { return entries_.size(); }

    std::uint64_t resyncs() const noexcept { return resyncs_; }
    std::uint64_t restartsSeen() const noexcept { return restarts_; }
    std::uint64_t parameterEdits() const noexcept { return parameterEdits_; }

private:
    struct Entry {
        model::PluginSlot slot;
        std::uint64_t index = 0;
        std::optional<PluginProblem> error;
        bool inDocument = true;
        bool adopted = false;
        std::optional<bool> blocksComing;
        std::atomic<bool> resync{false};
        rt::CallbackTimer timer;
        // Parameter values on their way to the instance: shared by every node made for
        // it, so a recompile does not lose one before its block. Sized at install to
        // the instance's parameter count, so none set while stopped is dropped.
        graph::PendingParameters parameters;
        // Last: destroyed first, so no sink runs into a destroyed entry.
        std::unique_ptr<host::PluginInstance> instance;
    };
    Entry& install(const model::PluginSlot& slot, LoadedPlugin loaded);
    void tell(Entry& entry, bool coming);
    void resync(Entry& entry);
    bool pinned(std::uint64_t index) const;
    void release(Entry& entry);
    void collect();

    PluginHosts hosts_;
    const host::PluginRegistry* registry_;
    std::filesystem::path bundle_;
    std::int64_t sampleRate_;
    int maxBlockFrames_;
    rt::MpscQueue<detail::IndexedPluginEvent> events_;
    std::map<std::string, std::unique_ptr<Entry>, std::less<>> entries_;
    // Entries a newer one replaced under their slot id while a graph pinned
    // them: they keep processing in that graph until it retired.
    std::vector<std::unique_ptr<Entry>> superseded_;
    std::map<std::uint64_t, Entry*> byIndex_;
    std::uint64_t nextIndex_ = 1;
    // Pins by entry index.
    mutable std::set<std::uint64_t> compiling_;
    std::vector<std::set<std::uint64_t>> pending_;  // compiled, not yet published
    std::map<std::uint64_t, std::set<std::uint64_t>> epochPins_;
    bool blocksComing_ = false;
    std::uint64_t resyncs_ = 0;
    std::uint64_t restarts_ = 0;
    std::uint64_t parameterEdits_ = 0;
};

// The instances a render.start drives on the offline-render thread (Jobs v0,
// plugins): one per slot, loaded on the control thread from the slot's state
// blob, never shared with the live graph. A slot that does not load renders as
// pass-through. Destroyed on the control thread, after the render.
class RenderInstanceSet final : public engine::PluginNodeSource {
public:
    // Loads through `registry` as the live table does (loadPlugin).
    RenderInstanceSet(const model::Document& document, const PluginHosts& hosts, const host::PluginRegistry* registry,
                      const std::filesystem::path& bundle, int maxBlockFrames);
    ~RenderInstanceSet() override;

    // An untimed node, or nullptr for a slot that did not load.
    std::unique_ptr<graph::Node> pluginNode(const model::PluginSlot& slot, int channels) const override;
    host::PluginInstance* instance(std::string_view slotId) const noexcept;
    // Why a slot renders dry.
    const std::map<std::string, PluginProblem>& failures() const noexcept { return failures_; }

private:
    std::int64_t sampleRate_;
    std::map<std::string, std::unique_ptr<host::PluginInstance>, std::less<>> instances_;
    std::map<std::string, PluginProblem> failures_;
};

}  // namespace siann::playback
