# siann-host-desktop: the JUCE-backed host target (ADR-0017). Built only when
# SIANN_WITH_JUCE is ON.
add_library(siann_host_desktop STATIC
  src/juce_audio_device.cpp
  src/juce_plugin_host.cpp
)
add_library(siann::host_desktop ALIAS siann_host_desktop)
if(WIN32)
  target_sources(siann_host_desktop PRIVATE src/juce_plugin_host_win.cpp)
  siann_apply_source_options(src/juce_plugin_host_win.cpp)
elseif(APPLE)
  target_sources(siann_host_desktop PRIVATE src/juce_plugin_host_mac.mm)
  siann_apply_source_options(src/juce_plugin_host_mac.mm)
endif()
target_include_directories(siann_host_desktop PUBLIC include)
target_link_libraries(siann_host_desktop
  PUBLIC siann::host_api siann::rt
  PRIVATE
    juce::juce_audio_devices
    juce::juce_audio_processors
    juce::juce_gui_basics
    juce::juce_gui_extra
    juce::juce_recommended_config_flags)
target_compile_features(siann_host_desktop PUBLIC cxx_std_20)
# JUCE_MODAL_LOOPS_PERMITTED=1: MessageManager::runDispatchLoopUntil, which
# MainThreadLoop pumps, exists only with it on.
target_compile_definitions(siann_host_desktop PRIVATE
  JUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1
  JUCE_STANDALONE_APPLICATION=0
  JUCE_USE_CURL=0
  JUCE_WEB_BROWSER=0
  JUCE_MODAL_LOOPS_PERMITTED=1
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_LV2=0
  $<$<PLATFORM_ID:Darwin>:JUCE_PLUGINHOST_AU=1>
  $<$<PLATFORM_ID:Windows>:JUCE_ASIO=1>
  $<$<PLATFORM_ID:Windows>:JUCE_WASAPI=1>
  $<$<PLATFORM_ID:Windows>:JUCE_DIRECTSOUND=0>
  $<$<PLATFORM_ID:Linux>:JUCE_JACK=0>)
if(MSVC)
  target_compile_options(siann_host_desktop PRIVATE /utf-8)  # JUCE sources are UTF-8
endif()
siann_apply_source_options(src/juce_audio_device.cpp src/juce_plugin_host.cpp)

if(SIANN_BUILD_TESTS)
  add_subdirectory(test_plugin)

  add_executable(siann_host_desktop_tests
    tests/juce_device_test.cpp
    tests/juce_plugin_host_test.cpp
  )
  if(APPLE)
    target_sources(siann_host_desktop_tests PRIVATE tests/juce_plugin_host_mac_test.mm)
    target_link_libraries(siann_host_desktop_tests PRIVATE "-framework AppKit" "-framework AudioToolbox")
  endif()
  target_link_libraries(siann_host_desktop_tests PRIVATE siann::host_desktop siann::realtime siann_rt_alloc_guard
                        Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_host_desktop_tests)
  # The plugin is hosted from its build location, so these tests never skip.
  add_dependencies(siann_host_desktop_tests siann_test_plugin_VST3)
  target_compile_definitions(siann_host_desktop_tests PRIVATE
    SIANN_TEST_PLUGIN_VST3="$<GENEX_EVAL:$<TARGET_PROPERTY:siann_test_plugin_VST3,JUCE_PLUGIN_ARTEFACT_FILE>>")
  if(APPLE)
    add_dependencies(siann_host_desktop_tests siann_test_plugin_AU)
    target_compile_definitions(siann_host_desktop_tests PRIVATE
      SIANN_TEST_PLUGIN_AU="$<GENEX_EVAL:$<TARGET_PROPERTY:siann_test_plugin_AU,JUCE_PLUGIN_ARTEFACT_FILE>>")
  endif()
  catch_discover_tests(siann_host_desktop_tests)
endif()
