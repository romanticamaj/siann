#include "siann/playback/playback_engine.hpp"

#include <algorithm>
#include <climits>
#include <cmath>
#include <functional>
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

std::int32_t panValue(double value) {
    if (!std::isfinite(value)) {
        throw command::CommandError("invalid_pan", "a pan gesture ended on a value that is not a pan");
    }
    // Out-of-range values reach the document's own range check.
    return static_cast<std::int32_t>(
        std::llround(std::clamp(value, static_cast<double>(INT32_MIN), static_cast<double>(INT32_MAX))));
}

// Fader parameters a gesture can commit, each through its own track command.
void requireCommittable(std::uint32_t paramId) {
    if (paramId != graph::TrackFaderNode::kGainMilliDb && paramId != graph::TrackFaderNode::kPan &&
        paramId != graph::TrackFaderNode::kMute) {
        throw std::invalid_argument("track fader parameter " + std::to_string(paramId) +
                                    " cannot be committed by a gesture");
    }
}

// The command that commits a gesture's last value, and the value the audio
// thread then holds.
struct GestureCommit {
    command::Command command;
    double value = 0.0;
};

GestureCommit gestureCommit(const std::string& trackId, std::uint32_t paramId, double value) {
    if (paramId == graph::TrackFaderNode::kPan) {
        const std::int32_t pan = panValue(value);
        return {command::Command::fromJson(
                    json::Object{{"op", "track.set_pan"}, {"trackId", trackId}, {"pan", static_cast<double>(pan)}}),
                static_cast<double>(pan)};
    }
    if (paramId == graph::TrackFaderNode::kMute) {
        if (std::isnan(value)) {
            throw command::CommandError("invalid_mute", "a mute gesture ended on a value that is not a mute");
        }
        const bool mute = value != 0.0;
        return {command::Command::fromJson(json::Object{{"op", "track.set_mute"}, {"trackId", trackId}, {"mute", mute}}),
                mute ? 1.0 : 0.0};
    }
    const std::int32_t milliDb = gainValue(value);
    return {command::Command::fromJson(json::Object{
                {"op", "track.set_gain"}, {"trackId", trackId}, {"gainMilliDb", static_cast<double>(milliDb)}}),
            static_cast<double>(milliDb)};
}

// The document's value of a fader parameter, as the audio thread holds it.
double documentValue(const model::Track& track, std::uint32_t paramId) {
    if (paramId == graph::TrackFaderNode::kPan) {
        return static_cast<double>(track.pan);
    }
    if (paramId == graph::TrackFaderNode::kMute) {
        return track.mute ? 1.0 : 0.0;
    }
    return static_cast<double>(track.gain.milliDb);
}

detail::StreamKey streamKey(const engine::FlatTrack& flat) {
    detail::StreamKey key;
    key.channels = flat.track->channels;
    for (const engine::FlatClip& clip : flat.clips) {
        key.clips.push_back(
            detail::StreamClipKey{clip.timelineStart, clip.sourceStart, clip.length, clip.gain, clip.media->contentHash});
    }
    return key;
}

// Returns an existing stream to reuse for a track, or nullptr for a new one.
using StreamReuse = std::function<realtime::DiskStream*(const std::string& trackId, const detail::StreamKey& key)>;

