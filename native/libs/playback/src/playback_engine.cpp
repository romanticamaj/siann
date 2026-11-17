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
#include "siann/playback/audition.hpp"
#include "siann/session/media_import.hpp"

namespace siann::playback {

// The fader node clamps a gesture's gain into the track entity's range.
static_assert(graph::TrackFaderNode::kMinGainMilliDb == model::Gain::kMinMilliDb);
static_assert(graph::TrackFaderNode::kMaxGainMilliDb == model::Gain::kMaxMilliDb);

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

bool isMasterTarget(const std::string& target) {
    return target == masterSlotKey();
}

bool hasPrefix(const std::string& text, std::string_view prefix) {
    return text.size() > prefix.size() && text.compare(0, prefix.size(), prefix) == 0;
}

// A bus or send target names its slot key; a track id never holds a ':'.
bool isBusTarget(const std::string& target) {
    return hasPrefix(target, "bus:");
}
bool isSendTarget(const std::string& target) {
    return hasPrefix(target, "send:");
}
std::string targetId(const std::string& target) {
    return target.substr(target.find(':') + 1);
}

// Fader parameters a gesture can commit, each through its own track command;
// the master commits its gain only, through master.set_gain; a bus its gain
// (bus.set_gain), a send its level (send.set_level).
void requireCommittable(const std::string& target, std::uint32_t paramId) {
    if (isBusTarget(target) && paramId != graph::TrackFaderNode::kGainMilliDb) {
        throw std::invalid_argument("bus parameter " + std::to_string(paramId) +
                                    " cannot be committed by a gesture: a bus gesture moves its gain");
    }
    if (isSendTarget(target) && paramId != graph::SendNode::kLevelMilliDb) {
        throw std::invalid_argument("send parameter " + std::to_string(paramId) +
                                    " cannot be committed by a gesture: a send gesture moves its level");
    }
    if (isBusTarget(target) || isSendTarget(target)) {
        return;
    }
    if (isMasterTarget(target)) {
        if (paramId != graph::TrackFaderNode::kGainMilliDb) {
            throw std::invalid_argument("master parameter " + std::to_string(paramId) +
                                        " cannot be committed by a gesture: the master has a gain only");
        }
        return;
    }
    if (paramId != graph::TrackFaderNode::kGainMilliDb && paramId != graph::TrackFaderNode::kPan &&
        paramId != graph::TrackFaderNode::kMute) {
        throw std::invalid_argument("track fader parameter " + std::to_string(paramId) +
                                    " cannot be committed by a gesture");
    }
}

// The dispatcher's key of a gesture target's parameter.
realtime::ParamKey gestureKey(const std::string& target, std::uint32_t paramId) {
    const bool keyed = isMasterTarget(target) || isBusTarget(target) || isSendTarget(target);
    return realtime::ParamKey{keyed ? target : trackSlotKey(target), paramId};
}

// The master gain as the audio thread holds it: 0 dB while the entity is absent.
double masterValue(const model::Document& document) {
    const model::Master* value = document.master();
    return value != nullptr ? static_cast<double>(value->gain.milliDb) : 0.0;
}

// The command that commits a gesture's last value, and the value the audio
// thread then holds.
struct GestureCommit {
    command::Command command;
    double value = 0.0;
};

GestureCommit gestureCommit(const std::string& trackId, std::uint32_t paramId, double value) {
    if (isBusTarget(trackId)) {
        const std::int32_t milliDb = gainValue(value);
        return {command::Command::fromJson(json::Object{{"op", "bus.set_gain"},
                                                        {"busId", targetId(trackId)},
                                                        {"gainMilliDb", static_cast<double>(milliDb)}}),
                static_cast<double>(milliDb)};
    }
    if (isSendTarget(trackId)) {
        const std::int32_t milliDb = gainValue(value);
        return {command::Command::fromJson(json::Object{{"op", "send.set_level"},
                                                        {"sendId", targetId(trackId)},
                                                        {"levelMilliDb", static_cast<double>(milliDb)}}),
                static_cast<double>(milliDb)};
    }
    if (isMasterTarget(trackId)) {
        const std::int32_t milliDb = gainValue(value);
        return {command::Command::fromJson(
                    json::Object{{"op", "master.set_gain"}, {"gainMilliDb", static_cast<double>(milliDb)}}),
                static_cast<double>(milliDb)};
    }
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

// The document's value of a bus fader parameter, as the audio thread holds it.
double busValue(const model::Bus& bus, std::uint32_t paramId) {
    if (paramId == graph::TrackFaderNode::kPan) {
        return static_cast<double>(bus.pan);
    }
    if (paramId == graph::TrackFaderNode::kMute) {
        return bus.mute ? 1.0 : 0.0;
    }
    return static_cast<double>(bus.gain.milliDb);
}

// The document's value of a send parameter, as the audio thread holds it.
double sendValue(const model::Send& send, std::uint32_t paramId) {
    if (paramId == graph::SendNode::kEnabled) {
        return send.enabled ? 1.0 : 0.0;
    }
    return static_cast<double>(send.level.milliDb);
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
        key.clips.push_back(detail::StreamClipKey{clip.timelineStart, clip.sourceStart, clip.length, clip.gain,
                                                  clip.media->contentHash, clip.fade});
    }
    return key;
}

// Returns an existing stream to reuse for a track, or nullptr for a new one.
using StreamReuse = std::function<realtime::DiskStream*(const std::string& trackId, const detail::StreamKey& key)>;

// compileForPlayback() with stream reuse. `tracks` receives every track's
// stream (reused or new); compiled.streams holds only the new ones.
CompiledPlayback compileWith(const model::Document& document, const std::filesystem::path& bundle,
                             const PlaybackOptions& options, const StreamReuse& reuse,
                             std::map<std::string, detail::TrackStream>* tracks, PluginInstanceTable* plugins) {
    if (plugins != nullptr) {
        plugins->sync(document);
    }
    std::map<hash::Digest, std::shared_ptr<host::MediaReader>> readers;
    CompiledPlayback compiled;
    graph::GraphBuilder builder;
    const graph::NodeId master = builder.add(std::make_unique<graph::BusNode>(2), "master");
    const std::vector<engine::FlatTrack> flatTracks = engine::flattenClips(document);
    std::map<std::string, engine::TrackTaps> taps;
    for (const engine::FlatTrack& flat : flatTracks) {
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
                                                     found->second, clip.fade});
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
        // The inserts, in order; a missing plugin has no node and passes through.
        graph::NodeId previous = player;
        if (plugins != nullptr) {
            for (const model::PluginSlot* slot : document.slotsOnTrack(track.id)) {
                if (auto node = plugins->pluginNode(*slot, track.channels)) {
                    const graph::NodeId insert = builder.add(std::move(node), track.id + ".insert." + slot->id);
                    compiled.slots.emplace(pluginSlotKey(slot->id), insert);
                    builder.connect(previous, insert);
                    previous = insert;
                }
            }
        }
        builder.connect(previous, fader);
        builder.connect(fader, meter);
        // The meter passes the fader's output through: the post-fader tap.
        taps.emplace(track.id, engine::TrackTaps{previous, meter});
        compiled.slots.emplace(trackSlotKey(track.id), fader);
        compiled.meterSlots.emplace(trackSlotKey(track.id), meter);
    }
    // Buses (each with a meter after its fader), sends and every track's output,
    // as in the offline graph (m5b-engine-buses-sends).
    engine::MixHooks hooks;
    hooks.insert = [&compiled](const model::PluginSlot& slot, graph::NodeId node) {
        compiled.slots.emplace(pluginSlotKey(slot.id), node);
    };
    hooks.afterFader = [&compiled, &builder](const model::Bus& bus, graph::NodeId fader) {
        const graph::NodeId meter = builder.add(std::make_unique<graph::MeterNode>(2), "bus." + bus.id + ".meter");
        builder.connect(fader, meter);
        compiled.meterSlots.emplace(busSlotKey(bus.id), meter);
        return meter;
    };
    const engine::MixWiring wiring = engine::wireMix(builder, document, master, flatTracks, taps, plugins, hooks);
    for (const auto& [busId, fader] : wiring.busFaders) {
        compiled.slots.emplace(busSlotKey(busId), fader);
    }
    for (const auto& [sendId, node] : wiring.sends) {
        compiled.slots.emplace(sendSlotKey(sendId), node);
    }
    // The master gain after the sum of the tracks (m5b-engine-master): a stereo
    // fader at pan centre, which multiplies by exactly 1.0f at 0 dB.
    const model::Master* masterEntity = document.master();
    const graph::NodeId masterGain = builder.add(
        std::make_unique<graph::TrackFaderNode>(2, masterEntity != nullptr ? masterEntity->gain.milliDb : 0, 0, false),
        "master.gain");
    builder.connect(master, masterGain);
    compiled.slots.emplace(masterSlotKey(), masterGain);
    // The master meter is the output, so it sees the final mix after the gain.
    const graph::NodeId masterMeter = builder.add(std::make_unique<graph::MeterNode>(2), "master.meter");
    builder.connect(masterGain, masterMeter);
    compiled.meterSlots.emplace(masterMeterKey(), masterMeter);
    builder.setOutput(masterMeter);
    compiled.graph = std::move(builder).compile(options.maxBlockFrames);
    if (plugins != nullptr) {
        plugins->pinCompiled();
    }
    return compiled;
}

