# siann_test_plugin as a CLAP: the plugin the CLAP hosting tests load. Hand-written
# against the SDK, so it builds with no JUCE in every preset. Never installed: the
# tests use the build artefact's path, which the target's SIANN_PLUGIN_FILE names.
add_library(siann_test_plugin_CLAP MODULE siann_test_plugin_clap.cpp siann_test_plugin_gui.cpp)
# Threads: "editorSizeWorker" asks for a resize from a thread of the plugin's own.
find_package(Threads REQUIRED)
target_link_libraries(siann_test_plugin_CLAP PRIVATE siann_third_party_clap Threads::Threads)
target_compile_features(siann_test_plugin_CLAP PRIVATE cxx_std_20)
siann_apply_compile_options(siann_test_plugin_CLAP)
# The editor's view (m5-clap-editor-window), drawn with the platform's own API. On
# Linux only where X11 is found: without it the plugin has no gui extension, which is
# what the core-only jobs build. SIANN_TEST_PLUGIN_X11 goes to the tests that ask.
set(SIANN_TEST_PLUGIN_X11 OFF)
if(WIN32)
  target_link_libraries(siann_test_plugin_CLAP PRIVATE user32 gdi32)
elseif(APPLE)
  target_sources(siann_test_plugin_CLAP PRIVATE siann_test_plugin_gui_mac.mm)
  target_link_libraries(siann_test_plugin_CLAP PRIVATE "-framework AppKit" "-framework QuartzCore")
else()
  find_package(X11 QUIET)
  if(X11_FOUND)
    set(SIANN_TEST_PLUGIN_X11 ON)
    target_compile_definitions(siann_test_plugin_CLAP PRIVATE SIANN_TEST_PLUGIN_X11=1)
    target_link_libraries(siann_test_plugin_CLAP PRIVATE X11::X11)
  endif()
endif()
set(SIANN_TEST_PLUGIN_X11 ${SIANN_TEST_PLUGIN_X11} PARENT_SCOPE)
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
