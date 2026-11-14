# siann_hostile_plugin as a CLAP: the plugin that breaks the rules on purpose, so the
# CLAP hosting tests can check the host survives each behaviour (architecture spec,
# "siann-host: two targets, one interface", Hostile test plugin). Built beside
# siann_test_plugin the same way, and never installed: the tests use the build
# artefact's path, which the target's SIANN_PLUGIN_FILE names.
add_library(siann_hostile_plugin_CLAP MODULE siann_hostile_plugin_clap.cpp)
target_link_libraries(siann_hostile_plugin_CLAP PRIVATE siann_third_party_clap)
target_compile_features(siann_hostile_plugin_CLAP PRIVATE cxx_std_20)
siann_apply_compile_options(siann_hostile_plugin_CLAP)
# Always the shared (DLL) CRT, also in the static-CRT desktop-release preset: the
# plugin then aborts through the Universal CRT whose flags the host's main() turns
# off, so the crash tests check the shipped engine reaches them (spec, "Process
# model", Crash). A plugin with its own static CRT keeps flags no host can reach.
set_target_properties(siann_hostile_plugin_CLAP PROPERTIES
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
set_target_properties(siann_hostile_plugin_CLAP PROPERTIES OUTPUT_NAME siann_hostile_plugin)
if(APPLE)
  # A CLAP on macOS is a bundle; CMake writes its minimal Info.plist.
  set_target_properties(siann_hostile_plugin_CLAP PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION clap
    MACOSX_BUNDLE_BUNDLE_NAME siann_hostile_plugin
    MACOSX_BUNDLE_GUI_IDENTIFIER org.siann.hostile-plugin)
  set_target_properties(siann_hostile_plugin_CLAP PROPERTIES
    SIANN_PLUGIN_FILE "$<TARGET_BUNDLE_DIR:siann_hostile_plugin_CLAP>")
else()
  set_target_properties(siann_hostile_plugin_CLAP PROPERTIES
    PREFIX ""
    SUFFIX ".clap"
    SIANN_PLUGIN_FILE "$<TARGET_FILE:siann_hostile_plugin_CLAP>")
endif()