// True when the edit changes nothing but track gain, pan or mute, the master
// gain (a parameter of the master gain node however the entity changes), bus
// gain, pan or mute, send level or enabled (while the solo-silence set stays
// the same), and the locators (the transport's cycle range, never part of a
// graph).
bool onlyFaderChanges(const model::Document& before, const model::Document& after) {
    bool mixChanged = false;
    for (const model::DiffEntry& entry : model::diff(before, after)) {
        if (entry.entity.type == model::EntityType::locators || entry.entity.type == model::EntityType::master) {
            continue;
        }
        if (entry.entity.type == model::EntityType::bus || entry.entity.type == model::EntityType::send) {
            if (entry.change != model::DiffEntry::Change::modified) {
                return false;
            }
            mixChanged = true;
            if (entry.entity.type == model::EntityType::bus) {
                model::Bus faderOnly = *before.bus(entry.entity.id);
                const model::Bus& now = *after.bus(entry.entity.id);
                faderOnly.gain = now.gain;
                faderOnly.pan = now.pan;
                faderOnly.mute = now.mute;
                if (!(faderOnly == now)) {
                    return false;
                }
            } else {
                model::Send levelOnly = *before.send(entry.entity.id);
                const model::Send& now = *after.send(entry.entity.id);
                levelOnly.level = now.level;
                levelOnly.enabled = now.enabled;
                if (!(levelOnly == now)) {
                    return false;
                }
            }
            continue;
        }
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
        faderOnly.notes = now->notes;  // text, not sound (m5b-engine-track-notes)
        if (!(faderOnly == *now)) {
            return false;
        }
    }
    // An enabled flag decides what a channel reaches, so it can change who is
    // solo-silenced: then the graph is compiled again.
    return !mixChanged || engine::soloSilencedRefs(before) == engine::soloSilencedRefs(after);
}

