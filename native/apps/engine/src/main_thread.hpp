#pragma once

// What the process's main thread does once the engine is up (architecture spec,
// "Process model"): it is the command and control thread, so it calls the engine's
// tick. A SIANN_WITH_JUCE build runs the JUCE message loop around the ticks, which
// plugin editors need (main_thread_desktop.cpp; plugin.open_editor opens them);
// the core-only build has nothing to dispatch and sleeps between them
// (main_thread_core.cpp). Construct it on the main thread, before anything else
// starts, the engine host's plugin hosts included.

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

    // Serves until `stop` is set, calling `tick` between passes of the message
    // loop; with `stop` null, until the process ends.
    void serve(const std::atomic<bool>* stop, const std::function<void()>& tick);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace siann::engine_app
