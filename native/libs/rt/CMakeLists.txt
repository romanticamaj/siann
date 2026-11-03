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
    tests/latest_mailbox_test.cpp
    tests/queue_test.cpp
    tests/realtime_thread_test.cpp
  )
  target_link_libraries(siann_rt_tests PRIVATE siann::rt siann_rt_alloc_guard Catch2::Catch2WithMain Threads::Threads)
  # What realtimeSanitizerActive() must report in this build.
  target_compile_definitions(siann_rt_tests PRIVATE "SIANN_TEST_EXPECT_RTSAN=$<BOOL:${SIANN_RTSAN}>")
  siann_apply_compile_options(siann_rt_tests)
  catch_discover_tests(siann_rt_tests)

  if(SIANN_RTSAN)
    # Each mode does one forbidden call inside ScopedRealtimeThread; the
    # sanitizer must report it (architecture spec, "Realtime rules and
    # enforcement"). No allocation guard: the canary tests the sanitizer alone.
    add_executable(siann_rtsan_canary tests/rtsan_canary.cpp)
    target_link_libraries(siann_rtsan_canary PRIVATE siann::rt)
    siann_apply_compile_options(siann_rtsan_canary)
    foreach(mode alloc lock sleep)
      add_test(NAME siann_rtsan_canary_${mode} COMMAND siann_rtsan_canary ${mode})
      set_tests_properties(siann_rtsan_canary_${mode} PROPERTIES PASS_REGULAR_EXPRESSION "RealtimeSanitizer")
    endforeach()
    add_test(NAME siann_rtsan_canary_disabled COMMAND siann_rtsan_canary disabled)
    set_tests_properties(siann_rtsan_canary_disabled PROPERTIES FAIL_REGULAR_EXPRESSION "RealtimeSanitizer")
  endif()
endif()
