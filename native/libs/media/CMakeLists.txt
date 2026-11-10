add_library(siann_media
  src/audio.cpp
  src/wav_file_reader.cpp
  src/wav_stream_writer.cpp
  src/memory_reader.cpp
  src/peaks.cpp
)
add_library(siann::media ALIAS siann_media)
target_include_directories(siann_media PUBLIC include)
target_link_libraries(siann_media PUBLIC siann::host_api PRIVATE siann::io siann_third_party_dr_libs siann_third_party_r8brain)
target_compile_features(siann_media PUBLIC cxx_std_20)
siann_apply_compile_options(siann_media)

if(SIANN_BUILD_TESTS)
  add_executable(siann_media_tests
    tests/audio_test.cpp
    tests/wav_reader_test.cpp
    tests/wav_writer_test.cpp
    tests/memory_reader_test.cpp
    tests/peaks_test.cpp
    tests/support/allocation_fuse.cpp
  )
  target_link_libraries(siann_media_tests PRIVATE siann::media siann::hash siann::io Catch2::Catch2WithMain)
  target_compile_definitions(siann_media_tests PRIVATE SIANN_FIXTURES_DIR="${SIANN_FIXTURES_DIR}")
  target_include_directories(siann_media_tests PRIVATE tests)
  siann_apply_compile_options(siann_media_tests)
  catch_discover_tests(siann_media_tests)
endif()
