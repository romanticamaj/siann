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

# Ninja learns each object's headers from cl's /showIncludes lines, which start with a
# localized prefix ("Note: including file:"). CMake detects that prefix from cl alone
# and writes it into rules.ninja in the ANSI code page. sccache re-encodes cl's output
# as UTF-8, mangling a prefix in another code page (a Traditional Chinese cl's, say):
# Ninja then records no headers and a changed header rebuilds nothing. So the prefix
# is read again through the launcher; the launcher is used only when it matches.
# Empty when no line names the probe header.
function(_siann_launcher_showincludes_prefix launcher out)
  set(dir "${CMAKE_BINARY_DIR}/CMakeFiles/siann-showincludes")
  file(MAKE_DIRECTORY "${dir}")
  file(WRITE "${dir}/siann_probe_header.h" "#pragma once\n")
  file(WRITE "${dir}/siann_probe.cpp" "#include \"siann_probe_header.h\"\nint siann_probe;\n")
  execute_process(
    COMMAND "${launcher}" "${CMAKE_CXX_COMPILER}" /nologo /showIncludes /c siann_probe.cpp /Fosiann_probe.obj
    WORKING_DIRECTORY "${dir}"
    OUTPUT_VARIABLE output ERROR_VARIABLE output
    ENCODING NONE
    RESULT_VARIABLE failed)
  set(prefix "")
  if(NOT failed)
    # Matched on the whole output, not a list of lines: the prefix can hold a "]",
    # which would stop a CMake list from splitting there.
    string(REPLACE "\r" "" output "${output}")
    if(output MATCHES "([^\n]*[^ \n]) +[A-Za-z]:[\\/][^\n]*siann_probe_header\\.h")
      set(prefix "${CMAKE_MATCH_1} ")
    endif()
  endif()
  set(${out} "${prefix}" PARENT_SCOPE)
endfunction()

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
    set(_siann_rejected FALSE)
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
    if(_siann_launcher AND MSVC AND CMAKE_GENERATOR MATCHES "Ninja")
      _siann_launcher_showincludes_prefix("${_siann_launcher}" _siann_prefix)
      if(NOT _siann_prefix STREQUAL CMAKE_CL_SHOWINCLUDES_PREFIX)
        message(WARNING "SIANN compiler cache: not using ${_siann_launcher}. Through it, cl's "
          "/showIncludes lines no longer start with \"${CMAKE_CL_SHOWINCLUDES_PREFIX}\", so Ninja would "
          "not see header changes. With a non-English cl, install the English language pack "
          "(Visual Studio Installer, Modify, Language packs) and set VSLANG=1033 "
          "(scripts/check-all.js does), then delete the build directory.")
        set(_siann_launcher "")
        set(_siann_rejected TRUE)
      endif()
    endif()
    if(_siann_rejected)
      # The warning above says why.
    elseif(_siann_launcher)
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
