# JUCE 9.0.3 under the AGPLv3 (ADR-0017), for the desktop host target only.
# The core never links JUCE; CI also builds without it.
include(FetchContent)
enable_language(C)  # JUCE compiles some C sources

set(JUCE_MODULES_ONLY ON CACHE BOOL "Only configure the JUCE modules" FORCE)
FetchContent_Declare(
  juce
  URL https://github.com/juce-framework/JUCE/archive/be29c81492b6151c8ea8d14c840e1311963b3a83.tar.gz
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
