add_library(siann_time
  src/tempo_map.cpp
)
add_library(siann::time ALIAS siann_time)
target_include_directories(siann_time PUBLIC include)
target_compile_features(siann_time PUBLIC cxx_std_20)
siann_apply_compile_options(siann_time)

if(SIANN_BUILD_TESTS)
  add_executable(siann_time_tests
    tests/wide_int_test.cpp
    tests/tempo_map_test.cpp
    tests/conversion_fixture_test.cpp
  )
  # The fixture test reads JSON with the hashed-data parser from siann-hash.
  target_link_libraries(siann_time_tests PRIVATE siann::time siann::hash Catch2::Catch2WithMain)
  target_compile_definitions(siann_time_tests PRIVATE SIANN_FIXTURES_DIR="${SIANN_FIXTURES_DIR}")
  siann_apply_compile_options(siann_time_tests)
  catch_discover_tests(siann_time_tests)
endif()
