#include "siann/protocol/about.hpp"

namespace siann::protocol {

const BuildInfo& buildInfo() {
    static const BuildInfo info{};
    return info;
}

json::Value aboutJson() {
    return json::Value(json::Object{});
}

}  // namespace siann::protocol
