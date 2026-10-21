add_library(siann_io
  src/durable_file.cpp
)
add_library(siann::io ALIAS siann_io)
target_include_directories(siann_io PUBLIC include)
target_compile_features(siann_io PUBLIC cxx_std_20)
siann_apply_compile_options(siann_io)

if(SIANN_BUILD_TESTS)
  add_executable(siann_io_tests
    tests/durable_file_test.cpp
  )
  target_link_libraries(siann_io_tests PRIVATE siann::io Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_io_tests)
  catch_discover_tests(siann_io_tests)
endif()
