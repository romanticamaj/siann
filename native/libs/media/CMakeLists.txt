add_library(siann_media
  src/audio.cpp
)
add_library(siann::media ALIAS siann_media)
target_include_directories(siann_media PUBLIC include)
target_link_libraries(siann_media PRIVATE siann_third_party_dr_libs siann_third_party_r8brain)
target_compile_features(siann_media PUBLIC cxx_std_20)
siann_apply_compile_options(siann_media)

if(SIANN_BUILD_TESTS)
  add_executable(siann_media_tests
    tests/audio_test.cpp
  )
  target_link_libraries(siann_media_tests PRIVATE siann::media Catch2::Catch2WithMain)
  target_include_directories(siann_media_tests PRIVATE tests)
  siann_apply_compile_options(siann_media_tests)
  catch_discover_tests(siann_media_tests)
endif()
