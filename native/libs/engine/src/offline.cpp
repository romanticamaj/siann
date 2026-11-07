#include "siann/engine/offline.hpp"

#include <algorithm>
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

std::vector<FlatTrack> flattenClips(const model::Document& document) {
    const auto& root = document.root();
    const time::TempoMap tempo(root.tempo);
    const auto tracks = document.tracksInOrder();
    const bool anySolo = std::any_of(tracks.begin(), tracks.end(), [](const model::Track* t) { return t->solo; });
    std::vector<FlatTrack> flat;
    flat.reserve(tracks.size());
    for (const model::Track* track : tracks) {
        FlatTrack& entry = flat.emplace_back();
        entry.track = track;
        entry.soloSilenced = anySolo && !track->solo;
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
    for (const FlatTrack& flat : flattenClips(document)) {
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
        builder.connect(fader, master);
    }
    builder.setOutput(master);
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
