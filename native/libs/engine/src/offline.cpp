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

MediaLibrary loadMedia(const model::Document& document, const std::filesystem::path& bundle) {
    MediaLibrary library;
    for (const model::Media* media : document.allMedia()) {
        if (library.media.count(media->contentHash) != 0) {
            continue;
        }
        const auto file = session::mediaPath(bundle, media->contentHash);
        if (!std::filesystem::exists(file)) {
            throw EngineError("media_missing", "media " + media->id + " has no file at " + file.string());
        }
        const std::string bytes = io::readFile(file);
        if (hash::sha256(bytes) != media->contentHash) {
            throw EngineError("media_hash_mismatch", "the file for media " + media->id + " does not match its hash");
        }
        const media::AudioBuffer decoded = media::decodeWav(bytes);
        if (decoded.info.channels != media->channels || decoded.info.frames != media->frames ||
            decoded.info.sampleRate != media->sampleRate) {
            throw EngineError("media_mismatch", "the file for media " + media->id + " differs from its entity");
        }
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

std::int64_t documentEnd(const model::Document& document) {
    const auto& root = document.root();
    const time::TempoMap tempo(root.tempo);
    std::int64_t end = 0;
    for (const model::Track* track : document.tracksInOrder()) {
        for (const model::Clip* clip : document.clipsOnTrack(track->id)) {
            end = std::max(end, timelineStart(*clip, tempo, root.sampleRate) + clip->length);
        }
    }
    return end;
}

std::unique_ptr<graph::PreparedGraph> compileDocument(const model::Document& document, const MediaLibrary& library,
                                                      int maxBlockFrames) {
    const auto& root = document.root();
    const time::TempoMap tempo(root.tempo);
    const auto tracks = document.tracksInOrder();
    const bool anySolo = std::any_of(tracks.begin(), tracks.end(), [](const model::Track* t) { return t->solo; });

    GraphBuilder builder;
    const NodeId master = builder.add(std::make_unique<BusNode>(2), "master");
    for (const model::Track* track : tracks) {
        std::vector<ClipPlayerNode::Clip> clips;
        for (const model::Clip* clip : document.clipsOnTrack(track->id)) {
            const model::Media* media = document.media(clip->mediaId);
            const auto found = library.media.find(media->contentHash);
            if (found == library.media.end()) {
                throw EngineError("media_missing", "media " + media->id + " is not loaded");
            }
            clips.push_back(ClipPlayerNode::Clip{timelineStart(*clip, tempo, root.sampleRate), clip->sourceStart,
                                                 clip->length, graph::gainFromMilliDb(clip->gain.milliDb),
                                                 found->second});
        }
        const bool silenced = track->mute || (anySolo && !track->solo);
        const NodeId player = builder.add(std::make_unique<ClipPlayerNode>(track->channels, std::move(clips)),
                                          track->id + ".clips");
        const NodeId fader = builder.add(
            std::make_unique<TrackFaderNode>(track->channels, track->gain.milliDb, track->pan, silenced),
            track->id + ".fader");
        builder.connect(player, fader);
        builder.connect(fader, master);
    }
    builder.setOutput(master);
    return std::move(builder).compile(maxBlockFrames);
}

media::AudioBuffer renderOffline(const model::Document& document, const MediaLibrary& library,
                                 const RenderOptions& options) {
    if (options.start < 0 || options.blockFrames <= 0 || options.frames < -1) {
        throw EngineError("invalid_render_range", "the render range or block size is invalid");
    }
    const std::int64_t frames =
        options.frames >= 0 ? options.frames : std::max<std::int64_t>(0, documentEnd(document) - options.start);

    auto graph = compileDocument(document, library, options.blockFrames);
    const std::int64_t latency = graph->totalLatency();

    media::AudioBuffer out;
    out.info = media::AudioInfo{2, document.root().sampleRate, frames};
    out.samples.assign(static_cast<std::size_t>(frames * 2), 0.0f);

    // Process latency extra frames and drop the first `latency` outputs, so the
    // output frame i is the timeline sample start + i.
    const std::int64_t total = frames + latency;
    for (std::int64_t done = 0; done < total; done += options.blockFrames) {
        const int n = static_cast<int>(std::min<std::int64_t>(options.blockFrames, total - done));
        graph->process(graph::ProcessContext{options.start + done, n});
        const auto& view = graph->output();
        for (int i = 0; i < n; ++i) {
            const std::int64_t index = done + i - latency;
            if (index < 0) {
                continue;
            }
            out.samples[static_cast<std::size_t>(index * 2)] = view.channel(0)[i];
            out.samples[static_cast<std::size_t>(index * 2 + 1)] = view.channel(1)[i];
        }
    }
    return out;
}

}  // namespace siann::engine
