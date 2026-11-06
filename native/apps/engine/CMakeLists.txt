# siann-engine: the engine process the Electron shell spawns (architecture
# spec, "Process model"; Protocol v0 item 17). Built by the core-only
# configuration too, whose main thread only waits; with JUCE it runs the message
# loop and can host a plugin editor.
add_library(siann_engine_app src/engine.cpp)
target_include_directories(siann_engine_app PUBLIC include)
target_link_libraries(siann_engine_app PUBLIC siann::session siann::protocol)
if(SIANN_WITH_JUCE)
  target_sources(siann_engine_app PRIVATE src/main_thread_desktop.cpp)
  target_link_libraries(siann_engine_app PUBLIC siann::host_desktop)
  target_compile_definitions(siann_engine_app PUBLIC SIANN_ENGINE_WITH_JUCE=1)
else()
  target_sources(siann_engine_app PRIVATE src/main_thread_core.cpp)
endif()
siann_apply_compile_options(siann_engine_app)

add_executable(siann-engine src/main.cpp)
target_link_libraries(siann-engine PRIVATE siann_engine_app)
if(WIN32)
  target_link_libraries(siann-engine PRIVATE shell32)
endif()
siann_apply_compile_options(siann-engine)

if(SIANN_BUILD_TESTS)
  add_executable(siann_engine_launch_tests tests/engine_launch_test.cpp)
  # The protocol tests' loopback clients (support/ws_clients.hpp) talk to the
  # real executable, which runs as a child process.
  target_link_libraries(siann_engine_launch_tests PRIVATE siann_engine_app siann_third_party_ixwebsocket
    Catch2::Catch2WithMain)
  target_include_directories(siann_engine_launch_tests PRIVATE tests "${PROJECT_SOURCE_DIR}/libs/protocol/tests")
  target_compile_definitions(siann_engine_launch_tests PRIVATE "SIANN_ENGINE_EXE=\"$<TARGET_FILE:siann-engine>\"")
  add_dependencies(siann_engine_launch_tests siann-engine)
  if(SIANN_WITH_JUCE)
    add_dependencies(siann_engine_launch_tests siann_test_plugin_VST3)
    target_compile_definitions(siann_engine_launch_tests PRIVATE
      SIANN_TEST_PLUGIN_VST3="$<GENEX_EVAL:$<TARGET_PROPERTY:siann_test_plugin_VST3,JUCE_PLUGIN_ARTEFACT_FILE>>")
  endif()
  siann_apply_compile_options(siann_engine_launch_tests)
  catch_discover_tests(siann_engine_launch_tests)
endif()
