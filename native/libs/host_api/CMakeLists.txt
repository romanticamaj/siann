# Pure interfaces and buffer views, one header-only value type
# (host::PluginRegistry) and the editor window interface (host::EditorWindowFactory);
# no implementation and no dependencies.
add_library(siann_host_api INTERFACE)
add_library(siann::host_api ALIAS siann_host_api)
target_include_directories(siann_host_api INTERFACE include)
target_compile_features(siann_host_api INTERFACE cxx_std_20)

if(SIANN_BUILD_TESTS)
  add_executable(siann_host_api_tests tests/plugin_registry_test.cpp tests/editor_window_test.cpp)
  target_link_libraries(siann_host_api_tests PRIVATE siann::host_api Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_host_api_tests)
  catch_discover_tests(siann_host_api_tests)
endif()
