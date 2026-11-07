#include "clap_library.hpp"

#include "siann/host/plugin_error.hpp"

// A stub until the implementation lands.

namespace fs = std::filesystem;

namespace siann::host {

fs::path clapExecutablePath(const fs::path&) { throw PluginError("plugin_load_failed", "not implemented"); }

}  // namespace siann::host
