#include "siann/engine/offline.hpp"

#include <algorithm>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "siann/io/durable_file.hpp"
#include "siann/session/media_import.hpp"
#include "siann/time/tempo_map.hpp"

namespace siann::engine {

using graph::BusNode;
using graph::ClipPlayerNode;
using graph::GraphBuilder;
using graph::NodeId;
using graph::PlanarAudio;
using graph::TrackFaderNode;

EngineError::EngineError(std::string code, const std::string& message)
    : std::runtime_error(message), code_(std::move(code)) {}

namespace {

std::int64_t timelineStart(const model::Clip& clip, const time::TempoMap& tempo, std::int64_t rate) {
    if (clip.position.domain == time::Domain::audio) {
        return clip.position.value;
    }
    return tempo.toAudio(time::MusicTime{clip.position.value}, rate).samples;
}

}  // namespace

media::AudioBuffer readMedia(const model::Media& entity, const std::filesystem::path& bundle) {
    const auto file = session::mediaPath(bundle, entity.contentHash, entity.format);
    if (!std::filesystem::exists(file)) {
        throw EngineError("media_missing", "media " + entity.id + " has no file at " + file.string());
    }
    const std::string bytes = io::readFile(file);
    if (hash::sha256(bytes) != entity.contentHash) {
        throw EngineError("media_hash_mismatch", "the file for media " + entity.id + " does not match its hash");
    }
    media::AudioBuffer decoded = media::decode(bytes);
    if (decoded.info.channels != entity.channels || decoded.info.frames != entity.frames ||
        decoded.info.sampleRate != entity.sampleRate) {
        throw EngineError("media_mismatch", "the file for media " + entity.id + " differs from its entity");
    }
    return decoded;
}

MediaLibrary loadMedia(const model::Document& document, const std::filesystem::path& bundle) {
    MediaLibrary library;
    for (const model::Media* media : document.allMedia()) {
        if (library.media.count(media->contentHash) != 0) {
            continue;
        }
        const media::AudioBuffer decoded = readMedia(*media, bundle);
        auto planar = std::make_shared<PlanarAudio>();
        planar->channels = decoded.info.channels;
        planar->frames = decoded.info.frames;
        planar->data.assign(static_cast<std::size_t>(planar->channels),
                            std::vector<float>(static_cast<std::size_t>(planar->frames)));
        const auto channels = static_cast<std::size_t>(planar->channels);
        for (std::size_t i = 0; i < static_cast<std::size_t>(planar->frames); ++i) {
            for (std::size_t c = 0; c < channels; ++c) {
                planar->data[c][i] = decoded.samples[i * channels + c];
            }
        }
        library.media.emplace(media->contentHash, std::move(planar));
    }
    return library;
}

std::set<std::string> soloSilencedRefs(const model::Document& document) {
    const auto tracks = document.tracksInOrder();
    const auto buses = document.allBuses();
    const bool anySolo = std::any_of(tracks.begin(), tracks.end(), [](const model::Track* t) { return t->solo; }) ||
                         std::any_of(buses.begin(), buses.end(), [](const model::Bus* b) { return b->solo; });
    std::set<std::string> silenced;
    if (!anySolo) {
        return silenced;
    }
    // Direct successors: the output bus and, for a track, its enabled sends' buses.
    std::map<std::string, std::vector<std::string>> next;
    std::map<std::string, bool> soloed;
    for (const model::Track* t : tracks) {
        const std::string ref = "track:" + t->id;
        soloed[ref] = t->solo;
        auto& out = next[ref];
        if (t->output) {
            out.push_back("bus:" + *t->output);
        }
        for (const model::Send* s : document.sendsOnTrack(t->id)) {
            if (s->enabled) {
                out.push_back("bus:" + s->busId);
            }
        }
    }
    for (const model::Bus* b : buses) {
        const std::string ref = "bus:" + b->id;
        soloed[ref] = b->solo;
        auto& out = next[ref];
        if (b->output) {
            out.push_back("bus:" + *b->output);
        }
    }
    // Everything each channel reaches (bus chains are acyclic in a valid document).
    std::map<std::string, std::set<std::string>> reach;
    for (const auto& [ref, ignored] : next) {
        std::set<std::string>& reached = reach[ref];
        std::vector<std::string> stack = next[ref];
        while (!stack.empty()) {
            const std::string at = std::move(stack.back());
            stack.pop_back();
            if (!reached.insert(at).second) {
                continue;
            }
            const auto found = next.find(at);
            if (found != next.end()) {
                stack.insert(stack.end(), found->second.begin(), found->second.end());
            }
        }
    }
    std::set<std::string> audible;  // soloed, reaching a soloed channel, or reached by one
    for (const auto& [ref, reached] : reach) {
        const bool isSoloed = soloed[ref];
        if (isSoloed) {
            audible.insert(ref);
            audible.insert(reached.begin(), reached.end());
        }
        if (std::any_of(reached.begin(), reached.end(), [&](const std::string& r) { return soloed[r]; })) {
            audible.insert(ref);
        }
    }
    for (const auto& [ref, ignored] : next) {
        if (audible.count(ref) == 0) {
            silenced.insert(ref);
        }
    }
    return silenced;
}

std::vector<FlatBus> flattenBuses(const model::Document& document) {
    const auto silenced = soloSilencedRefs(document);
    const std::vector<const model::Bus*> order = document.busesInOrder();
    // Kahn over output edges: a bus is ready once every bus feeding it is placed.
    std::map<std::string, int> feeding;
    for (const model::Bus* b : order) {
        feeding.emplace(b->id, 0);
    }
    for (const model::Bus* b : order) {
        if (b->output && feeding.count(*b->output) != 0) {
            ++feeding[*b->output];
        }
    }
    std::vector<FlatBus> out;
    std::set<std::string> placed;
    while (out.size() < order.size()) {
        bool progressed = false;
        for (const model::Bus* b : order) {
            if (placed.count(b->id) != 0 || feeding[b->id] != 0) {
                continue;
            }
            placed.insert(b->id);
            out.push_back(FlatBus{b, silenced.count("bus:" + b->id) != 0});
            if (b->output && feeding.count(*b->output) != 0) {
                --feeding[*b->output];
            }
            progressed = true;
            break;  // restart, so ties keep busOrder
        }
        if (!progressed) {
            throw EngineError("routing_cycle", "the document's bus outputs form a cycle");
        }
    }
    return out;
}

MixWiring wireMix(GraphBuilder& builder, const model::Document& document, NodeId master,
                  const std::vector<FlatTrack>& flat, const std::map<std::string, TrackTaps>& tracks,
                  const PluginNodeSource* plugins, const MixHooks& hooks) {
    MixWiring wiring;
    const std::vector<FlatBus> buses = flattenBuses(document);
    std::map<std::string, NodeId> sums;
    for (const FlatBus& entry : buses) {
        sums.emplace(entry.bus->id, builder.add(std::make_unique<BusNode>(2), "bus." + entry.bus->id));
    }
    auto destination = [&](const std::optional<std::string>& output) {
        return output ? sums.at(*output) : master;
    };
    for (const FlatBus& entry : buses) {
        const model::Bus& bus = *entry.bus;
        NodeId previous = sums.at(bus.id);
        if (plugins != nullptr) {
            for (const model::PluginSlot* slot : document.slotsOnBus(bus.id)) {
                if (auto node = plugins->pluginNode(*slot, 2)) {
                    const NodeId insert = builder.add(std::move(node), "bus." + bus.id + ".insert." + slot->id);
                    if (hooks.insert) {
                        hooks.insert(*slot, insert);
                    }
                    builder.connect(previous, insert);
                    previous = insert;
                }
            }
        }
        const NodeId fader = builder.add(
            std::make_unique<TrackFaderNode>(2, bus.gain.milliDb, bus.pan, bus.mute, entry.soloSilenced),
            "bus." + bus.id + ".fader");
        builder.connect(previous, fader);
        wiring.busFaders.emplace(bus.id, fader);
        const NodeId out = hooks.afterFader ? hooks.afterFader(bus, fader) : fader;
        builder.connect(out, destination(bus.output));
    }
    for (const FlatTrack& entry : flat) {
        const model::Track& track = *entry.track;
        const TrackTaps& taps = tracks.at(track.id);
        builder.connect(taps.postFader, destination(track.output));
        for (const model::Send* send : document.sendsOnTrack(track.id)) {
            const int channels = send->pre ? track.channels : 2;
            const NodeId node = builder.add(std::make_unique<graph::SendNode>(channels, send->level.milliDb,
                                                                              send->enabled, track.mute,
                                                                              entry.soloSilenced),
                                            "send." + send->id);
            builder.connect(send->pre ? taps.preFader : taps.postFader, node);
            builder.connect(node, sums.at(send->busId));
            wiring.sends.emplace(send->id, node);
        }
    }
    return wiring;
}

std::vector<FlatTrack> flattenClips(const model::Document& document) {
    const auto& root = document.root();
    const time::TempoMap tempo(root.tempo);
    const auto tracks = document.tracksInOrder();
    const std::set<std::string> silencedBySolo = soloSilencedRefs(document);
    std::vector<FlatTrack> flat;
    flat.reserve(tracks.size());
    for (const model::Track* track : tracks) {
        FlatTrack& entry = flat.emplace_back();
        entry.track = track;
        entry.soloSilenced = silencedBySolo.count("track:" + track->id) != 0;
        entry.silenced = track->mute || entry.soloSilenced;
        for (const model::Clip* clip : document.clipsOnTrack(track->id)) {
            entry.clips.push_back(FlatClip{timelineStart(*clip, tempo, root.sampleRate), clip->sourceStart,
                                           clip->length, graph::gainFromMilliDb(clip->gain.milliDb),
                                           document.media(clip->mediaId)});
        }
    }
    return flat;
}

std::int64_t documentEnd(const model::Document& document) {
    std::int64_t end = 0;
    for (const FlatTrack& track : flattenClips(document)) {
        for (const FlatClip& clip : track.clips) {
            end = std::max(end, clip.timelineStart + clip.length);
        }
    }
    return end;
}

std::unique_ptr<graph::PreparedGraph> compileDocument(const model::Document& document, const MediaLibrary& library,
                                                      int maxBlockFrames, const PluginNodeSource* plugins) {
    GraphBuilder builder;
    const NodeId master = builder.add(std::make_unique<BusNode>(2), "master");
    const std::vector<FlatTrack> flatTracks = flattenClips(document);
    std::map<std::string, TrackTaps> taps;
    for (const FlatTrack& flat : flatTracks) {
        const model::Track& track = *flat.track;
        std::vector<ClipPlayerNode::Clip> clips;
        for (const FlatClip& clip : flat.clips) {
            const auto found = library.media.find(clip.media->contentHash);
            if (found == library.media.end()) {
                throw EngineError("media_missing", "media " + clip.media->id + " is not loaded");
            }
            clips.push_back(
                ClipPlayerNode::Clip{clip.timelineStart, clip.sourceStart, clip.length, clip.gain, found->second});
        }
        const NodeId player =
            builder.add(std::make_unique<ClipPlayerNode>(track.channels, std::move(clips)), track.id + ".clips");
        const NodeId fader = builder.add(
            std::make_unique<TrackFaderNode>(track.channels, track.gain.milliDb, track.pan, track.mute,
                                             flat.soloSilenced),
            track.id + ".fader");
        // The inserts between player and fader; a slot without a node passes through.
        NodeId previous = player;
        if (plugins != nullptr) {
            for (const model::PluginSlot* slot : document.slotsOnTrack(track.id)) {
                if (auto node = plugins->pluginNode(*slot, track.channels)) {
                    const NodeId insert = builder.add(std::move(node), track.id + ".insert." + slot->id);
                    builder.connect(previous, insert);
                    previous = insert;
                }
            }
        }
        builder.connect(previous, fader);
        taps.emplace(track.id, TrackTaps{previous, fader});
    }
    // Buses, sends and each track's output (m5b-engine-buses-sends); a document
    // without buses connects every fader to the master, as before.
    wireMix(builder, document, master, flatTracks, taps, plugins);
    // The master gain on the sum (m5b-engine-master; spec, "Master path"): the
    // realtime graph's node, a stereo fader at pan centre, exactly 1.0f at 0 dB,
    // so a document without the entity renders as before.
    const model::Master* masterEntity = document.master();
    const NodeId masterGain = builder.add(
        std::make_unique<TrackFaderNode>(2, masterEntity != nullptr ? masterEntity->gain.milliDb : 0, 0, false),
        "master.gain");
    builder.connect(master, masterGain);
    builder.setOutput(masterGain);
    return std::move(builder).compile(maxBlockFrames);
}

media::AudioBuffer renderOffline(const model::Document& document, const MediaLibrary& library,
                                 const RenderOptions& options, const PluginNodeSource* plugins) {
    if (options.start < 0 || options.blockFrames <= 0 || options.frames < -1) {
        throw EngineError("invalid_render_range", "the render range or block size is invalid");
    }
    const std::int64_t frames =
        options.frames >= 0 ? options.frames : std::max<std::int64_t>(0, documentEnd(document) - options.start);

    auto graph = compileDocument(document, library, options.blockFrames, plugins);
    return renderGraph(*graph, options.start, frames, document.root().sampleRate);
}

media::AudioBuffer renderGraph(graph::PreparedGraph& prepared, std::int64_t start, std::int64_t frames,
                               std::int64_t sampleRate) {
    const std::int64_t latency = prepared.totalLatency();
    const int block = prepared.maxBlockFrames();
    const int channels = prepared.outputChannels();

    media::AudioBuffer out;
    out.info = media::AudioInfo{channels, sampleRate, frames};
    out.samples.assign(static_cast<std::size_t>(frames * channels), 0.0f);

    // Process latency extra frames and drop the first `latency` outputs, so the
    // output frame i is the timeline sample start + i.
    const std::int64_t total = frames + latency;
    for (std::int64_t done = 0; done < total; done += block) {
        const int n = static_cast<int>(std::min<std::int64_t>(block, total - done));
        prepared.process(graph::ProcessContext{start + done, n});
        const auto& view = prepared.output();
        for (int i = 0; i < n; ++i) {
            const std::int64_t index = done + i - latency;
            if (index < 0) {
                continue;
            }
            for (int c = 0; c < channels; ++c) {
                out.samples[static_cast<std::size_t>(index * channels + c)] = view.channel(c)[i];
            }
        }
    }
    return out;
}

}  // namespace siann::engine
