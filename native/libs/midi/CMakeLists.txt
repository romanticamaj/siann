add_library(siann_midi
  src/midi.cpp
)
add_library(siann::midi ALIAS siann_midi)
target_include_directories(siann_midi PUBLIC include)
target_compile_features(siann_midi PUBLIC cxx_std_20)
siann_apply_compile_options(siann_midi)

if(SIANN_BUILD_TESTS)
  add_executable(siann_midi_tests
    tests/midi_test.cpp
  )
  target_link_libraries(siann_midi_tests PRIVATE siann::midi Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_midi_tests)
  catch_discover_tests(siann_midi_tests)
endif()
