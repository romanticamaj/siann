add_library(siann_cli_lib
  src/cli.cpp
)
target_include_directories(siann_cli_lib PUBLIC include)
target_link_libraries(siann_cli_lib PUBLIC siann::engine siann::session siann::playback siann::host_fake)
if(SIANN_WITH_JUCE)
  # Real audio devices (ADR-0017). Without JUCE the realtime commands accept
  # only --device fake and report no_audio_backend otherwise.
  target_link_libraries(siann_cli_lib PUBLIC siann::host_desktop)
  target_compile_definitions(siann_cli_lib PUBLIC SIANN_CLI_WITH_JUCE=1)
endif()
siann_apply_compile_options(siann_cli_lib)

add_executable(siann-cli src/main.cpp)
target_link_libraries(siann-cli PRIVATE siann_cli_lib)
if(WIN32)
  target_link_libraries(siann-cli PRIVATE shell32)
endif()
siann_apply_compile_options(siann-cli)

if(SIANN_BUILD_TESTS)
  add_executable(siann_cli_tests
    tests/cli_test.cpp
    tests/callback_timer_test.cpp
    tests/cli_realtime_test.cpp
    tests/cli_kill_test.cpp
  )
  target_link_libraries(siann_cli_tests PRIVATE siann_cli_lib siann_rt_alloc_guard Catch2::Catch2WithMain)
  # The kill test runs the real executable as a child process.
  target_compile_definitions(siann_cli_tests PRIVATE "SIANN_CLI_EXE=\"$<TARGET_FILE:siann-cli>\"")
  add_dependencies(siann_cli_tests siann-cli)
  siann_apply_compile_options(siann_cli_tests)
  catch_discover_tests(siann_cli_tests)

  # The real executable starts and answers.
  add_test(NAME siann_cli_smoke COMMAND siann-cli commands)
  set_tests_properties(siann_cli_smoke PROPERTIES PASS_REGULAR_EXPRESSION "\"ok\":true")
endif()
