# siann-host-desktop: the JUCE-backed host target (ADR-0017). Built only when
# SIANN_WITH_JUCE is ON.
add_library(siann_host_desktop STATIC
  src/juce_audio_device.cpp
)
add_library(siann::host_desktop ALIAS siann_host_desktop)
target_include_directories(siann_host_desktop PUBLIC include)
target_link_libraries(siann_host_desktop
  PUBLIC siann::host_api siann::rt
  PRIVATE juce::juce_audio_devices juce::juce_recommended_config_flags)
target_compile_features(siann_host_desktop PUBLIC cxx_std_20)
target_compile_definitions(siann_host_desktop PRIVATE
  JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
  JUCE_STANDALONE_APPLICATION=0
  JUCE_USE_CURL=0
  JUCE_WEB_BROWSER=0
  $<$<PLATFORM_ID:Windows>:JUCE_ASIO=1>
  $<$<PLATFORM_ID:Windows>:JUCE_WASAPI=1>
  $<$<PLATFORM_ID:Windows>:JUCE_DIRECTSOUND=0>
  $<$<PLATFORM_ID:Linux>:JUCE_JACK=0>)
if(MSVC)
  target_compile_options(siann_host_desktop PRIVATE /utf-8)  # JUCE sources are UTF-8
endif()
siann_apply_source_options(src/juce_audio_device.cpp)

if(SIANN_BUILD_TESTS)
  add_executable(siann_host_desktop_tests
    tests/juce_device_test.cpp
  )
  target_link_libraries(siann_host_desktop_tests PRIVATE siann::host_desktop siann::realtime siann_rt_alloc_guard
                        Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_host_desktop_tests)
  catch_discover_tests(siann_host_desktop_tests)
endif()
