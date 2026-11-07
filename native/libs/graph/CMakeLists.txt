add_library(siann_graph
  src/graph.cpp
  src/nodes.cpp
)
add_library(siann::graph ALIAS siann_graph)
target_include_directories(siann_graph PUBLIC include)
# PluginNode's header holds an rt::CallbackTimer.
target_link_libraries(siann_graph PUBLIC siann::host_api siann::rt)
target_compile_features(siann_graph PUBLIC cxx_std_20)
siann_apply_compile_options(siann_graph)

if(SIANN_BUILD_TESTS)
  add_executable(siann_graph_tests
    tests/graph_test.cpp
    tests/plugin_node_test.cpp
  )
  target_link_libraries(siann_graph_tests PRIVATE siann::graph siann_rt_alloc_guard Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_graph_tests)
  catch_discover_tests(siann_graph_tests)

  # No SIANN code on a hosted plugin's process path names a lock (m4-plugin-node),
  # in every preset: the JUCE adapter's source is checked even where it is not built.
  set(siann_plugin_path_sources
    "${CMAKE_CURRENT_SOURCE_DIR}/src/plugin_node.cpp"
    "${PROJECT_SOURCE_DIR}/libs/host_desktop/src/juce_plugin_host.cpp"
    "${PROJECT_SOURCE_DIR}/libs/host_clap/src/clap_plugin_host.cpp"
  )
  string(JOIN "|" siann_plugin_path_files ${siann_plugin_path_sources})
  add_test(NAME siann_no_locks_on_plugin_path
    COMMAND "${CMAKE_COMMAND}" "-DFILES=${siann_plugin_path_files}" -P "${PROJECT_SOURCE_DIR}/cmake/SiannNoLocks.cmake")
  # The check's self-test: a file that names std::mutex must fail it.
  add_test(NAME siann_no_locks_self_test
    COMMAND "${CMAKE_COMMAND}" "-DFILES=${CMAKE_CURRENT_SOURCE_DIR}/tests/no_locks_fixture.txt"
            -P "${PROJECT_SOURCE_DIR}/cmake/SiannNoLocks.cmake")
  set_tests_properties(siann_no_locks_self_test PROPERTIES WILL_FAIL TRUE)
endif()
