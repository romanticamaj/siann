#pragma once

// What the process's main thread does once the engine is up (architecture spec,
// "Process model"). A SIANN_WITH_JUCE build runs the JUCE message loop there and
// can host a plugin editor (main_thread_desktop.cpp); the core-only build has
// nothing to dispatch and only waits for the stop flag (main_thread_core.cpp).
// Construct it on the main thread, before anything else starts.

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

namespace siann::engine_app {

class MainThread {
public:
    MainThread();
    ~MainThread();
    MainThread(const MainThread&) = delete;
    MainThread& operator=(const MainThread&) = delete;

    // Loads the bundle's first plugin and opens its editor, owned by ownerWindow
    // (0 for none; see host::EditorOwner). Throws LaunchError.
    void openEditor(const std::string& bundle, std::uintptr_t ownerWindow);

    // Serves until `stop` is set; with `stop` null, until the process ends.
    void serve(const std::atomic<bool>* stop);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::engine_app
