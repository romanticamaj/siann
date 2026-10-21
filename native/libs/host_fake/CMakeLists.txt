add_library(siann_host_fake
  src/fake_audio_device.cpp
)
add_library(siann::host_fake ALIAS siann_host_fake)
target_include_directories(siann_host_fake PUBLIC include)
find_package(Threads REQUIRED)
target_link_libraries(siann_host_fake PUBLIC siann::host_api siann::rt Threads::Threads)
target_compile_features(siann_host_fake PUBLIC cxx_std_20)
siann_apply_compile_options(siann_host_fake)

if(SIANN_BUILD_TESTS)
  add_executable(siann_host_fake_tests
    tests/fake_device_test.cpp
  )
  target_link_libraries(siann_host_fake_tests PRIVATE siann::host_fake siann_rt_alloc_guard Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_host_fake_tests)
  catch_discover_tests(siann_host_fake_tests)
endif()