// compileForPlayback() with stream reuse. `tracks` receives every track's
// stream (reused or new); compiled.streams holds only the new ones.
CompiledPlayback compileWith(const model::Document& document, const std::filesystem::path& bundle,
                             const PlaybackOptions& options, const StreamReuse& reuse,
                             std::map<std::string, detail::TrackStream>* tracks) {
    std::map<hash::Digest, std::shared_ptr<host::MediaReader>> readers;
    CompiledPlayback compiled;
    graph::GraphBuilder builder;
    const graph::NodeId master = builder.add(std::make_unique<graph::BusNode>(2), "master");
    for (const engine::FlatTrack& flat : engine::flattenClips(document)) {
        const model::Track& track = *flat.track;
        detail::StreamKey key = streamKey(flat);
        realtime::DiskStream* stream = reuse ? reuse(track.id, key) : nullptr;
        if (stream == nullptr) {
            std::vector<realtime::StreamClip> clips;
            for (const engine::FlatClip& clip : flat.clips) {
                auto found = readers.find(clip.media->contentHash);
                if (found == readers.end()) {
                    found = readers.emplace(clip.media->contentHash, openReader(*clip.media, bundle)).first;
                }
                clips.push_back(realtime::StreamClip{clip.timelineStart, clip.sourceStart, clip.length, clip.gain,
                                                     found->second});
            }
            compiled.streams.push_back(
                std::make_unique<realtime::DiskStream>(track.channels, std::move(clips), options.ringFrames));
            stream = compiled.streams.back().get();
        }
        if (tracks != nullptr) {
            tracks->insert_or_assign(track.id, detail::TrackStream{stream, std::move(key)});
        }
        const graph::NodeId player =
            builder.add(std::make_unique<realtime::StreamingPlayerNode>(*stream), track.id + ".stream");
        // The fader's kMute is the track's own mute, the value a mute gesture
        // writes; solo silence stays separate so no gesture can lift it.
        const graph::NodeId fader = builder.add(std::make_unique<graph::TrackFaderNode>(
                                                    track.channels, track.gain.milliDb, track.pan, track.mute,
                                                    flat.soloSilenced),
                                                track.id + ".fader");
        const graph::NodeId meter = builder.add(std::make_unique<graph::MeterNode>(2), track.id + ".meter");
        builder.connect(player, fader);
        builder.connect(fader, meter);
        builder.connect(meter, master);
        compiled.slots.emplace(trackSlotKey(track.id), fader);
        compiled.meterSlots.emplace(trackSlotKey(track.id), meter);
    }
    // The master meter is the output, so it sees the final mix.
    const graph::NodeId masterMeter = builder.add(std::make_unique<graph::MeterNode>(2), "master.meter");
    builder.connect(master, masterMeter);
    compiled.meterSlots.emplace(masterMeterKey(), masterMeter);
    builder.setOutput(masterMeter);
    compiled.graph = std::move(builder).compile(options.maxBlockFrames);
    return compiled;
}

// True when the edit changes nothing but track gain, pan or mute.
bool onlyFaderChanges(const model::Document& before, const model::Document& after) {
    for (const model::DiffEntry& entry : model::diff(before, after)) {
        if (entry.entity.type != model::EntityType::track || entry.change != model::DiffEntry::Change::modified) {
            return false;
        }
        const model::Track* old = before.track(entry.entity.id);
        const model::Track* now = after.track(entry.entity.id);
        if (old == nullptr || now == nullptr) {
            return false;
        }
        model::Track faderOnly = *old;
        faderOnly.gain = now->gain;
        faderOnly.pan = now->pan;
        faderOnly.mute = now->mute;
        if (!(faderOnly == *now)) {
            return false;
        }
    }
    return true;
}

// A new stream that does not report ready within this time is published
// anyway; it counts underruns until the butler catches up (as a late locate).
constexpr std::chrono::seconds kPrefillTimeout{1};

}  // namespace

std::string trackSlotKey(const std::string& trackId) {
    return "track:" + trackId;
}

std::string masterMeterKey() {
    return "master";
}

CompiledPlayback compileForPlayback(const model::Document& document, const std::filesystem::path& bundle,
                                    const PlaybackOptions& options) {
    return compileWith(document, bundle, options, nullptr, nullptr);
}

PlaybackEngine::PlaybackEngine(session::Session& session, PlaybackOptions options)
    : session_(session),
      options_(std::move(options)),
      butler_(options_.butler),
      driver_(realtime::GraphDriver::Options{options_.fadeFrames, std::chrono::milliseconds(500), 1024,
                                             [this](std::uint64_t epoch) { retired(epoch); }}),
      dispatcher_(driver_),
      transport_(driver_, butler_, options_.transport) {}

PlaybackEngine::~PlaybackEngine() {
    stop();
}

