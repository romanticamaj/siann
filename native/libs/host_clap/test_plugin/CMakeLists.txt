# siann_test_plugin as a CLAP: the plugin the CLAP hosting tests load. Hand-written
# against the SDK, so it builds with no JUCE in every preset. Never installed: the
# tests use the build artefact's path, which the target's SIANN_PLUGIN_FILE names.
add_library(siann_test_plugin_CLAP MODULE siann_test_plugin_clap.cpp)
target_link_libraries(siann_test_plugin_CLAP PRIVATE siann_third_party_clap)
target_compile_features(siann_test_plugin_CLAP PRIVATE cxx_std_20)
siann_apply_compile_options(siann_test_plugin_CLAP)
set_target_properties(siann_test_plugin_CLAP PROPERTIES OUTPUT_NAME siann_test_plugin)
if(APPLE)
  # A CLAP on macOS is a bundle; CMake writes its minimal Info.plist.
  set_target_properties(siann_test_plugin_CLAP PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION clap
    MACOSX_BUNDLE_BUNDLE_NAME siann_test_plugin
    MACOSX_BUNDLE_GUI_IDENTIFIER org.siann.test-plugin)
  set_target_properties(siann_test_plugin_CLAP PROPERTIES
    SIANN_PLUGIN_FILE "$<TARGET_BUNDLE_DIR:siann_test_plugin_CLAP>")
else()
  set_target_properties(siann_test_plugin_CLAP PROPERTIES
    PREFIX ""
    SUFFIX ".clap"
    SIANN_PLUGIN_FILE "$<TARGET_FILE:siann_test_plugin_CLAP>")
endif()
