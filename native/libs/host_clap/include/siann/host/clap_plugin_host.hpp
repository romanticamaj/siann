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
// A setParameter during playback never pauses: the next block delivers it.
//
// PluginControl for CLAP: setState throws bad_state when the plugin refuses the
// payload; openEditor throws editor_failed until the desktop target can supply a
// window (docs/harness/follow-ups.md). State blobs are the envelope of
// state_envelope.hpp.

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
    std::vector<PluginDescriptor> scan() override;
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
    // parameter flush waits for the next process() while blocks are arriving, so a
    // call shortly after the last block can leave one for a later call.
    void runMainThreadCallbacks();

    // Main thread. Called when a plugin wants runMainThreadCallbacks(), on whichever
    // thread it asks from, the audio thread included, so it must not block or allocate.
    void setWakeHandler(std::function<void()> handler);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::host
