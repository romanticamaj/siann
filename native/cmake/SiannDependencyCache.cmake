# Third-party sources shared by every build tree on the machine.
#
# With SIANN_DEPS_CACHE_DIR set (environment or -D; scripts/check-all.js sets it),
# each dependency is fetched once into <cache>/<name>-<key>, where the key hashes
# the pinned archive hash or Git commit, and every build tree then uses that copy
# through FETCHCONTENT_SOURCE_DIR_<NAME>. Only sources are shared: each build tree
# still configures and builds its own copy, so worktrees never share a build.
# Concurrent configures take a file lock per dependency; a copy is used only once
# its fetch has completed (the .siann-complete marker). A short cache path outside
# the worktree also keeps Git checkouts clear of Windows' MAX_PATH.
#
# Without it, FetchContent behaves as before (sources under <build>/_deps).
include(FetchContent)
include("${CMAKE_CURRENT_LIST_DIR}/SiannStaleBuildCache.cmake")

if(NOT SIANN_DEPS_CACHE_DIR AND DEFINED ENV{SIANN_DEPS_CACHE_DIR})
  file(TO_CMAKE_PATH "$ENV{SIANN_DEPS_CACHE_DIR}" SIANN_DEPS_CACHE_DIR)
endif()

function(_siann_git_fetch dir repository commit no_submodules)
  find_package(Git REQUIRED)
  set(tmp "${dir}.tmp")
  file(REMOVE_RECURSE "${tmp}")
  file(MAKE_DIRECTORY "${tmp}")
  set(commands
    "init --quiet"
    "fetch --quiet --depth 1 ${repository} ${commit}"
    "-c advice.detachedHead=false checkout --quiet FETCH_HEAD")
  if(NOT no_submodules)
    list(APPEND commands "submodule update --quiet --init --recursive --depth 1")
  endif()
  foreach(command IN LISTS commands)
    separate_arguments(args NATIVE_COMMAND "${command}")
    execute_process(COMMAND "${GIT_EXECUTABLE}" -c core.longpaths=true ${args}
      WORKING_DIRECTORY "${tmp}" RESULT_VARIABLE failed ERROR_VARIABLE error)
    if(failed)
      file(REMOVE_RECURSE "${tmp}")
      message(FATAL_ERROR "git ${command} for ${repository} failed: ${error}")
    endif()
  endforeach()
  file(RENAME "${tmp}" "${dir}")
endfunction()

# Where FetchContent puts <name>'s sources and build when nothing overrides them.
function(_siann_default_dirs source_out binary_out lower)
  cmake_parse_arguments(dep "" "SOURCE_DIR;BINARY_DIR" "" ${ARGN})
  set(base "${FETCHCONTENT_BASE_DIR}")
  if(NOT base)
    set(base "${CMAKE_BINARY_DIR}/_deps")
  endif()
  if(NOT dep_SOURCE_DIR)
    set(dep_SOURCE_DIR "${base}/${lower}-src")
  endif()
  if(NOT dep_BINARY_DIR)
    set(dep_BINARY_DIR "${base}/${lower}-build")
  endif()
  set(${source_out} "${dep_SOURCE_DIR}" PARENT_SCOPE)
  set(${binary_out} "${dep_BINARY_DIR}" PARENT_SCOPE)
endfunction()

