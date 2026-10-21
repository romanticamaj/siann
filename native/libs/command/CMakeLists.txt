add_library(siann_command
  src/commands.cpp
  src/history.cpp
)
add_library(siann::command ALIAS siann_command)
target_include_directories(siann_command PUBLIC include)
target_link_libraries(siann_command PUBLIC siann::model)
target_compile_features(siann_command PUBLIC cxx_std_20)
siann_apply_compile_options(siann_command)

if(SIANN_BUILD_TESTS)
  add_executable(siann_command_tests
    tests/commands_test.cpp
    tests/history_test.cpp
  )
  target_link_libraries(siann_command_tests PRIVATE siann::command Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_command_tests)
  catch_discover_tests(siann_command_tests)
endif()
