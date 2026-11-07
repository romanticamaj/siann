#include <chrono>
#include <thread>

#include "launch_error.hpp"
#include "main_thread.hpp"

namespace siann::engine_app {

struct MainThread::Impl {};

MainThread::MainThread() = default;
MainThread::~MainThread() = default;

void MainThread::openEditor(const std::string&, std::uintptr_t) {
    throw LaunchError("no_plugin_host", "--open-editor needs an engine built with SIANN_WITH_JUCE");
}

void MainThread::serve(const std::atomic<bool>* stop, const std::function<void()>& tick) {
    // The stop flag is set from a signal handler or the stdin watcher, so it is
    // polled.
    while (stop == nullptr || !stop->load()) {
        std::this_thread::sleep_for(kTickInterval);
        tick();
    }
}

}  // namespace siann::engine_app
