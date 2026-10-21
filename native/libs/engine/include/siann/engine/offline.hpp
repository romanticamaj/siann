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

// Decodes every media file the document references from <bundle>/media and
// checks each file's hash and shape against its media entity.
MediaLibrary loadMedia(const model::Document& document, const std::filesystem::path& bundle);

std::unique_ptr<graph::PreparedGraph> compileDocument(const model::Document& document, const MediaLibrary& library,
                                                      int maxBlockFrames);

// End of the last clip, in samples; 0 for an empty session.
std::int64_t documentEnd(const model::Document& document);

struct RenderOptions {
    std::int64_t start = 0;
    std::int64_t frames = -1;  // -1: from start to documentEnd()
    int blockFrames = 512;
};

// Stereo, 32-bit float, at the session rate.
media::AudioBuffer renderOffline(const model::Document& document, const MediaLibrary& library,
                                 const RenderOptions& options = {});

}  // namespace siann::engine
