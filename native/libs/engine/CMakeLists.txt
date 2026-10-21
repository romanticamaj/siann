add_library(siann_engine
  src/offline.cpp
)
add_library(siann::engine ALIAS siann_engine)
target_include_directories(siann_engine PUBLIC include)
target_link_libraries(siann_engine PUBLIC siann::graph siann::model siann::media siann::session)
target_compile_features(siann_engine PUBLIC cxx_std_20)
siann_apply_compile_options(siann_engine)

if(SIANN_BUILD_TESTS)
  add_executable(siann_engine_tests
    tests/offline_test.cpp
  )
  target_link_libraries(siann_engine_tests PRIVATE siann::engine Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_engine_tests)
  catch_discover_tests(siann_engine_tests)
endif()
