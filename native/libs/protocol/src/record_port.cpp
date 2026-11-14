#include "siann/protocol/record_port.hpp"

#include <utility>

namespace siann::protocol {

namespace {

json::Value decimal(std::int64_t value) {
    return json::Value(std::to_string(value));
}

json::Value decimal(std::uint64_t value) {
    return json::Value(std::to_string(value));
}

json::Value decimalOrNull(const std::optional<std::int64_t>& value) {
    return value ? decimal(*value) : json::Value(nullptr);
}

}  // namespace

json::Object recordStateJson(const RecordState& state) {
    json::Array armed;
    for (const std::string& trackId : state.armed) {
        armed.push_back(json::Value(trackId));
    }
    json::Array takes;
    for (const RecordTakeState& take : state.takes) {
        json::Object one{{"takeId", json::Value(take.takeId)},
                         {"trackId", json::Value(take.trackId)},
                         {"startFrame", decimalOrNull(take.startFrame)},
                         {"durableFrames", decimal(take.durableFrames)}};
        if (take.endedBy) {
            one.emplace_back("endedBy", json::Value(*take.endedBy));
            one.emplace_back("overflows", decimal(take.overflows));
        }
        takes.push_back(json::Value(std::move(one)));
    }
    return json::Object{{"recording", json::Value(state.recording)},
                        {"armed", json::Value(std::move(armed))},
                        {"takes", json::Value(std::move(takes))}};
}

json::Value pendingTakesJson(const std::vector<PendingTake>& takes) {
    json::Array out;
    for (const PendingTake& take : takes) {
        json::Object one{{"takeId", json::Value(take.takeId)},
                         {"trackId", json::Value(take.trackId)},
                         {"channels", json::Value(take.channels)},
                         {"sampleRate", json::Value(static_cast<double>(take.sampleRate))},
                         {"startFrame", decimalOrNull(take.startFrame)}};
        if (take.endedBy) {
            one.emplace_back("endedBy", json::Value(*take.endedBy));
        }
        if (take.overflows) {
            one.emplace_back("overflows", decimal(*take.overflows));
        }
        out.push_back(json::Value(std::move(one)));
    }
    return json::Value(std::move(out));
}

}  // namespace siann::protocol