void PlaybackEngine::load() {
    if (loaded_) {
        throw std::logic_error("the playback engine is already loaded");
    }
    const model::Document& head = session_.history().head().document;
    compile(head);
    for (realtime::DiskStream* stream : prepared_->fresh) {
        butler_.addStream(*stream);  // the butler is not running yet: filled from 0 at once
    }
    publishPrepared();
    latest_ = head;
    loaded_ = true;
}

void PlaybackEngine::compile(const model::Document& document) {
    detail::PreparedPlayback prepared;
    CompiledPlayback compiled = compileWith(
        document, session_.bundlePath(), options_,
        [this](const std::string& trackId, const detail::StreamKey& key) -> realtime::DiskStream* {
            const auto live = liveTracks_.find(trackId);
            return live != liveTracks_.end() && live->second.key == key ? live->second.stream : nullptr;
        },
        &prepared.tracks);
    ++compileCount_;
    prepared.graph = std::move(compiled.graph);
    prepared.slots = std::move(compiled.slots);
    prepared.meterSlots = std::move(compiled.meterSlots);
    for (auto& stream : compiled.streams) {
        realtime::DiskStream* raw = stream.get();
        streams_.emplace(raw, detail::OwnedStream{std::move(stream), false});
        prepared.fresh.push_back(raw);
    }
    prepared.since = std::chrono::steady_clock::now();
    prepared_ = std::move(prepared);
}

bool PlaybackEngine::preparedReady() const {
    return std::all_of(prepared_->fresh.begin(), prepared_->fresh.end(),
                       [](const realtime::DiskStream* stream) { return stream->ready(); }) ||
           std::chrono::steady_clock::now() - prepared_->since >= kPrefillTimeout;
}

void PlaybackEngine::publishPrepared() {
    // prepared_ stays set across publish(): retiring the old graph while
    // stopped happens inside it, and the new graph's streams must count as used.
    const std::uint64_t epoch = driver_.publish(std::move(prepared_->graph));
    std::vector<realtime::DiskStream*>& used = epochStreams_[epoch];
    for (const auto& [trackId, track] : prepared_->tracks) {
        used.push_back(track.stream);
    }
    liveTracks_ = std::move(prepared_->tracks);
    slots_ = prepared_->slots;
    meterSlots_ = prepared_->meterSlots;
    dispatcher_.graphPublished(epoch, std::move(prepared_->slots), std::move(prepared_->meterSlots));
    prepared_.reset();
}

bool PlaybackEngine::inUse(const realtime::DiskStream* stream) const {
    for (const auto& [epoch, used] : epochStreams_) {
        if (std::find(used.begin(), used.end(), stream) != used.end()) {
            return true;
        }
    }
    if (prepared_) {
        for (const auto& [trackId, track] : prepared_->tracks) {
            if (track.stream == stream) {
                return true;
            }
        }
    }
    return false;
}

void PlaybackEngine::retired(std::uint64_t epoch) {
    const auto found = epochStreams_.find(epoch);
    if (found == epochStreams_.end()) {
        return;
    }
    const std::vector<realtime::DiskStream*> used = std::move(found->second);
    epochStreams_.erase(found);
    for (realtime::DiskStream* stream : used) {
        detail::OwnedStream& owned = streams_.at(stream);
        if (!owned.removing && !inUse(stream)) {
            owned.removing = true;
            butler_.removeStream(*stream);  // destroyed once the butler released it
        }
    }
}

void PlaybackEngine::destroyReleased() {
    for (auto it = streams_.begin(); it != streams_.end();) {
        if (it->second.removing && it->second.stream->released()) {
            destroyedUnderruns_ += it->second.stream->underruns();
            it = streams_.erase(it);
        } else {
            ++it;
        }
    }
}

