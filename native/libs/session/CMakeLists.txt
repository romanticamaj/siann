add_library(siann_session
  src/journal.cpp
  src/session.cpp
  src/media_import.cpp
)
add_library(siann::session ALIAS siann_session)
target_include_directories(siann_session PUBLIC include)
target_link_libraries(siann_session PUBLIC siann::command siann::io siann::media)
target_compile_features(siann_session PUBLIC cxx_std_20)
siann_apply_compile_options(siann_session)

if(SIANN_BUILD_TESTS)
  add_executable(siann_session_tests
    tests/session_test.cpp
    tests/media_import_test.cpp
  )
  target_link_libraries(siann_session_tests PRIVATE siann::session Catch2::Catch2WithMain)
  target_include_directories(siann_session_tests PRIVATE "${PROJECT_SOURCE_DIR}/libs/media/tests")
  siann_apply_compile_options(siann_session_tests)
  catch_discover_tests(siann_session_tests)
endif()
