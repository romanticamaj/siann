add_library(siann_graph
  src/graph.cpp
  src/nodes.cpp
)
add_library(siann::graph ALIAS siann_graph)
target_include_directories(siann_graph PUBLIC include)
target_link_libraries(siann_graph PUBLIC siann::host_api)
target_compile_features(siann_graph PUBLIC cxx_std_20)
siann_apply_compile_options(siann_graph)

if(SIANN_BUILD_TESTS)
  add_executable(siann_graph_tests
    tests/graph_test.cpp
  )
  target_link_libraries(siann_graph_tests PRIVATE siann::graph Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_graph_tests)
  catch_discover_tests(siann_graph_tests)
endif()
