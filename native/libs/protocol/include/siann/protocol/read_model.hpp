#pragma once

// session.sync and session.fetch (docs/schemas/protocol-events-v1.md). A sync
// pins the head document and envelope for the connection on its first chunk
// (cheap: documents share structure) and serves every later chunk from that
// pin, so all chunks of one sync are at one revision.

#include <cstddef>
#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "siann/command/history.hpp"
#include "siann/hash/json.hpp"
#include "siann/model/document.hpp"
#include "siann/protocol/event_stream.hpp"
#include "siann/protocol/transport.hpp"

namespace siann::protocol {

// A protocol-level error with a stable code (sync_cursor_invalid,
// revision_unavailable, invalid_params).
class ProtocolError : public std::runtime_error {
public:
    ProtocolError(std::string code, const std::string& message) : std::runtime_error(message), code_(std::move(code)) {}
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

// Parses "<type>:<id>"; nullopt when the type is unknown or the id is empty.
std::optional<model::EntityRef> parseRef(std::string_view text);

// Every entity of a document in sync order: root, media, tracks, clips, each
// table in id order (the order of Document::toJson()).
std::vector<model::EntityRef> syncOrder(const model::Document& document);

// The hashed JSON form of one entity, or nullopt when the document lacks it.
std::optional<json::Value> entityJson(const model::Document& document, const model::EntityRef& ref);

class ReadModel {
public:
    explicit ReadModel(std::size_t chunkEntities = 500);

    // The command thread. `position` is the event stream's position now; a new
    // sync pins its seq and meter legend with the head. Throws ProtocolError.
    json::Value sync(ConnectionId connection, const json::Value& params, const command::History& history,
                     const StreamPosition& position);
    json::Value fetch(const json::Value& params, const command::History& history) const;

    // Any thread: drops the connection's pinned sync.
    void forget(ConnectionId connection);
    // Any thread: drops every pinned sync (session.open).
    void forgetAll();

private:
    struct Pinned {
        std::string syncId;
        command::RevisionEnvelope envelope;
        model::Document document;
        std::vector<model::EntityRef> order;
        std::uint64_t seq = 0;
        json::Value meters;
        json::Value pendingTakes;  // m5b-engine-record, at the pinned seq
    };

    const std::size_t chunkEntities_;
    std::mutex mutex_;
    std::map<ConnectionId, Pinned> pinned_;
    std::uint64_t nextSync_ = 1;
};

}  // namespace siann::protocol
