# siann-host-clap: ClapPluginHost, the one plugin format of both host targets
# (architecture spec, "siann-host: two targets, one interface"). No JUCE here: it
# builds and runs in every preset, and the desktop target links it beside JUCE.
add_library(siann_host_clap STATIC
  src/clap_library.cpp
  src/clap_plugin_host.cpp
)
add_library(siann::host_clap ALIAS siann_host_clap)
target_include_directories(siann_host_clap PUBLIC include)
target_link_libraries(siann_host_clap
  PUBLIC siann::host_api siann::host_common siann::rt
  PRIVATE siann_third_party_clap ${CMAKE_DL_LIBS})
target_compile_features(siann_host_clap PUBLIC cxx_std_20)
siann_apply_compile_options(siann_host_clap)

if(SIANN_BUILD_TESTS)
  add_subdirectory(test_plugin)
  add_subdirectory(hostile_plugin)

  find_package(Threads REQUIRED)
  add_executable(siann_host_clap_tests tests/clap_plugin_host_test.cpp tests/hostile_plugin_test.cpp)
  # child_process.hpp is header-only: the crash test runs this executable as a child.
  target_include_directories(siann_host_clap_tests PRIVATE src ../host_common/tests ../../apps/cli/tests/support)
  target_link_libraries(siann_host_clap_tests PRIVATE siann::host_clap siann::rt siann_rt_alloc_guard
                        Catch2::Catch2WithMain Threads::Threads)
  siann_apply_compile_options(siann_host_clap_tests)
  # The plugins are hosted from their build locations, so these tests never skip.
  add_dependencies(siann_host_clap_tests siann_test_plugin_CLAP siann_hostile_plugin_CLAP)
  target_compile_definitions(siann_host_clap_tests PRIVATE
    SIANN_TEST_PLUGIN_CLAP="$<GENEX_EVAL:$<TARGET_PROPERTY:siann_test_plugin_CLAP,SIANN_PLUGIN_FILE>>"
    SIANN_HOSTILE_PLUGIN_CLAP="$<GENEX_EVAL:$<TARGET_PROPERTY:siann_hostile_plugin_CLAP,SIANN_PLUGIN_FILE>>"
    SIANN_HOST_CLAP_TESTS_EXE="$<TARGET_FILE:siann_host_clap_tests>")
  # A hang fails the test instead of holding the job until the runner gives up.
  catch_discover_tests(siann_host_clap_tests PROPERTIES TIMEOUT 120)
endif()
