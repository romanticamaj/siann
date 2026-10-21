add_library(siann_realtime
  src/graph_driver.cpp
  src/control_dispatcher.cpp
  src/disk_stream.cpp
)
add_library(siann::realtime ALIAS siann_realtime)
target_include_directories(siann_realtime PUBLIC include)
find_package(Threads REQUIRED)
target_link_libraries(siann_realtime PUBLIC siann::graph siann::host_api siann::rt Threads::Threads)
target_compile_features(siann_realtime PUBLIC cxx_std_20)
siann_apply_compile_options(siann_realtime)

if(SIANN_BUILD_TESTS)
  add_executable(siann_realtime_tests
    tests/graph_driver_test.cpp
    tests/params_test.cpp
    tests/streaming_test.cpp
  )
  target_link_libraries(siann_realtime_tests PRIVATE siann::realtime siann::host_fake siann::media siann_rt_alloc_guard
                        Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_realtime_tests)
  catch_discover_tests(siann_realtime_tests)
endif()
