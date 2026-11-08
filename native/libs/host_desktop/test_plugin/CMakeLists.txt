# siann_test_plugin: the plugin the hosting tests load (M0, plugin-set gate). A
# known delay with a versioned state blob, built here so CI needs no third-party
# plugin. Never installed: the tests use the build artefact's path.
set(siann_test_plugin_formats VST3)
if(APPLE)
  list(APPEND siann_test_plugin_formats AU)
endif()

# VST3_AUTO_MANIFEST FALSE: no build step that loads the plugin, on a machine
# that may have no display; the host reads the factory, not moduleinfo.json.
juce_add_plugin(siann_test_plugin
  PRODUCT_NAME siann_test_plugin
  PLUGIN_NAME "SIANN Test Plugin"
  VERSION 1.0.0
  COMPANY_NAME SIANN
  PLUGIN_MANUFACTURER_CODE Sian
  PLUGIN_CODE Stp0
  FORMATS ${siann_test_plugin_formats}
  IS_SYNTH FALSE
  NEEDS_MIDI_INPUT FALSE
  NEEDS_MIDI_OUTPUT TRUE
  COPY_PLUGIN_AFTER_BUILD FALSE
  VST3_AUTO_MANIFEST FALSE)

# vst3_restarter.cpp includes the VST3 SDK's headers, which do not build under
# SIANN's warnings, so it stays outside siann_apply_source_options.
target_sources(siann_test_plugin PRIVATE processor.cpp vst3_restarter.cpp)
target_compile_features(siann_test_plugin PRIVATE cxx_std_20)
target_compile_definitions(siann_test_plugin PUBLIC
  JUCE_USE_CURL=0
  JUCE_WEB_BROWSER=0
  JUCE_VST3_CAN_REPLACE_VST2=0)
target_link_libraries(siann_test_plugin
  PRIVATE juce::juce_audio_processors
  PUBLIC juce::juce_recommended_config_flags)
if(MSVC)
  target_compile_options(siann_test_plugin PRIVATE /utf-8)  # JUCE sources are UTF-8
endif()
siann_apply_source_options(processor.cpp)
