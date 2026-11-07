# What every PluginHost shares, with no plugin format in it: the error type and
# the state envelope. tests/hosting_checks.hpp is the hosting tests' common part;
# a test target adds the directory to its include path.
add_library(siann_host_common STATIC src/state_envelope.cpp)
add_library(siann::host_common ALIAS siann_host_common)
target_include_directories(siann_host_common PUBLIC include)
target_link_libraries(siann_host_common PUBLIC siann::host_api)
target_compile_features(siann_host_common PUBLIC cxx_std_20)
siann_apply_compile_options(siann_host_common)
