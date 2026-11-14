# A compiler cache as the compiler launcher, when one is installed: sccache first,
# then ccache. Included right after project(), before any target.
#
#   SIANN_NO_COMPILER_CACHE=1     environment opt-out (or -DSIANN_COMPILER_CACHE=OFF)
#   SIANN_SCCACHE=<path>          an sccache executable outside PATH
#   -DCMAKE_CXX_COMPILER_LAUNCHER kept as given; only the MSVC debug format below applies
#
# Without a cache nothing changes. The launcher is set as a normal variable on every
# configure, so the opt-out takes effect on the next configure of an existing tree.
option(SIANN_COMPILER_CACHE "Use sccache or ccache as the compiler launcher when one is found" ON)

set(_siann_cache_off FALSE)
if(NOT SIANN_COMPILER_CACHE)
  set(_siann_cache_off TRUE)
elseif(DEFINED ENV{SIANN_NO_COMPILER_CACHE} AND NOT "$ENV{SIANN_NO_COMPILER_CACHE}" MATCHES "^(|0|OFF|off|false|FALSE)$")
  set(_siann_cache_off TRUE)
endif()

if(NOT _siann_cache_off AND NOT CMAKE_CXX_COMPILER_LAUNCHER)
  if(CMAKE_GENERATOR MATCHES "Visual Studio|Xcode")
    message(STATUS "SIANN compiler cache: none (the ${CMAKE_GENERATOR} generator ignores compiler launchers; use Ninja)")
  else()
    set(_siann_launcher "")
    if(DEFINED ENV{SIANN_SCCACHE} AND EXISTS "$ENV{SIANN_SCCACHE}" AND NOT IS_DIRECTORY "$ENV{SIANN_SCCACHE}")
      file(TO_CMAKE_PATH "$ENV{SIANN_SCCACHE}" _siann_launcher)
    else()
      # winget installs sccache into a versioned package folder and only puts it on
      # PATH for shells started after the install.
      set(_siann_hints "")
      if(WIN32 AND DEFINED ENV{LOCALAPPDATA})
        file(TO_CMAKE_PATH "$ENV{LOCALAPPDATA}" _siann_local)
        file(GLOB _siann_hints LIST_DIRECTORIES TRUE
          "${_siann_local}/Microsoft/WinGet/Packages/Mozilla.sccache_*/sccache-*")
        list(APPEND _siann_hints "${_siann_local}/Microsoft/WinGet/Links")
      endif()
      find_program(SIANN_SCCACHE_PROGRAM NAMES sccache PATHS ${_siann_hints})
      if(SIANN_SCCACHE_PROGRAM AND EXISTS "${SIANN_SCCACHE_PROGRAM}")
        set(_siann_launcher "${SIANN_SCCACHE_PROGRAM}")
      else()
        find_program(SIANN_CCACHE_PROGRAM NAMES ccache)
        if(SIANN_CCACHE_PROGRAM AND EXISTS "${SIANN_CCACHE_PROGRAM}")
          set(_siann_launcher "${SIANN_CCACHE_PROGRAM}")
        endif()
      endif()
    endif()
    if(_siann_launcher)
      set(CMAKE_C_COMPILER_LAUNCHER "${_siann_launcher}")
      set(CMAKE_CXX_COMPILER_LAUNCHER "${_siann_launcher}")
      message(STATUS "SIANN compiler cache: ${_siann_launcher}")
    else()
      message(STATUS "SIANN compiler cache: none found (install sccache or ccache, or set SIANN_SCCACHE)")
    endif()
  endif()
endif()

# sccache and ccache cannot cache MSVC's /Zi, whose debug info goes to a PDB shared by
# every object of a target: debug info goes into each object instead (/Z7). JUCE and
# Catch2 ask for older CMake versions, which would leave CMP0141 OLD (and JUCE adding
# /Zi itself) in their directories, hence the policy default.
if(MSVC AND CMAKE_CXX_COMPILER_LAUNCHER)
  set(CMAKE_POLICY_DEFAULT_CMP0141 NEW)
  set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT "$<$<CONFIG:Debug,RelWithDebInfo>:Embedded>")
endif()