// Every parameter set an edit that onlyFaderChanges() accepted needs, except the
// locators (the transport's).
void setParameters(realtime::ControlDispatcher& dispatcher, const model::Document& before,
                   const model::Document& after) {
    for (const model::DiffEntry& entry : model::diff(before, after)) {
        switch (entry.entity.type) {
            case model::EntityType::master:
                dispatcher.setParameter(realtime::ParamKey{masterSlotKey(), graph::TrackFaderNode::kGainMilliDb},
                                        masterValue(after), 0);
                break;
            case model::EntityType::bus: {
                const model::Bus& old = *before.bus(entry.entity.id);
                const model::Bus& now = *after.bus(entry.entity.id);
                for (const std::uint32_t paramId : {graph::TrackFaderNode::kGainMilliDb, graph::TrackFaderNode::kPan,
                                                    graph::TrackFaderNode::kMute}) {
                    if (busValue(old, paramId) != busValue(now, paramId)) {
                        dispatcher.setParameter(realtime::ParamKey{busSlotKey(now.id), paramId}, busValue(now, paramId), 0);
                    }
                }
                break;
            }
            case model::EntityType::send: {
                const model::Send& old = *before.send(entry.entity.id);
                const model::Send& now = *after.send(entry.entity.id);
                for (const std::uint32_t paramId : {graph::SendNode::kLevelMilliDb, graph::SendNode::kEnabled}) {
                    if (sendValue(old, paramId) != sendValue(now, paramId)) {
                        dispatcher.setParameter(realtime::ParamKey{sendSlotKey(now.id), paramId}, sendValue(now, paramId),
                                                0);
                    }
                }
                break;
            }
            case model::EntityType::track: {
                const model::Track& old = *before.track(entry.entity.id);
                const model::Track& now = *after.track(entry.entity.id);
                const std::string key = trackSlotKey(now.id);
                for (const std::uint32_t paramId :
                     {graph::TrackFaderNode::kGainMilliDb, graph::TrackFaderNode::kPan, graph::TrackFaderNode::kMute}) {
                    if (documentValue(old, paramId) != documentValue(now, paramId)) {
                        dispatcher.setParameter(realtime::ParamKey{key, paramId}, documentValue(now, paramId), 0);
                    }
                }
                // A track mute silences its sends too, pre-fader ones included.
                if (old.mute != now.mute) {
                    for (const std::string& sendId : now.sends) {
                        dispatcher.setParameter(realtime::ParamKey{sendSlotKey(sendId), graph::SendNode::kSourceMute},
                                                now.mute ? 1.0 : 0.0, 0);
                    }
                }
                break;
            }
            default:
                break;  // the locators go to the transport
        }
    }
}