# siann_declare_dependency(<name> [NO_SUBMODULES] <FetchContent_Declare content options>)
# NO_SUBMODULES clones without Git submodules (an empty GIT_SUBMODULES, which cannot
# travel through a list of arguments).
function(siann_declare_dependency name)
  set(args ${ARGN})
  set(no_submodules FALSE)
  list(FIND args NO_SUBMODULES at)
  if(NOT at EQUAL -1)
    list(REMOVE_AT args ${at})
    set(no_submodules TRUE)
  endif()
  if(no_submodules)
    FetchContent_Declare(${name} ${args} GIT_SUBMODULES "")
  else()
    FetchContent_Declare(${name} ${args})
  endif()

  string(TOUPPER "${name}" upper)
  string(TOLOWER "${name}" lower)
  # Where the sources are, for scripts/check-all.js (its g++ step); empty = <build>/_deps.
  # FetchContent keeps FETCHCONTENT_SOURCE_DIR_<NAME> in the cache once set: a value
  # inside the shared cache is ours and recomputed below (a new pin gets a new
  # directory); any other value is the user's own checkout and stays.
  set(own "")
  if(DEFINED FETCHCONTENT_SOURCE_DIR_${upper})
    set(own "${FETCHCONTENT_SOURCE_DIR_${upper}}")
    string(FIND "${own}" "${SIANN_DEPS_CACHE_DIR}/" at)
    if(SIANN_DEPS_CACHE_DIR AND at EQUAL 0)
      set(own "")
    endif()
  endif()
  set(SIANN_DEP_SOURCE_DIR_${upper} "${own}" CACHE INTERNAL "Source directory of ${name} outside the build tree")
  if(NOT SIANN_DEPS_CACHE_DIR OR NOT own STREQUAL "")
    _siann_default_dirs(source binary "${lower}" ${args})
    if(NOT own STREQUAL "")
      set(source "${own}")
    endif()
    siann_remove_stale_nested_caches("${binary}" "${source}")
    return()
  endif()

  # SOURCE_SUBDIR only matters to FetchContent_MakeAvailable.
  cmake_parse_arguments(dep "" "URL_HASH;SOURCE_SUBDIR" "" ${args})
  set(content ${dep_UNPARSED_ARGUMENTS})
  if(dep_URL_HASH)
    # An archive is the same whichever URL or local copy delivers it.
    set(identity "${dep_URL_HASH}")
    list(APPEND content URL_HASH "${dep_URL_HASH}")
  else()
    set(identity "${content};submodules=${no_submodules}")
  endif()
  string(SHA256 key "${identity}")
  string(SUBSTRING "${key}" 0 16 key)
  set(dir "${SIANN_DEPS_CACHE_DIR}/${lower}-${key}")

  file(MAKE_DIRECTORY "${SIANN_DEPS_CACHE_DIR}")
  file(LOCK "${dir}.lock" GUARD FUNCTION TIMEOUT 3600 RESULT_VARIABLE locked)
  if(NOT locked STREQUAL "0")
    message(FATAL_ERROR "could not lock ${dir}.lock: ${locked}")
  endif()
  if(NOT EXISTS "${dir}/.siann-complete")
    message(STATUS "Fetching ${name} into the shared dependency cache ${dir}")
    file(REMOVE_RECURSE "${dir}")
    cmake_parse_arguments(git "" "GIT_REPOSITORY;GIT_TAG" "" ${content})
    if(git_GIT_REPOSITORY AND git_GIT_TAG)
      # The pinned commit alone, shallow: no history, and submodules only when asked.
      _siann_git_fetch("${dir}" "${git_GIT_REPOSITORY}" "${git_GIT_TAG}" ${no_submodules})
    else()
      set(work "${CMAKE_BINARY_DIR}/_deps/${lower}-fetch")
      file(REMOVE_RECURSE "${work}")
      FetchContent_Populate(siann_fetch_${lower} QUIET
        SOURCE_DIR "${dir}" SUBBUILD_DIR "${work}/subbuild" BINARY_DIR "${work}/build"
        ${content})
      file(REMOVE_RECURSE "${work}")
    endif()
    file(WRITE "${dir}/.siann-complete" "${identity}\n")
  endif()
  file(LOCK "${dir}.lock" RELEASE)

  # Build trees configured before the sources moved here keep nested caches of the
  # old location (JUCE's juceaide); see SiannStaleBuildCache.cmake.
  _siann_default_dirs(source binary "${lower}" ${args})
  siann_remove_stale_nested_caches("${binary}" "${dir}")

  set(FETCHCONTENT_SOURCE_DIR_${upper} "${dir}" PARENT_SCOPE)
  set(SIANN_DEP_SOURCE_DIR_${upper} "${dir}" CACHE INTERNAL "Shared source directory of ${name}")
endfunction()
