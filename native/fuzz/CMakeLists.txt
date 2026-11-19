# siann-fuzz (m5b-nightly-quality): one harness function per fuzz target over
# the engine's untrusted input, shared by two drivers. Every build runs it as a
# seeded smoke ctest (fuzz_smoke_test.cpp); the Clang SIANN_FUZZ build also
# makes the libFuzzer executables the nightly workflow runs for a fixed time
# from native/fuzz/corpus/<target>/.

add_library(siann_fuzz_harness STATIC src/harness.cpp)
target_include_directories(siann_fuzz_harness PUBLIC include)
# The in-memory transport of the protocol tests, shared rather than copied.
target_include_directories(siann_fuzz_harness PRIVATE "${PROJECT_SOURCE_DIR}/libs/protocol/tests")
target_link_libraries(siann_fuzz_harness PUBLIC siann::protocol siann::session siann::command siann::model
  siann::hash)
target_compile_features(siann_fuzz_harness PUBLIC cxx_std_20)
siann_apply_compile_options(siann_fuzz_harness)

if(SIANN_BUILD_TESTS)
  add_executable(siann_fuzz_smoke_tests tests/fuzz_smoke_test.cpp)
  target_link_libraries(siann_fuzz_smoke_tests PRIVATE siann_fuzz_harness Catch2::Catch2WithMain)
  target_compile_definitions(siann_fuzz_smoke_tests PRIVATE
    "SIANN_FUZZ_CORPUS_DIR=\"${CMAKE_CURRENT_SOURCE_DIR}/corpus\"")
  siann_apply_compile_options(siann_fuzz_smoke_tests)
  catch_discover_tests(siann_fuzz_smoke_tests)
endif()

# One target per harness function: <target> runs siann::fuzz::<function>.
set(SIANN_FUZZ_TARGETS
  protocol_frame=protocolFrame
  ws_request=wsRequest
  meter_frame=meterFrame
  loudness_frame=loudnessFrame
  mcp_http=mcpHttp
  command_json=commandJson)

if(SIANN_FUZZ)
  foreach(entry IN LISTS SIANN_FUZZ_TARGETS)
    string(REPLACE "=" ";" pair "${entry}")
    list(GET pair 0 target)
    list(GET pair 1 function)
    add_executable(siann_fuzz_${target} src/libfuzzer_main.cpp)
    target_compile_definitions(siann_fuzz_${target} PRIVATE SIANN_FUZZ_TARGET=${function})
    target_link_libraries(siann_fuzz_${target} PRIVATE siann_fuzz_harness)
    target_compile_options(siann_fuzz_${target} PRIVATE -fsanitize=fuzzer,address,undefined)
    target_link_options(siann_fuzz_${target} PRIVATE -fsanitize=fuzzer,address,undefined)
    siann_apply_compile_options(siann_fuzz_${target})
  endforeach()
endif()