// A new stream that does not report ready within this time is published
// anyway; it counts underruns until the butler catches up (as a late locate).
constexpr std::chrono::seconds kPrefillTimeout{1};

}  // namespace

std::string trackSlotKey(const std::string& trackId) {
    return "track:" + trackId;
}

std::string pluginSlotKey(const std::string& slotId) {
    return "plugin:" + slotId;
}

std::string masterMeterKey() {
    return "master";
}

std::string masterSlotKey() {
    return "master:master";
}

std::string busSlotKey(const std::string& busId) {
    return "bus:" + busId;
}

std::string sendSlotKey(const std::string& sendId) {
    return "send:" + sendId;
}

CompiledPlayback compileForPlayback(const model::Document& document, const std::filesystem::path& bundle,
                                    const PlaybackOptions& options, PluginInstanceTable* plugins) {
    return compileWith(document, bundle, options, nullptr, nullptr, plugins);
}

PlaybackEngine::PlaybackEngine(session::Session& session, PlaybackOptions options)
    : session_(session),
      options_(std::move(options)),
      plugins_(options_.pluginHosts, options_.pluginRegistry, session.bundlePath(),
               session.history().head().document.root().sampleRate,
               options_.maxBlockFrames, options_.pluginEventCapacity),
      butler_(options_.butler),
      driver_(realtime::GraphDriver::Options{options_.fadeFrames, std::chrono::milliseconds(500),
                                             realtime::GraphDriver::kDefaultMeterCapacity,
                                             [this](std::uint64_t epoch) { retired(epoch); }, options_.callbackClock,
                                             options_.capture}),
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
    hearTimeline(head, nullptr);
    latest_ = head;
    loaded_ = true;
}

void PlaybackEngine::hearTimeline(const model::Document& document, const model::Document* before) {
    const model::Locators* locators = document.locators();
    transport_.setRegion(locators ? std::optional{std::pair{locators->left, locators->right}} : std::nullopt);
    const model::Root& root = document.root();
    if (before == nullptr || before->root().tempo != root.tempo || before->root().sampleRate != root.sampleRate) {
        driver_.setClickTempo(realtime::ClickTempo::build(root.tempo, root.sampleRate));
    }
}

