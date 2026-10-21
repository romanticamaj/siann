add_library(siann_rt
  src/realtime_thread.cpp
)
add_library(siann::rt ALIAS siann_rt)
target_include_directories(siann_rt PUBLIC include)
target_compile_features(siann_rt PUBLIC cxx_std_20)
siann_apply_compile_options(siann_rt)

# Replaces global operator new/delete to count allocations on realtime threads.
# Link only into test executables.
add_library(siann_rt_alloc_guard OBJECT src/alloc_guard.cpp)
target_link_libraries(siann_rt_alloc_guard PUBLIC siann::rt)
siann_apply_compile_options(siann_rt_alloc_guard)

if(SIANN_BUILD_TESTS)
  find_package(Threads REQUIRED)
  add_executable(siann_rt_tests
    tests/queue_test.cpp
  )
  target_link_libraries(siann_rt_tests PRIVATE siann::rt siann_rt_alloc_guard Catch2::Catch2WithMain Threads::Threads)
  siann_apply_compile_options(siann_rt_tests)
  catch_discover_tests(siann_rt_tests)
endif()
