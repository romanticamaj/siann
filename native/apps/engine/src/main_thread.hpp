#pragma once

// What the process's main thread does once the engine is up (architecture spec,
// "Process model"): it is the command and control thread, so it calls the engine's
// tick. A SIANN_WITH_JUCE build runs the JUCE message loop around the ticks and can
// host a plugin editor (main_thread_desktop.cpp); the core-only build has nothing
// to dispatch and sleeps between them (main_thread_core.cpp). Construct it on the
// main thread, before anything else starts.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace siann::engine_app {

// At most this often; a slow tick delays the next one.
inline constexpr std::chrono::milliseconds kTickInterval{10};

class MainThread {
public:
    MainThread();
    ~MainThread();
    MainThread(const MainThread&) = delete;
    MainThread& operator=(const MainThread&) = delete;

    // Loads the bundle's first plugin and opens its editor, owned by ownerWindow
    // (0 for none; see host::EditorOwner). Throws LaunchError.
    void openEditor(const std::string& bundle, std::uintptr_t ownerWindow);

    // Serves until `stop` is set, calling `tick` between passes of the message
    // loop; with `stop` null, until the process ends.
    void serve(const std::atomic<bool>* stop, const std::function<void()>& tick);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::engine_app
