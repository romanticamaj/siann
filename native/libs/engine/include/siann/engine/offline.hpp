#pragma once

// Offline rendering of a session document (M1). The document compiles into the
// same graph code the realtime engine will use: per track, a clip player into
// a track fader into the master bus. The rendered output is shifted by the
// graph's total latency, so it lines up with the timeline.

#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "siann/graph/graph.hpp"
#include "siann/graph/nodes.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/media/audio.hpp"
#include "siann/model/document.hpp"

namespace siann::engine {

class EngineError : public std::runtime_error {
public:
    EngineError(std::string code, const std::string& message);

    // One of: media_missing, media_hash_mismatch, media_mismatch,
    // invalid_render_range.
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

// Decoded media by content hash.
struct MediaLibrary {
    std::map<hash::Digest, std::shared_ptr<const graph::PlanarAudio>> media;
};

// Reads and decodes one media file from <bundle>/media, checking its hash and
// shape against the entity (media_missing, media_hash_mismatch,
// media_mismatch).
media::AudioBuffer readMedia(const model::Media& entity, const std::filesystem::path& bundle);

// Decodes every media file the document references from <bundle>/media and
// checks each file's hash and shape against its media entity.
MediaLibrary loadMedia(const model::Document& document, const std::filesystem::path& bundle);

// A document's clips resolved to the timeline, per track in track order. The
// offline graph (compileDocument) and the streaming graph (siann-playback)
// are both built from this, so they agree by construction. Pointers refer
// into the document.
struct FlatClip {
    std::int64_t timelineStart = 0;  // samples
    std::int64_t sourceStart = 0;    // media frames
    std::int64_t length = 0;         // frames
    float gain = 1.0f;
    const model::Media* media = nullptr;
};

struct FlatTrack {
    const model::Track* track = nullptr;
    bool silenced = false;      // muted, or not soloed while another track is
    bool soloSilenced = false;  // not soloed while another track is
    std::vector<FlatClip> clips;
};

std::vector<FlatTrack> flattenClips(const model::Document& document);

// The nodes for a document's plugin slots (m4-plugin-node): the live instance
// table (siann-playback) and a render's own instance set implement it. A slot
// it returns nullptr for compiles as pass-through, like a missing plugin.
class PluginNodeSource {
public:
    virtual ~PluginNodeSource() = default;
    // A node with `channels` inputs and outputs (the track's channels).
    virtual std::unique_ptr<graph::Node> pluginNode(const model::PluginSlot& slot, int channels) const = 0;
};

// Per track: clip player, the track's inserts in order (with a source), fader,
// into the master bus. Without a source every slot passes audio through.
std::unique_ptr<graph::PreparedGraph> compileDocument(const model::Document& document, const MediaLibrary& library,
                                                      int maxBlockFrames, const PluginNodeSource* plugins = nullptr);

// End of the last clip, in samples; 0 for an empty session.
std::int64_t documentEnd(const model::Document& document);

struct RenderOptions {
    std::int64_t start = 0;
    std::int64_t frames = -1;  // -1: from start to documentEnd()
    int blockFrames = 512;
};

// Renders `frames` frames of a compiled graph from timeline position `start`,
// in blocks of its maximum block size, shifted by its total latency (it
// processes frames + totalLatency() and drops the first totalLatency()), so
// output frame i is timeline sample start + i. Interleaved, with the graph's
// output channel count; info.sampleRate is `sampleRate`. The graph must be
// fresh: its delay lines start silent.
media::AudioBuffer renderGraph(graph::PreparedGraph& prepared, std::int64_t start, std::int64_t frames,
                               std::int64_t sampleRate = 0);

// Stereo, 32-bit float, at the session rate.
media::AudioBuffer renderOffline(const model::Document& document, const MediaLibrary& library,
                                 const RenderOptions& options = {});

}  // namespace siann::engine
