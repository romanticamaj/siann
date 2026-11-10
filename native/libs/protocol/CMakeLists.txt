add_library(siann_protocol
  src/protocol_server.cpp
  src/ix_transport.cpp
  src/event_stream.cpp
  src/read_model.cpp
  src/realtime_channel.cpp
  src/about.cpp
  src/jobs.cpp
  src/mcp_adapter.cpp
)
add_library(siann::protocol ALIAS siann_protocol)
target_include_directories(siann_protocol PUBLIC include)
# siann::engine (offline render for render.start) is pure: no device, no playback.
# PluginPort's header names engine::PluginNodeSource, the render's own instances.
target_link_libraries(siann_protocol PUBLIC siann::session siann::realtime siann::engine PRIVATE siann::io
  siann_third_party_ixwebsocket)
target_compile_features(siann_protocol PUBLIC cxx_std_20)
siann_apply_compile_options(siann_protocol)
# The source commit and URL for engine.about (ADR-0017), captured at build time.
siann_add_build_info(siann_protocol "${CMAKE_CURRENT_SOURCE_DIR}/build_info.hpp.in")

if(SIANN_BUILD_TESTS)
  add_executable(siann_protocol_tests
    tests/protocol_server_test.cpp
    tests/ix_transport_test.cpp
    tests/event_stream_test.cpp
    tests/sync_test.cpp
    tests/realtime_channel_test.cpp
    tests/build_info_test.cpp
    tests/plan_methods_test.cpp
    tests/audition_methods_test.cpp
    tests/transport_methods_test.cpp
    tests/plugin_methods_test.cpp
    tests/jobs_test.cpp
    tests/session_open_test.cpp
    tests/mcp_adapter_test.cpp
    tests/mcp_e2e_test.cpp
  )
  # The IXWebSocket client drives the loopback tests; the realtime tests run
  # the graph driver on a ManualAudioDevice with the allocation guard. The
  # audition, jobs and MCP tests put a real playback::Auditioner behind the
  # AuditionPort (the engine host's own header-only AuditionerPort) and reuse the
  # playback tests' live rig (live_rig.hpp).
  target_link_libraries(siann_protocol_tests PRIVATE siann::protocol siann::realtime siann::host_fake
    siann::playback siann::io siann_rt_alloc_guard siann_third_party_ixwebsocket Catch2::Catch2WithMain)
  target_include_directories(siann_protocol_tests PRIVATE tests "${PROJECT_SOURCE_DIR}/libs/playback/tests/support"
    "${PROJECT_SOURCE_DIR}/libs/media/tests"
    "${PROJECT_SOURCE_DIR}/apps/engine/include")
  if(SIANN_WITH_JUCE)
    set(siann_test_with_juce 1)
  else()
    set(siann_test_with_juce 0)
  endif()
  target_compile_definitions(siann_protocol_tests PRIVATE
    "SIANN_TEST_SOURCE_DIR=\"${PROJECT_SOURCE_DIR}\""
    "SIANN_TEST_WITH_JUCE=${siann_test_with_juce}"
    "SIANN_FIXTURES_DIR=\"${SIANN_FIXTURES_DIR}\"")
  siann_apply_compile_options(siann_protocol_tests)
  catch_discover_tests(siann_protocol_tests)
endif()
