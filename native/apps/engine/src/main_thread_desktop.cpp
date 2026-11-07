#include <chrono>

#include "launch_error.hpp"
#include "main_thread.hpp"
#include "siann/host/juce_plugin_host.hpp"

namespace siann::engine_app {

namespace {

// The hosted instance is not in the graph until M4: it only shows its editor.
constexpr std::int64_t editorSampleRate = 48'000;
constexpr int editorBlockFrames = 512;

}  // namespace

// Members go in reverse: the instance, then the host, then the loop they need.
struct MainThread::Impl {
    host::MainThreadLoop loop;
    host::JucePluginHost plugins;
    std::unique_ptr<host::PluginInstance> editing;
};

MainThread::MainThread() : impl_(std::make_unique<Impl>()) {}
MainThread::~MainThread() = default;

void MainThread::openEditor(const std::string& bundle, std::uintptr_t ownerWindow) {
    try {
        const auto descriptors = impl_->plugins.scanPath(bundle);
        impl_->editing = impl_->plugins.instantiate(descriptors.front(), editorSampleRate, editorBlockFrames);
        impl_->editing->control().openEditor({ownerWindow});
    } catch (const host::PluginError& error) {
        throw LaunchError(error.code(), error.what());
    }
}

void MainThread::serve(const std::atomic<bool>* stop) {
    const auto stopped = [stop] { return stop != nullptr && stop->load(); };
    while (!stopped()) {
        impl_->loop.runUntil(stopped, std::chrono::hours(1));
    }
}

}  // namespace siann::engine_app
