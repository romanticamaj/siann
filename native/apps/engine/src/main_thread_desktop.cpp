#include <chrono>

#include "main_thread.hpp"
#include "siann/host/juce_plugin_host.hpp"

namespace siann::engine_app {

// The JUCE message loop, made the main thread's before the engine host's plugin
// hosts exist.
struct MainThread::Impl {
    host::MainThreadLoop loop;
};

MainThread::MainThread() : impl_(std::make_unique<Impl>()) {}
MainThread::~MainThread() = default;

void MainThread::serve(const std::atomic<bool>* stop, const std::function<void()>& tick) {
    const auto stopped = [stop] { return stop != nullptr && stop->load(); };
    while (!stopped()) {
        impl_->loop.runUntil(stopped, kTickInterval);
        tick();
    }
}

}  // namespace siann::engine_app
