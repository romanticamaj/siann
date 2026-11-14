add_library(siann_realtime
  src/graph_driver.cpp
  src/control_dispatcher.cpp
  src/disk_stream.cpp
  src/recorder.cpp
  src/capture_bank.cpp
  src/transport.cpp
  src/stream_resampler.cpp
  src/click.cpp
)
add_library(siann::realtime ALIAS siann_realtime)
target_include_directories(siann_realtime PUBLIC include)
find_package(Threads REQUIRED)
target_link_libraries(siann_realtime PUBLIC siann::graph siann::host_api siann::rt siann::media siann::time Threads::Threads)
target_compile_features(siann_realtime PUBLIC cxx_std_20)
target_link_libraries(siann_realtime PRIVATE siann_third_party_r8brain)
siann_apply_compile_options(siann_realtime)

if(SIANN_BUILD_TESTS)
  add_executable(siann_realtime_tests
    tests/graph_driver_test.cpp
    tests/params_test.cpp
    tests/meters_test.cpp
    tests/streaming_test.cpp
    tests/recording_test.cpp
    tests/transport_test.cpp
    tests/pdc_realtime_test.cpp
    tests/src_test.cpp
    tests/capture_bank_test.cpp
  )
  target_link_libraries(siann_realtime_tests PRIVATE siann::realtime siann::host_fake siann::media siann_rt_alloc_guard
                        siann::engine Catch2::Catch2WithMain)
  # The PDC fixtures are shared with siann-graph's tests; siann-engine is for the
  # offline/realtime parity test only (no library dependency).
  target_include_directories(siann_realtime_tests PRIVATE "${PROJECT_SOURCE_DIR}/libs/graph/tests")
  siann_apply_compile_options(siann_realtime_tests)
  catch_discover_tests(siann_realtime_tests)
endif()
