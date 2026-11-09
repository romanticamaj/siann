#pragma once

// PluginHost for CLAP (architecture spec, "siann-host: two targets, one interface"):
// the one format of both host targets, so it needs no JUCE. The CLAP SDK stays behind
// this header. Everything here runs on the thread that built the host, the main
// thread, except what interfaces.hpp says otherwise.
//
// CLAP asks the host to call the plugin back on the main thread, so whoever owns the
// main thread services the host: runMainThreadCallbacks() on every wake and now and
// then besides. It restarts the plugins that asked (a restart is what makes a new
// latency take effect, spec "Latency model"), and hands them parameter changes that
// no process() call is coming to deliver.
//
// CLAP's [audio-thread] is a symbolic thread: the host may make those calls on the
// main thread when no process() can overlap them, so they run under a pause that
// holds the plugin out of processing (input passes through dry). No lock in process().
// A setParameter during playback never pauses: the next block delivers it. Whether
// blocks are coming is what the driver says through PluginInstance::setBlocksComing;
// told nothing, the host guesses from the last block (50 ms or four block periods).
//
// PluginControl for CLAP: setState throws bad_state when the plugin refuses the
// payload; openEditor throws editor_failed until the desktop target can supply a
// window (docs/harness/follow-ups.md). State blobs are the envelope of
// state_envelope.hpp.
//
// A plugin that throws (spec, "siann-host", Hostile test plugin) is caught at the
// boundary of every plugin call. Out of instantiate it is plugin_load_failed; out of
// getState, bad_state; out of setState, bad_state and the instance fails; out of
// process(), the block's output is cleared and the instance fails; out of a restart
// or on_main_thread inside runMainThreadCallbacks, the instance fails and the other
// instances are serviced as usual. A failed instance passes its input through,
// reports PluginEvent::Kind::failed once, answers getState and setState with
// plugin_failed, stores a setParameter nothing delivers, keeps its last latency and
// tail, and is replaced, never revived.
//
// What a plugin calls back (rescan, restart, flush, callback, latency and tail
// changes) is atomics and a wake on any thread, honoured on the main thread after the
// plugin call in flight returns: values a rescan marks stale are read there, never on
// the caller's thread.

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "siann/host/interfaces.hpp"
#include "siann/host/plugin_error.hpp"

namespace siann::host {

class ClapPluginHost final : public PluginHost {
public:
    ClapPluginHost();
    ~ClapPluginHost() override;
    ClapPluginHost(const ClapPluginHost&) = delete;
    ClapPluginHost& operator=(const ClapPluginHost&) = delete;

    // The `.clap` entries of the format's default directories and of CLAP_PATH.
    std::vector<PluginDescriptor> scan(const std::vector<std::string>& extraDirectories = {}) override;
    // Throws plugin_not_found when the path does not exist and plugin_load_failed
    // when it holds no plugin this host can load.
    std::vector<PluginDescriptor> scanPath(const std::string& path) override;
    // Loads the file at the descriptor's path, never another install of the same uid.
    // Without a path the uid must have exactly one known install; without a uid, the
    // file's first plugin. Throws plugin_not_found when they name no plugin and
    // plugin_load_failed when it does not load or has more than 31 channels on a port.
    std::unique_ptr<PluginInstance> instantiate(const PluginDescriptor& descriptor, std::int64_t sampleRate,
                                                int maxBlockFrames) override;

    // Main thread. Services what every live instance of this host asked for. A
    // parameter flush is left to the next process() while blocks are coming, so a
    // call then can leave one for a later call. Never throws: a plugin that throws
    // here fails its own instance only.
    void runMainThreadCallbacks();

    // Main thread. Called when a plugin wants runMainThreadCallbacks(), on whichever
    // thread it asks from, the audio thread included, so it must not block or allocate.
    void setWakeHandler(std::function<void()> handler);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::host
