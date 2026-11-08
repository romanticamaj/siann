#include "siann/playback/plugin_instances.hpp"

#include <algorithm>
#include <utility>

#include "siann/host/plugin_error.hpp"
#include "siann/io/durable_file.hpp"

namespace siann::playback {

namespace {

host::PluginDescriptor descriptorOf(const model::PluginSlot& slot) {
    host::PluginDescriptor descriptor;
    descriptor.format = slot.format;
    descriptor.uid = slot.uid;
    descriptor.name = slot.name;
    descriptor.path = slot.path;
    return descriptor;
}

}  // namespace

std::filesystem::path blobPath(const std::filesystem::path& bundle, const std::string& stateBlob) {
    constexpr std::string_view prefix = "sha256:";
    const std::string hex = stateBlob.rfind(prefix, 0) == 0 ? stateBlob.substr(prefix.size()) : stateBlob;
    return bundle / "blobs" / hex;
}

LoadedPlugin loadPlugin(const model::PluginSlot& slot, const PluginHosts& hosts, const std::filesystem::path& bundle,
                        std::int64_t sampleRate, int maxBlockFrames) {
    LoadedPlugin loaded;
    const auto host = hosts.find(slot.format);
    if (host == hosts.end() || host->second == nullptr) {
        loaded.error = PluginProblem{"no_plugin_host", "this engine hosts no " + slot.format + " plugins"};
        return loaded;
    }
    try {
        loaded.instance = host->second->instantiate(descriptorOf(slot), sampleRate, maxBlockFrames);
    } catch (const host::PluginError& error) {
        loaded.error = PluginProblem{error.code(), error.what()};
        return loaded;
    } catch (const std::exception& error) {
        loaded.error = PluginProblem{"plugin_load_failed", error.what()};
        return loaded;
    }
    if (slot.stateBlob) {
        const std::filesystem::path file = blobPath(bundle, *slot.stateBlob);
        std::error_code ec;
        if (!std::filesystem::exists(file, ec)) {
            loaded.error = PluginProblem{"state_missing", "the state blob " + *slot.stateBlob +
                                                              " is not in the bundle; the plugin has its default state"};
            return loaded;
        }
        try {
            const std::string bytes = io::readFile(file);
            loaded.instance->control().setState(std::vector<std::uint8_t>(bytes.begin(), bytes.end()));
        } catch (const host::PluginError& error) {
            loaded.error = PluginProblem{error.code(), error.what()};
        } catch (const std::exception& error) {
            loaded.error = PluginProblem{"bad_state", error.what()};
        }
    }
    return loaded;
}

// ---- PluginInstanceTable ---------------------------------------------------

PluginInstanceTable::PluginInstanceTable(PluginHosts hosts, std::filesystem::path bundle, std::int64_t sampleRate,
                                         int maxBlockFrames, std::size_t eventCapacity)
    : hosts_(std::move(hosts)),
      bundle_(std::move(bundle)),
      sampleRate_(sampleRate),
      maxBlockFrames_(maxBlockFrames),
      events_(std::max<std::size_t>(eventCapacity, 1)) {}

PluginInstanceTable::~PluginInstanceTable() {
    for (auto& [id, entry] : entries_) {
        if (entry->instance) {
            entry->instance->control().setEventSink(nullptr);
        }
    }
    for (auto& entry : superseded_) {
        if (entry->instance) {
            entry->instance->control().setEventSink(nullptr);
        }
    }
}

// Detaches the entry's sink and forgets its index; the caller destroys it. On
// the control thread, at zero pins.
void PluginInstanceTable::release(Entry& entry) {
    if (entry.instance) {
        entry.instance->control().setEventSink(nullptr);
    }
    byIndex_.erase(entry.index);
}

PluginInstanceTable::Entry& PluginInstanceTable::install(const model::PluginSlot& slot, LoadedPlugin loaded) {
    auto entry = std::make_unique<Entry>();
    entry->slot = slot;
    entry->index = nextIndex_++;
    entry->error = std::move(loaded.error);
    entry->instance = std::move(loaded.instance);
    Entry* raw = entry.get();
    if (raw->instance) {
        // Before any node holds the set: room for a value of every parameter.
        raw->parameters.resize(raw->instance->control().parameters().size());
        // pluginEventAny: the sink pushes and does nothing else (any thread).
        rt::MpscQueue<detail::IndexedPluginEvent>* queue = &events_;
        std::atomic<bool>* resyncFlag = &raw->resync;
        const std::uint64_t index = raw->index;
        raw->instance->control().setEventSink([queue, resyncFlag, index](const host::PluginEvent& event) {
            if (!queue->push(detail::IndexedPluginEvent{index, event})) {
                resyncFlag->store(true, std::memory_order_release);
            }
        });
    }
    byIndex_[raw->index] = raw;
    const auto previous = entries_.find(slot.id);
    if (previous != entries_.end()) {
        if (pinned(previous->second->index)) {
            // A graph still processes it: it goes once that graph retired.
            superseded_.push_back(std::move(previous->second));
        } else {
            release(*previous->second);
        }
    }
    entries_.insert_or_assign(slot.id, std::move(entry));
    return *raw;
}

void PluginInstanceTable::sync(const model::Document& document) {
    std::set<std::string> present;
    for (const model::PluginSlot* slot : document.allPluginSlots()) {
        present.insert(slot->id);
        const auto found = entries_.find(slot->id);
        if (found != entries_.end()) {
            Entry& entry = *found->second;
            const bool samePlugin = entry.slot.format == slot->format && entry.slot.uid == slot->uid &&
                                    entry.slot.path == slot->path && entry.slot.stateBlob == slot->stateBlob;
            if (samePlugin) {
                entry.slot = *slot;  // bypass and name follow the document
                entry.inDocument = true;
                entry.adopted = false;
                continue;
            }
        }
        install(*slot, loadPlugin(*slot, hosts_, bundle_, sampleRate_, maxBlockFrames_));
    }
    for (auto& [id, entry] : entries_) {
        entry->inDocument = present.count(id) != 0;
    }
    collect();
}

void PluginInstanceTable::adopt(const model::PluginSlot& slot, std::unique_ptr<host::PluginInstance> instance,
                                std::optional<PluginProblem> error) {
    LoadedPlugin loaded;
    loaded.instance = std::move(instance);
    loaded.error = std::move(error);
    // A pinned entry under the same id is superseded, not kept: the slot is
    // this plugin from now on.
    Entry& entry = install(slot, std::move(loaded));
    entry.inDocument = false;
    entry.adopted = true;  // kept until a synced document holds it
}

std::unique_ptr<graph::Node> PluginInstanceTable::pluginNode(const model::PluginSlot& slot, int channels) const {
    const auto found = entries_.find(slot.id);
    if (found == entries_.end() || !found->second->instance) {
        return nullptr;
    }
    Entry& entry = *found->second;
    auto node = std::make_unique<graph::PluginNode>(*entry.instance, channels, sampleRate_, true, &graph::steadyNowNanos,
                                                    &entry.timer, &entry.parameters);
    node->setBypass(slot.bypass);
    compiling_.insert(entry.index);
    return node;
}

void PluginInstanceTable::pinCompiled() {
    pending_.push_back(std::move(compiling_));
    compiling_.clear();
    if (blocksComing_) {
        for (const std::uint64_t index : pending_.back()) {
            tell(*byIndex_.at(index), true);
        }
    }
}

void PluginInstanceTable::published(std::uint64_t epoch) {
    if (pending_.empty()) {
        return;
    }
    epochPins_[epoch] = std::move(pending_.front());
    pending_.erase(pending_.begin());
}

void PluginInstanceTable::retired(std::uint64_t epoch) {
    epochPins_.erase(epoch);
    collect();
}

bool PluginInstanceTable::pinned(std::uint64_t index) const {
    for (const auto& [epoch, indices] : epochPins_) {
        if (indices.count(index) != 0) {
            return true;
        }
    }
    for (const auto& indices : pending_) {
        if (indices.count(index) != 0) {
            return true;
        }
    }
    return compiling_.count(index) != 0;
}

std::size_t PluginInstanceTable::pins(std::string_view slotId) const {
    const auto found = entries_.find(slotId);
    if (found == entries_.end()) {
        return 0;
    }
    const std::uint64_t index = found->second->index;
    std::size_t count = 0;
    for (const auto& [epoch, indices] : epochPins_) {
        count += indices.count(index);
    }
    for (const auto& indices : pending_) {
        count += indices.count(index);
    }
    return count;
}

// On the control thread only, at zero pins.
void PluginInstanceTable::collect() {
    for (auto it = entries_.begin(); it != entries_.end();) {
        Entry& entry = *it->second;
        if (!entry.inDocument && !entry.adopted && !pinned(entry.index)) {
            release(entry);
            it = entries_.erase(it);
        } else {
            ++it;
        }
    }
    for (auto it = superseded_.begin(); it != superseded_.end();) {
        if (!pinned((*it)->index)) {
            release(**it);
            it = superseded_.erase(it);
        } else {
            ++it;
        }
    }
}

void PluginInstanceTable::tell(Entry& entry, bool coming) {
    if (entry.instance && entry.blocksComing != coming) {
        entry.instance->setBlocksComing(coming);
        entry.blocksComing = coming;
    }
}

void PluginInstanceTable::setBlocksComing(bool coming) {
    blocksComing_ = coming;
    const auto update = [this, coming](Entry& entry) {
        if (coming ? pinned(entry.index) : entry.blocksComing == std::optional<bool>{true}) {
            tell(entry, coming);
        }
    };
    for (auto& [id, entry] : entries_) {
        update(*entry);
    }
    for (auto& entry : superseded_) {
        update(*entry);
    }
}

void PluginInstanceTable::resync(Entry& entry) {
    if (entry.instance) {
        entry.instance->control().pollStale();
        (void)entry.instance->control().parameters();
    }
}

void PluginInstanceTable::tick() {
    detail::IndexedPluginEvent item;
    while (events_.pop(item)) {
        const auto found = byIndex_.find(item.entry);
        if (found == byIndex_.end()) {
            continue;  // the entry went after its plugin reported
        }
        Entry& entry = *found->second;
        switch (item.event.kind) {
            case host::PluginEvent::Kind::latencyChanged:
                // The node reads latencyFrames() at its next block; the graph
                // reports the change and the driver recompiles.
                break;
            case host::PluginEvent::Kind::restartRequested:
                ++restarts_;
                resync(entry);
                break;
            case host::PluginEvent::Kind::parameterEdited:
                ++parameterEdits_;  // counted and dropped until automation reads them
                break;
            case host::PluginEvent::Kind::failed:
                // The instance passes its input through; the command layer replaces it.
                entry.error = PluginProblem{"plugin_failed", "the plugin failed and passes its input through"};
                break;
        }
    }
    const auto service = [this](Entry& entry) {
        if (entry.resync.exchange(false, std::memory_order_acq_rel)) {
            ++resyncs_;
            resync(entry);
        } else if (entry.instance) {
            entry.instance->control().pollStale();
        }
    };
    for (auto& [id, entry] : entries_) {
        service(*entry);
    }
    for (auto& entry : superseded_) {
        service(*entry);
    }
}

host::PluginInstance* PluginInstanceTable::instance(std::string_view slotId) const noexcept {
    const auto found = entries_.find(slotId);
    return found == entries_.end() ? nullptr : found->second->instance.get();
}

std::size_t PluginInstanceTable::pendingParameterCapacity(std::string_view slotId) const noexcept {
    const auto found = entries_.find(slotId);
    return found == entries_.end() ? 0 : found->second->parameters.capacity();
}

std::optional<bool> PluginInstanceTable::blocksComingTold(std::string_view slotId) const {
    const auto found = entries_.find(slotId);
    return found == entries_.end() ? std::nullopt : found->second->blocksComing;
}

std::optional<PluginInstanceStatus> PluginInstanceTable::status(std::string_view slotId) const {
    const auto found = entries_.find(slotId);
    if (found == entries_.end()) {
        return std::nullopt;
    }
    const Entry& entry = *found->second;
    PluginInstanceStatus out;
    out.slotId = entry.slot.id;
    out.trackId = entry.slot.trackId;
    out.format = entry.slot.format;
    out.uid = entry.slot.uid;
    out.error = entry.error;
    if (entry.instance) {
        out.running = true;
        out.capabilities = entry.instance->capabilities();
        out.latencyFrames = entry.instance->latencyFrames();
        out.tailFrames = entry.instance->tailFrames();
        out.callbacks = entry.timer.callbacks();
        out.xruns = entry.timer.misses();
        out.unmeasuredCallbacks = entry.timer.unmeasured();
        out.maxCallbackNanos = entry.timer.maxCallbackNanos();
        out.midiOutputOverflows = entry.instance->midiOutputOverflows();
    }
    return out;
}

std::vector<PluginInstanceStatus> PluginInstanceTable::status(const model::Document& document) const {
    std::vector<PluginInstanceStatus> out;
    for (const model::Track* track : document.tracksInOrder()) {
        for (const model::PluginSlot* slot : document.slotsOnTrack(track->id)) {
            if (auto one = status(slot->id)) {
                out.push_back(std::move(*one));
            } else {
                PluginInstanceStatus missing;
                missing.slotId = slot->id;
                missing.trackId = slot->trackId;
                missing.format = slot->format;
                missing.uid = slot->uid;
                missing.error = PluginProblem{"plugin_missing", "the slot has not been loaded yet"};
                out.push_back(std::move(missing));
            }
        }
    }
    return out;
}

// ---- RenderInstanceSet -------------------------------------------------------

RenderInstanceSet::RenderInstanceSet(const model::Document& document, const PluginHosts& hosts,
                                     const std::filesystem::path& bundle, int maxBlockFrames)
    : sampleRate_(document.root().sampleRate) {
    for (const model::PluginSlot* slot : document.allPluginSlots()) {
        LoadedPlugin loaded = loadPlugin(*slot, hosts, bundle, sampleRate_, maxBlockFrames);
        if (loaded.instance) {
            instances_.emplace(slot->id, std::move(loaded.instance));
        }
        if (loaded.error) {
            failures_.emplace(slot->id, std::move(*loaded.error));
        }
    }
}

RenderInstanceSet::~RenderInstanceSet() = default;

std::unique_ptr<graph::Node> RenderInstanceSet::pluginNode(const model::PluginSlot& slot, int channels) const {
    const auto found = instances_.find(slot.id);
    if (found == instances_.end()) {
        return nullptr;
    }
    auto node = std::make_unique<graph::PluginNode>(*found->second, channels, sampleRate_, false);
    node->setBypass(slot.bypass);
    return node;
}

host::PluginInstance* RenderInstanceSet::instance(std::string_view slotId) const noexcept {
    const auto found = instances_.find(slotId);
    return found == instances_.end() ? nullptr : found->second.get();
}

}  // namespace siann::playback
