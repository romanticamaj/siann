#include "siann/protocol/read_model.hpp"

#include <algorithm>
#include <charconv>
#include <utility>

#include "siann/hash/sha256.hpp"

namespace siann::protocol {

namespace {

using json::Array;
using json::Object;
using json::Value;

constexpr std::string_view kSyncPrefix = "sync_";

std::optional<model::EntityType> typeFromName(std::string_view name) {
    for (const auto type : {model::EntityType::root, model::EntityType::media, model::EntityType::track,
                            model::EntityType::clip}) {
        if (model::entityTypeName(type) == name) {
            return type;
        }
    }
    return std::nullopt;
}

std::optional<std::uint64_t> parseUnsigned(std::string_view text) {
    if (text.empty() || text.size() > 19) {
        return std::nullopt;
    }
    std::uint64_t value = 0;
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
    if (error != std::errc() || end != text.data() + text.size()) {
        return std::nullopt;
    }
    return value;
}

}  // namespace

std::optional<model::EntityRef> parseRef(std::string_view text) {
    const auto colon = text.find(':');
    if (colon == std::string_view::npos || colon + 1 >= text.size()) {
        return std::nullopt;
    }
    const auto type = typeFromName(text.substr(0, colon));
    if (!type) {
        return std::nullopt;
    }
    return model::EntityRef{*type, std::string(text.substr(colon + 1))};
}

std::vector<model::EntityRef> syncOrder(const model::Document& document) {
    std::vector<model::EntityRef> out;
    out.push_back({model::EntityType::root, "root"});
    for (const model::Media* media : document.allMedia()) {
        out.push_back({model::EntityType::media, media->id});
    }
    // Tracks and clips in id order, like Document::toJson() (tracksInOrder()
    // is the arrangement order).
    std::vector<std::string> tracks;
    std::vector<std::string> clips;
    for (const model::Track* track : document.tracksInOrder()) {
        tracks.push_back(track->id);
        for (const model::Clip* clip : document.clipsOnTrack(track->id)) {
            clips.push_back(clip->id);
        }
    }
    std::sort(tracks.begin(), tracks.end());
    std::sort(clips.begin(), clips.end());
    for (auto& id : tracks) {
        out.push_back({model::EntityType::track, std::move(id)});
    }
    for (auto& id : clips) {
        out.push_back({model::EntityType::clip, std::move(id)});
    }
    return out;
}

std::optional<json::Value> entityJson(const model::Document& document, const model::EntityRef& ref) {
    switch (ref.type) {
        case model::EntityType::root:
            if (ref.id != "root") {
                return std::nullopt;
            }
            return model::toJson(document.root());
        case model::EntityType::media:
            if (const auto* media = document.media(ref.id)) {
                return model::toJson(*media);
            }
            return std::nullopt;
        case model::EntityType::track:
            if (const auto* track = document.track(ref.id)) {
                return model::toJson(*track);
            }
            return std::nullopt;
        case model::EntityType::clip:
            if (const auto* clip = document.clip(ref.id)) {
                return model::toJson(*clip);
            }
            return std::nullopt;
    }
    return std::nullopt;
}

ReadModel::ReadModel(std::size_t chunkEntities) : chunkEntities_(std::max<std::size_t>(chunkEntities, 1)) {}

json::Value ReadModel::sync(ConnectionId connection, const json::Value& params, const command::History& history,
                            const StreamPosition& position) {
    const Value* cursor = params.find("cursor");
    if (cursor != nullptr && cursor->kind() != Value::Kind::string) {
        throw ProtocolError("invalid_params", "cursor must be a string");
    }

    std::lock_guard lock(mutex_);
    std::size_t offset = 0;
    if (cursor == nullptr) {
        // A new sync: pin the head for this connection.
        const command::Revision& head = history.head();
        Pinned pin{std::string(kSyncPrefix) + std::to_string(nextSync_++), head.envelope, head.document,
                   syncOrder(head.document), position.seq, position.meters};
        pinned_.insert_or_assign(connection, std::move(pin));
    } else {
        const std::string& text = cursor->asString();
        auto it = pinned_.find(connection);
        const auto colon = text.find(':');
        std::optional<std::uint64_t> at;
        if (colon != std::string::npos) {
            at = parseUnsigned(std::string_view(text).substr(colon + 1));
        }
        if (it == pinned_.end() || colon == std::string::npos || text.substr(0, colon) != it->second.syncId || !at ||
            *at == 0 || *at >= it->second.order.size() || *at % chunkEntities_ != 0) {
            throw ProtocolError("sync_cursor_invalid", "the cursor does not belong to this connection's sync");
        }
        offset = static_cast<std::size_t>(*at);
    }

    const Pinned& pin = pinned_.at(connection);
    const std::size_t end = std::min(pin.order.size(), offset + chunkEntities_);
    std::optional<Value> root;
    Array media;
    Array tracks;
    Array clips;
    for (std::size_t i = offset; i < end; ++i) {
        const auto& ref = pin.order[i];
        Value entity = *entityJson(pin.document, ref);
        switch (ref.type) {
            case model::EntityType::root: root = std::move(entity); break;
            case model::EntityType::media: media.push_back(std::move(entity)); break;
            case model::EntityType::track: tracks.push_back(std::move(entity)); break;
            case model::EntityType::clip: clips.push_back(std::move(entity)); break;
        }
    }
    Object chunk;
    if (root) {
        chunk.emplace_back("root", std::move(*root));
    }
    chunk.emplace_back("media", Value(std::move(media)));
    chunk.emplace_back("tracks", Value(std::move(tracks)));
    chunk.emplace_back("clips", Value(std::move(clips)));
    const Value next = end < pin.order.size() ? Value(pin.syncId + ":" + std::to_string(end)) : Value(nullptr);
    return Value(Object{{"revision", Value(pin.envelope.id)},
                        {"seq", Value(std::to_string(pin.seq))},
                        {"meters", pin.meters},
                        {"documentHash", Value(hash::formatHash(pin.envelope.documentHash))},
                        {"entities", Value(static_cast<double>(pin.order.size()))},
                        {"chunk", Value(std::move(chunk))},
                        {"next", next}});
}

json::Value ReadModel::fetch(const json::Value& params, const command::History& history) const {
    const Value* refs = params.find("refs");
    if (refs == nullptr || refs->kind() != Value::Kind::array || refs->asArray().empty()) {
        throw ProtocolError("invalid_params", "session.fetch needs a non-empty refs array");
    }
    std::vector<std::pair<std::string, model::EntityRef>> parsed;
    for (const auto& item : refs->asArray()) {
        std::optional<model::EntityRef> ref;
        if (item.kind() == Value::Kind::string) {
            ref = parseRef(item.asString());
        }
        if (!ref) {
            throw ProtocolError("invalid_params", "each ref is \"<root|media|track|clip>:<id>\"");
        }
        parsed.emplace_back(item.asString(), std::move(*ref));
    }
    const command::Revision* at = &history.head();
    if (const Value* revision = params.find("revision")) {
        if (revision->kind() != Value::Kind::string) {
            throw ProtocolError("invalid_params", "revision must be a revision id string");
        }
        at = history.find(revision->asString());
        if (at == nullptr) {
            throw ProtocolError("revision_unavailable", "revision " + revision->asString() + " is not kept");
        }
    }
    const command::Revision& head = *at;
    Array entities;
    for (const auto& [text, ref] : parsed) {
        if (auto entity = entityJson(head.document, ref)) {
            entities.push_back(Value(Object{{"ref", Value(text)}, {"entity", std::move(*entity)}}));
        } else {
            entities.push_back(Value(Object{{"ref", Value(text)}, {"missing", Value(true)}}));
        }
    }
    return Value(Object{{"revision", Value(head.envelope.id)},
                        {"documentHash", Value(hash::formatHash(head.envelope.documentHash))},
                        {"entities", Value(std::move(entities))}});
}

void ReadModel::forget(ConnectionId connection) {
    std::lock_guard lock(mutex_);
    pinned_.erase(connection);
}

void ReadModel::forgetAll() {
    std::lock_guard lock(mutex_);
    pinned_.clear();
}

}  // namespace siann::protocol
