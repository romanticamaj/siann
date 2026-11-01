#include "siann/playback/playback_engine.hpp"

#include <algorithm>
#include <climits>
#include <cmath>
#include <stdexcept>
#include <utility>

#include "siann/command/command.hpp"
#include "siann/engine/offline.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/hash/json.hpp"
#include "siann/media/memory_reader.hpp"
#include "siann/media/wav_file_reader.hpp"
#include "siann/session/media_import.hpp"

namespace siann::playback {

namespace {

// One reader per content hash. WAV streams from the bundle; FLAC is decoded
// into memory (with engine::loadMedia's checks) until a streaming reader exists.
std::shared_ptr<host::MediaReader> openReader(const model::Media& entity, const std::filesystem::path& bundle) {
    if (entity.format == model::MediaFormat::flac) {
        return std::make_shared<media::MemoryMediaReader>(engine::readMedia(entity, bundle));
    }
    const auto file = session::mediaPath(bundle, entity.contentHash, entity.format);
    if (!std::filesystem::exists(file)) {
        throw engine::EngineError("media_missing", "media " + entity.id + " has no file at " + file.string());
    }
    auto reader = std::make_shared<media::WavFileReader>(file);
    const host::MediaInfo info = reader->info();
    if (info.channels != entity.channels || info.frames != entity.frames || info.sampleRate != entity.sampleRate) {
        throw engine::EngineError("media_mismatch", "the file for media " + entity.id + " differs from its entity");
    }
    return reader;
}

std::int32_t gainValue(double value) {
    if (std::isnan(value) || value == HUGE_VAL) {
        throw command::CommandError("invalid_gain", "a gain gesture ended on a value that is not a gain");
    }
    if (value <= static_cast<double>(INT32_MIN)) {
        return INT32_MIN;
    }
    if (value >= static_cast<double>(INT32_MAX)) {
        return INT32_MAX;
    }
    return static_cast<std::int32_t>(std::llround(value));
}

}  // namespace

std::string trackSlotKey(const std::string& trackId) {
    return "track:" + trackId;
}

CompiledPlayback compileForPlayback(const model::Document& document, const std::filesystem::path& bundle,
                                    const PlaybackOptions& options) {
    std::map<hash::Digest, std::shared_ptr<host::MediaReader>> readers;
    CompiledPlayback compiled;
    graph::GraphBuilder builder;
    const graph::NodeId master = builder.add(std::make_unique<graph::BusNode>(2), "master");
    for (const engine::FlatTrack& flat : engine::flattenClips(document)) {
        const model::Track& track = *flat.track;
        std::vector<realtime::StreamClip> clips;
        for (const engine::FlatClip& clip : flat.clips) {
            auto found = readers.find(clip.media->contentHash);
            if (found == readers.end()) {
                found = readers.emplace(clip.media->contentHash, openReader(*clip.media, bundle)).first;
            }
            clips.push_back(
                realtime::StreamClip{clip.timelineStart, clip.sourceStart, clip.length, clip.gain, found->second});
        }
        auto stream = std::make_unique<realtime::DiskStream>(track.channels, std::move(clips), options.ringFrames);
        const graph::NodeId player =
            builder.add(std::make_unique<realtime::StreamingPlayerNode>(*stream), track.id + ".stream");
        const graph::NodeId fader = builder.add(
            std::make_unique<graph::TrackFaderNode>(track.channels, track.gain.milliDb, track.pan, flat.silenced),
            track.id + ".fader");
        builder.connect(player, fader);
        builder.connect(fader, master);
        compiled.streams.push_back(std::move(stream));
        compiled.slots.emplace(trackSlotKey(track.id), fader);
    }
    builder.setOutput(master);
    compiled.graph = std::move(builder).compile(options.maxBlockFrames);
    return compiled;
}

PlaybackEngine::PlaybackEngine(session::Session& session, PlaybackOptions options)
    : session_(session),
      options_(std::move(options)),
      butler_(options_.butler),
      driver_(realtime::GraphDriver::Options{options_.fadeFrames, std::chrono::milliseconds(500)}),
      dispatcher_(driver_) {}

PlaybackEngine::~PlaybackEngine() {
    stop();
}

void PlaybackEngine::load() {
    if (loaded_) {
        throw std::logic_error("the playback engine is already loaded");
    }
    CompiledPlayback compiled = compileForPlayback(session_.history().head().document, session_.bundlePath(), options_);
    streams_ = std::move(compiled.streams);
    for (const auto& stream : streams_) {
        butler_.addStream(*stream);
    }
    const std::uint64_t epoch = driver_.publish(std::move(compiled.graph));
    slots_ = compiled.slots;
    dispatcher_.graphPublished(epoch, std::move(compiled.slots));
    loaded_ = true;
}

void PlaybackEngine::start(host::AudioDevice& device, const host::AudioDeviceConfig& config) {
    if (!loaded_) {
        throw std::logic_error("load the playback engine before starting it");
    }
    if (options_.butlerThread) {
        butler_.start();
    }
    driver_.play();
    driver_.start(device, config);
}

void PlaybackEngine::stop() {
    driver_.stop();
    butler_.stop();
}

void PlaybackEngine::beginGesture(const std::string& trackId, std::uint32_t paramId) {
    dispatcher_.beginGesture(realtime::ParamKey{trackSlotKey(trackId), paramId});
}

void PlaybackEngine::updateGesture(const std::string& trackId, std::uint32_t paramId, double value, int rampFrames) {
    dispatcher_.updateGesture(realtime::ParamKey{trackSlotKey(trackId), paramId}, value, rampFrames);
}

const command::Revision* PlaybackEngine::endGesture(const std::string& trackId, std::uint32_t paramId,
                                                    std::string actor, std::string time) {
    if (paramId != graph::TrackFaderNode::kGainMilliDb) {
        throw std::invalid_argument("only track gain gestures can be committed");
    }
    const realtime::ParamKey key{trackSlotKey(trackId), paramId};
    const std::optional<double> value = dispatcher_.endGesture(key);
    if (!value) {
        return nullptr;
    }
    try {
        const std::int32_t milliDb = gainValue(*value);
        const command::Command command = command::Command::fromJson(json::Object{
            {"op", "track.set_gain"}, {"trackId", trackId}, {"gainMilliDb", static_cast<double>(milliDb)}});
        const command::Revision& revision = session_.commit({command}, std::move(actor), std::move(time));
        // The committed value reaches the audio thread through the dispatcher.
        dispatcher_.setParameter(key, static_cast<double>(milliDb), 0);
        return &revision;
    } catch (...) {
        // Nothing was committed: the sound returns to the document's value.
        if (const model::Track* track = session_.history().head().document.track(trackId)) {
            dispatcher_.setParameter(key, static_cast<double>(track->gain.milliDb), 0);
        }
        throw;
    }
}

void PlaybackEngine::tick() {
    dispatcher_.tick();
    driver_.poll();
}

std::uint64_t PlaybackEngine::underruns() const noexcept {
    std::uint64_t total = 0;
    for (const auto& stream : streams_) {
        total += stream->underruns();
    }
    return total;
}

}  // namespace siann::playback
