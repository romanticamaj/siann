// Until the tests land: the library links and the plugin builds.

#include <catch2/catch_test_macros.hpp>

#include "siann/host/clap_plugin_host.hpp"

TEST_CASE("clap host: the host constructs", "[clap]") {
    siann::host::ClapPluginHost host;
    host.runMainThreadCallbacks();
}