void PlaybackEngine::setCycle(bool enabled) {
    transport_.setCycle(enabled);
}

bool PlaybackEngine::cycle() const {
    return transport_.cycle();
}

void PlaybackEngine::setClick(bool enabled, std::int32_t gainMilliDb) {
    if (gainMilliDb < realtime::ClickSettings::kMinGainMilliDb || gainMilliDb > realtime::ClickSettings::kMaxGainMilliDb) {
        throw std::invalid_argument("the click gain must be in [-60000, 0] milli-dB");
    }
    click_ = realtime::ClickSettings{enabled, gainMilliDb};
    driver_.setClick(enabled, realtime::clickGain(gainMilliDb));
}

void PlaybackEngine::compile(const model::Document& document) {
    detail::PreparedPlayback prepared;
    CompiledPlayback compiled = compileWith(
        document, session_.bundlePath(), options_,
        [this](const std::string& trackId, const detail::StreamKey& key) -> realtime::DiskStream* {
            const auto live = liveTracks_.find(trackId);
            return live != liveTracks_.end() && live->second.key == key ? live->second.stream : nullptr;
        },
        &prepared.tracks, &plugins_);
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
    plugins_.published(epoch);
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
    plugins_.retired(epoch);  // destroys, on this thread, the instances nothing pins
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
    hearTimeline(document, &*latest_);
    if (!prepared_ && !pendingDoc_ && onlyFaderChanges(*latest_, document)) {
        setParameters(dispatcher_, *latest_, document);
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
    host::AudioDeviceConfig sessionConfig = config;
    sessionConfig.sampleRate = session_.history().head().document.root().sampleRate;
    if (options_.playOnStart) {
        driver_.play();
    }
    driver_.start(device, sessionConfig);
    plugins_.setBlocksComing(true);
}

void PlaybackEngine::stop() {
    driver_.stop();
    plugins_.setBlocksComing(false);
    butler_.stop();
}

void PlaybackEngine::beginGesture(const std::string& target, std::uint32_t paramId) {
    requireCommittable(target, paramId);  // so no gesture opens that endGesture cannot close
    dispatcher_.beginGesture(gestureKey(target, paramId));
}

void PlaybackEngine::updateGesture(const std::string& target, std::uint32_t paramId, double value, int rampFrames) {
    requireCommittable(target, paramId);
    dispatcher_.updateGesture(gestureKey(target, paramId), value, rampFrames);
    // A held track mute silences the track's sends as the committed mute will.
    if (paramId == graph::TrackFaderNode::kMute && !isMasterTarget(target) && !isBusTarget(target) &&
        !isSendTarget(target) && !std::isnan(value)) {
        if (const model::Track* track = gestureDocument().track(target)) {
            for (const std::string& sendId : track->sends) {
                dispatcher_.setParameter(realtime::ParamKey{sendSlotKey(sendId), graph::SendNode::kSourceMute},
                                         value != 0.0 ? 1.0 : 0.0, rampFrames);
            }
        }
    }
}

const model::Document& PlaybackEngine::gestureDocument() const {
    const command::History& history = session_.history();
    return gestureBranch_ && history.isOpen(*gestureBranch_) ? history.branchHead(*gestureBranch_).document
                                                             : history.head().document;
}

void PlaybackEngine::setGestureValue(const std::string& target, std::uint32_t paramId, double value) {
    dispatcher_.setParameter(gestureKey(target, paramId), value, 0);
    if (paramId == graph::TrackFaderNode::kMute && !isMasterTarget(target) && !isBusTarget(target) &&
        !isSendTarget(target)) {
        if (const model::Track* track = gestureDocument().track(target)) {
            for (const std::string& sendId : track->sends) {
                dispatcher_.setParameter(realtime::ParamKey{sendSlotKey(sendId), graph::SendNode::kSourceMute},
                                         value != 0.0 ? 1.0 : 0.0, 0);
            }
        }
    }
}

void PlaybackEngine::cancelGesture(const std::string& target, std::uint32_t paramId) {
    requireCommittable(target, paramId);
    (void)dispatcher_.endGesture(gestureKey(target, paramId));  // the value is dropped
    const model::Document& document = gestureDocument();
    if (isMasterTarget(target)) {
        setGestureValue(target, paramId, masterValue(document));
    } else if (isBusTarget(target)) {
        if (const model::Bus* bus = document.bus(targetId(target))) {
            setGestureValue(target, paramId, busValue(*bus, paramId));
        }
    } else if (isSendTarget(target)) {
        if (const model::Send* send = document.send(targetId(target))) {
            setGestureValue(target, paramId, sendValue(*send, paramId));
        }
    } else if (const model::Track* track = document.track(target)) {
        setGestureValue(target, paramId, documentValue(*track, paramId));
    }
}

const command::Revision* PlaybackEngine::endGesture(const std::string& target, std::uint32_t paramId,
                                                    std::string actor, std::string time) {
    requireCommittable(target, paramId);
    const realtime::ParamKey key = gestureKey(target, paramId);
    const std::optional<double> value = dispatcher_.endGesture(key);
    if (!value) {
        return nullptr;
    }
    try {
        if (gestureBranch_ && !session_.history().isOpen(*gestureBranch_)) {
            // The heard branch was merged or discarded on the session, not
            // through the Auditioner (spec, "Proposal audition (A/B)").
            throw AuditionError("audition_not_found", "the proposal branch " + *gestureBranch_ +
                                                          " heard for this gesture is closed; hear main first");
        }
        const GestureCommit commit = gestureCommit(target, paramId, *value);
        const command::Revision& revision =
            gestureBranch_ ? session_.commitOn(*gestureBranch_, {commit.command}, std::move(actor), std::move(time))
                           : session_.commit({commit.command}, std::move(actor), std::move(time));
        // The committed value reaches the audio thread through the dispatcher.
        setGestureValue(target, paramId, commit.value);
        return &revision;
    } catch (...) {
        // Nothing was committed: the sound returns to the document's value.
        const model::Document& document = gestureDocument();
        if (isMasterTarget(target)) {
            setGestureValue(target, paramId, masterValue(document));
        } else if (isBusTarget(target)) {
            if (const model::Bus* bus = document.bus(targetId(target))) {
                setGestureValue(target, paramId, busValue(*bus, paramId));
            }
        } else if (isSendTarget(target)) {
            if (const model::Send* send = document.send(targetId(target))) {
                setGestureValue(target, paramId, sendValue(*send, paramId));
            }
        } else if (const model::Track* track = document.track(target)) {
            setGestureValue(target, paramId, documentValue(*track, paramId));
        }
        throw;
    }
}

void PlaybackEngine::tick() {
    plugins_.tick();  // pluginEventAny, on this thread
    transport_.tick();
    dispatcher_.tick();
    driver_.poll();
    if (driver_.state() != realtime::DriverState::realtime) {
        plugins_.setBlocksComing(false);  // the device stopped on its own (device_lost)
    }
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

AuditionCost PlaybackEngine::estimateCost(const model::Document& document) const {
    AuditionCost cost;
    std::size_t ringFrames = 1;
    while (ringFrames < options_.ringFrames) {
        ringFrames <<= 1;  // as realtime::FrameRing rounds its capacity
    }
    const std::vector<engine::FlatTrack> flat = engine::flattenClips(document);
    for (const engine::FlatTrack& track : flat) {
        const auto live = liveTracks_.find(track.track->id);
        if (live != liveTracks_.end() && live->second.key == streamKey(track)) {
            continue;
        }
        ++cost.newStreams;
        cost.bytes += 2 * ringFrames * static_cast<std::size_t>(track.track->channels) * sizeof(float);
    }
    // As compileWith(): the master bus, its gain and its meter, per track a
    // player, a fader and a meter, per bus a sum, a fader and a meter, a node
    // per send, and the plugin slots.
    cost.nodes = 3 + 3 * flat.size() + 3 * document.allBuses().size() + document.allSends().size() +
                 document.allPluginSlots().size();
    return cost;
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
