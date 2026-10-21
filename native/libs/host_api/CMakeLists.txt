# Pure interfaces and buffer views; no implementation and no dependencies.
add_library(siann_host_api INTERFACE)
add_library(siann::host_api ALIAS siann_host_api)
target_include_directories(siann_host_api INTERFACE include)
target_compile_features(siann_host_api INTERFACE cxx_std_20)
