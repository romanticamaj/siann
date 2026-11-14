# JUCE 9.0.3 under the AGPLv3 (ADR-0017), for the desktop host target only.
# The core never links JUCE; CI also builds without it.
include(FetchContent)
enable_language(C)  # JUCE compiles some C sources

# OFF: juce_add_plugin (the CI test plugin) lives in JUCEUtils.cmake, which the
# modules-only configuration never includes. Costs one juceaide build per configure.
set(JUCE_MODULES_ONLY OFF CACHE BOOL "Also load the JUCE CMake helpers" FORCE)
# A local copy of the same archive (CI caches one); the hash below still checks it.
set(SIANN_JUCE_ARCHIVE "https://github.com/juce-framework/JUCE/archive/be29c81492b6151c8ea8d14c840e1311963b3a83.tar.gz"
    CACHE STRING "JUCE source archive: the pinned URL or a local file of it")
siann_declare_dependency(
  juce
  URL "${SIANN_JUCE_ARCHIVE}"
  URL_HASH SHA256=f846e74503e5b959b1de514c772b05ab1cb05478b7513b19d6294cb2b3d2906a
)
FetchContent_MakeAvailable(juce)

# Strict SIANN warnings for SIANN's own sources inside a target that also
# compiles JUCE module sources, which keep JUCE's own warning level.
function(siann_apply_source_options)
  foreach(source IN LISTS ARGN)
    if(MSVC)
      set(options /W4 /permissive- /utf-8 /Zc:__cplusplus /Zc:preprocessor /wd4324)
      if(SIANN_WERROR)
        list(APPEND options /WX)
      endif()
    else()
      set(options -Wall -Wextra -Wpedantic -Wshadow)
      if(SIANN_WERROR)
        list(APPEND options -Werror)
      endif()
    endif()
    set_source_files_properties(${source} PROPERTIES COMPILE_OPTIONS "${options}")
  endforeach()
endfunction()
