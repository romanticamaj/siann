#include "siann/playback/playback_engine.hpp"

#include <stdexcept>
#include <utility>

namespace siann::playback {

std::string trackSlotKey(const std::string& trackId) {
    return "track:" + trackId;
}

CompiledPlayback compileForPlayback(const model::Document& document, const std::filesystem::path& bundle,
                                    const PlaybackOptions& options) {
    (void)document;
    (void)bundle;
    (void)options;
    throw std::logic_error("not implemented");
}

PlaybackEngine::PlaybackEngine(session::Session& session, PlaybackOptions options)
    : session_(session),
      options_(std::move(options)),
      butler_(options_.butler),
      driver_(realtime::GraphDriver::Options{options_.fadeFrames, std::chrono::milliseconds(500)}),
      dispatcher_(driver_) {}

PlaybackEngine::~PlaybackEngine() = default;

void PlaybackEngine::load() {
    throw std::logic_error("not implemented");
}

void PlaybackEngine::start(host::AudioDevice& device, const host::AudioDeviceConfig& config) {
    (void)device;
    (void)config;
    throw std::logic_error("not implemented");
}

void PlaybackEngine::stop() {}

void PlaybackEngine::beginGesture(const std::string& trackId, std::uint32_t paramId) {
    (void)trackId;
    (void)paramId;
}

void PlaybackEngine::updateGesture(const std::string& trackId, std::uint32_t paramId, double value, int rampFrames) {
    (void)trackId;
    (void)paramId;
    (void)value;
    (void)rampFrames;
}

const command::Revision* PlaybackEngine::endGesture(const std::string& trackId, std::uint32_t paramId,
                                                    std::string actor, std::string time) {
    (void)trackId;
    (void)paramId;
    (void)actor;
    (void)time;
    return nullptr;
}

void PlaybackEngine::tick() {}

std::uint64_t PlaybackEngine::underruns() const noexcept {
    return 0;
}

}  // namespace siann::playback
