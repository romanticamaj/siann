#pragma once

// The running build's identity (ADR-0017, point 4: AGPL section 13). Captured
// at build time by cmake/SiannBuildInfo.cmake.

#include <string>

#include "siann/hash/json.hpp"

namespace siann::protocol {

struct BuildInfo {
    std::string name;       // "siann-engine"
    std::string version;    // the CMake project version
    std::string sourceUrl;  // SIANN_SOURCE_URL
    std::string commit;     // 40 lowercase hex characters
    bool dirty = false;     // the tree had uncommitted changes at build time
    std::string license;    // "AGPL-3.0-or-later" with JUCE, "GPL-2.0-or-later" otherwise
};

const BuildInfo& buildInfo();

// {name, version, source: {url, commit, dirty}, license}
json::Value aboutJson();

}  // namespace siann::protocol
