add_library(siann_playback
  src/audition.cpp
  src/playback_engine.cpp
)
add_library(siann::playback ALIAS siann_playback)
target_include_directories(siann_playback PUBLIC include)
target_link_libraries(siann_playback PUBLIC siann::engine siann::realtime siann::session siann::media siann::host_api)
target_compile_features(siann_playback PUBLIC cxx_std_20)
siann_apply_compile_options(siann_playback)

if(SIANN_BUILD_TESTS)
  add_executable(siann_playback_tests
    tests/playback_test.cpp
    tests/live_recompile_test.cpp
    tests/audition_test.cpp
  )
  target_link_libraries(siann_playback_tests PRIVATE siann::playback siann::host_fake siann_rt_alloc_guard
                        Catch2::Catch2WithMain)
  target_include_directories(siann_playback_tests PRIVATE "${PROJECT_SOURCE_DIR}/libs/media/tests")
  siann_apply_compile_options(siann_playback_tests)
  catch_discover_tests(siann_playback_tests)
endif()
