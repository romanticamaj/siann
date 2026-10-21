add_library(siann_model
  src/document.cpp
)
add_library(siann::model ALIAS siann_model)
target_include_directories(siann_model PUBLIC include)
target_link_libraries(siann_model PUBLIC siann::hash siann::time)
target_compile_features(siann_model PUBLIC cxx_std_20)
siann_apply_compile_options(siann_model)

if(SIANN_BUILD_TESTS)
  add_executable(siann_model_tests
    tests/document_test.cpp
  )
  target_link_libraries(siann_model_tests PRIVATE siann::model Catch2::Catch2WithMain)
  target_compile_definitions(siann_model_tests PRIVATE SIANN_FIXTURES_DIR="${SIANN_FIXTURES_DIR}")
  siann_apply_compile_options(siann_model_tests)
  catch_discover_tests(siann_model_tests)
endif()
