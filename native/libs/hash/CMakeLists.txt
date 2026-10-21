add_library(siann_hash
  src/sha256.cpp
  src/json.cpp
  src/jcs.cpp
  src/merkle.cpp
)
add_library(siann::hash ALIAS siann_hash)
target_include_directories(siann_hash PUBLIC include)
target_compile_features(siann_hash PUBLIC cxx_std_20)
siann_apply_compile_options(siann_hash)

if(SIANN_BUILD_TESTS)
  add_executable(siann_hash_tests
    tests/sha256_test.cpp
    tests/json_test.cpp
    tests/jcs_test.cpp
    tests/merkle_test.cpp
  )
  target_link_libraries(siann_hash_tests PRIVATE siann::hash Catch2::Catch2WithMain)
  target_compile_definitions(siann_hash_tests PRIVATE SIANN_FIXTURES_DIR="${SIANN_FIXTURES_DIR}")
  siann_apply_compile_options(siann_hash_tests)
  catch_discover_tests(siann_hash_tests)
endif()
