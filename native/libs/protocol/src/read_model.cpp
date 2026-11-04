#include "siann/protocol/read_model.hpp"

namespace siann::protocol {

std::optional<model::EntityRef> parseRef(std::string_view) {
    return std::nullopt;
}

std::vector<model::EntityRef> syncOrder(const model::Document&) {
    return {};
}

std::optional<json::Value> entityJson(const model::Document&, const model::EntityRef&) {
    return std::nullopt;
}

ReadModel::ReadModel(std::size_t chunkEntities) : chunkEntities_(chunkEntities) {}

json::Value ReadModel::sync(ConnectionId, const json::Value&, const command::History&, std::uint64_t) {
    throw ProtocolError("unknown_method", "session.sync is not implemented");
}

json::Value ReadModel::fetch(const json::Value&, const command::History&) const {
    throw ProtocolError("unknown_method", "session.fetch is not implemented");
}

void ReadModel::forget(ConnectionId) {}

}  // namespace siann::protocol