void PlaybackEngine::update(const model::Document& document) {
    if (!loaded_) {
        throw std::logic_error("load the playback engine before updating it");
    }
    // A compile that waits or is pending is older than this document: recompile.
    if (!prepared_ && !pendingDoc_ && onlyFaderChanges(*latest_, document)) {
        for (const model::DiffEntry& entry : model::diff(*latest_, document)) {
            const model::Track& old = *latest_->track(entry.entity.id);
            const model::Track& now = *document.track(entry.entity.id);
            const std::string key = trackSlotKey(now.id);
            for (const std::uint32_t paramId :
                 {graph::TrackFaderNode::kGainMilliDb, graph::TrackFaderNode::kPan, graph::TrackFaderNode::kMute}) {
                if (documentValue(old, paramId) != documentValue(now, paramId)) {
                    dispatcher_.setParameter(realtime::ParamKey{key, paramId}, documentValue(now, paramId), 0);
                }
            }
        }
    } else {
        pendingDoc_ = document;
    }
    latest_ = document;
}

void PlaybackEngine::start(host::AudioDevice& device, const host::AudioDeviceConfig& config) {
    if (!loaded_) {
        throw std::logic_error("load the playback engine before starting it");
    }
    if (options_.butlerThread) {
        butler_.start();
    }
    if (options_.playOnStart) {
        driver_.play();
    }
    driver_.start(device, config);
}

void PlaybackEngine::stop() {
    driver_.stop();
    butler_.stop();
}

void PlaybackEngine::beginGesture(const std::string& trackId, std::uint32_t paramId) {
    requireCommittable(paramId);  // so no gesture opens that endGesture cannot close
    dispatcher_.beginGesture(realtime::ParamKey{trackSlotKey(trackId), paramId});
}

void PlaybackEngine::updateGesture(const std::string& trackId, std::uint32_t paramId, double value, int rampFrames) {
    requireCommittable(paramId);
    dispatcher_.updateGesture(realtime::ParamKey{trackSlotKey(trackId), paramId}, value, rampFrames);
}

const command::Revision* PlaybackEngine::endGesture(const std::string& trackId, std::uint32_t paramId,
                                                    std::string actor, std::string time) {
    requireCommittable(paramId);
    const realtime::ParamKey key{trackSlotKey(trackId), paramId};
    const std::optional<double> value = dispatcher_.endGesture(key);
    if (!value) {
        return nullptr;
    }
    try {
        const GestureCommit commit = gestureCommit(trackId, paramId, *value);
        const command::Revision& revision = session_.commit({commit.command}, std::move(actor), std::move(time));
        // The committed value reaches the audio thread through the dispatcher.
        dispatcher_.setParameter(key, commit.value, 0);
        return &revision;
    } catch (...) {
        // Nothing was committed: the sound returns to the document's value.
        if (const model::Track* track = session_.history().head().document.track(trackId)) {
            dispatcher_.setParameter(key, documentValue(*track, paramId), 0);
        }
        throw;
    }
}

void PlaybackEngine::tick() {
    transport_.tick();
    dispatcher_.tick();
    driver_.poll();
    destroyReleased();
    if (prepared_ && preparedReady()) {
        publishPrepared();
    }
    // One transition at a time; the compile always takes the latest document.
    if (!prepared_ && pendingDoc_ && !driver_.transitionInFlight()) {
        const model::Document document = std::move(*pendingDoc_);
        pendingDoc_.reset();
        compile(document);
        // The generation first: the playhead then belongs to it or a newer
        // locate, and a stream joins any locate prepared after it.
        const std::uint64_t generation = driver_.appliedLocate();
        const std::int64_t playhead = driver_.playhead();
        for (realtime::DiskStream* stream : prepared_->fresh) {
            butler_.addStream(*stream, playhead, generation);
        }
        if (preparedReady()) {
            publishPrepared();
        }
    }
}

std::uint64_t PlaybackEngine::underruns() const noexcept {
    std::uint64_t total = destroyedUnderruns_;
    for (const auto& [stream, owned] : streams_) {
        total += owned.stream->underruns();
    }
    return total;
}

const realtime::DiskStream* PlaybackEngine::streamFor(const std::string& trackId) const noexcept {
    const auto found = liveTracks_.find(trackId);
    return found != liveTracks_.end() ? found->second.stream : nullptr;
}

}  // namespace siann::playback
