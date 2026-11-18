# siann-dsp (architecture spec, "siann-dsp"): pure C++ signal processing with no
# dependency beyond the standard library. Its first resident is the BS.1770-4
# loudness meter (m5b-engine-load-loudness).
add_library(siann_dsp
  src/loudness.cpp
)
add_library(siann::dsp ALIAS siann_dsp)
target_include_directories(siann_dsp PUBLIC include)
target_compile_features(siann_dsp PUBLIC cxx_std_20)
siann_apply_compile_options(siann_dsp)

if(SIANN_BUILD_TESTS)
  add_executable(siann_dsp_tests
    tests/loudness_test.cpp
  )
  target_link_libraries(siann_dsp_tests PRIVATE siann::dsp siann_rt_alloc_guard Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_dsp_tests)
  catch_discover_tests(siann_dsp_tests)
endif()
