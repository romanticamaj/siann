add_library(siann_cli_lib
  src/cli.cpp
)
target_include_directories(siann_cli_lib PUBLIC include)
target_link_libraries(siann_cli_lib PUBLIC siann::engine siann::session)
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
  )
  target_link_libraries(siann_cli_tests PRIVATE siann_cli_lib Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_cli_tests)
  catch_discover_tests(siann_cli_tests)

  # The real executable starts and answers.
  add_test(NAME siann_cli_smoke COMMAND siann-cli commands)
  set_tests_properties(siann_cli_smoke PROPERTIES PASS_REGULAR_EXPRESSION "\"ok\":true")
endif()
