#include "siann/protocol/about.hpp"

// Generated at build time by cmake/SiannBuildInfo.cmake. A CMake build always
// has it (SIANN_BUILD_INFO_REQUIRED); the fallback below only serves syntax
// checks that compile this file outside CMake (scripts/check-all.js --gcc).
#if __has_include("siann_build_info.hpp")
#include "siann_build_info.hpp"
#elif defined(SIANN_BUILD_INFO_REQUIRED)
#error "siann_build_info.hpp was not generated"
#else
#define SIANN_BUILD_NAME "siann-engine"
#define SIANN_BUILD_VERSION "0.0.0"
#define SIANN_BUILD_SOURCE_URL "https://github.com/romanticamaj/siann"
#define SIANN_BUILD_SOURCE_COMMIT "0000000000000000000000000000000000000000"
#define SIANN_BUILD_SOURCE_DIRTY true
#define SIANN_BUILD_LICENSE "GPL-2.0-or-later"
#endif

namespace siann::protocol {

const BuildInfo& buildInfo() {
    static const BuildInfo info{SIANN_BUILD_NAME,          SIANN_BUILD_VERSION,      SIANN_BUILD_SOURCE_URL,
                                SIANN_BUILD_SOURCE_COMMIT, SIANN_BUILD_SOURCE_DIRTY, SIANN_BUILD_LICENSE};
    return info;
}

json::Value aboutJson() {
    const BuildInfo& info = buildInfo();
    return json::Value(json::Object{
        {"name", json::Value(info.name)},
        {"version", json::Value(info.version)},
        {"source", json::Value(json::Object{{"url", json::Value(info.sourceUrl)},
                                            {"commit", json::Value(info.commit)},
                                            {"dirty", json::Value(info.dirty)}})},
        {"license", json::Value(info.license)},
    });
}

}  // namespace siann::protocol
