# Nested CMake caches left behind when a dependency's sources move.
#
# A dependency may configure a second CMake project inside its own build directory:
# JUCE configures juceaide into <juce build>/tools, from JUCE's source directory.
# That nested CMakeCache.txt remembers the source directory it was made from, so
# once the dependency's sources move (the shared cache of SiannDependencyCache.cmake
# replacing <build>/_deps/<name>-src, or the reverse), the next configure fails with
# "The source ... does not match the source ... used to generate cache". Such a
# directory is only a build artifact: it is removed, and the dependency configures
# it again from the current sources.
#
# No other dependency: usable in script mode (cmake -P), where the tests run it.

function(_siann_normalized_path out path)
  if(EXISTS "${path}")
    file(REAL_PATH "${path}" path)
  endif()
  file(TO_CMAKE_PATH "${path}" path)
  string(REGEX REPLACE "/+$" "" path "${path}")
  if(CMAKE_HOST_WIN32)
    string(TOLOWER "${path}" path)  # drive letters and paths compare without case on Windows
  endif()
  set(${out} "${path}" PARENT_SCOPE)
endfunction()

# TRUE when <path> is <dir> or lies inside it.
function(_siann_path_within out path dir)
  _siann_normalized_path(path "${path}")
  _siann_normalized_path(dir "${dir}")
  set(inside FALSE)
  if(path STREQUAL dir)
    set(inside TRUE)
  else()
    string(FIND "${path}" "${dir}/" at)
    if(at EQUAL 0)
      set(inside TRUE)
    endif()
  endif()
  set(${out} ${inside} PARENT_SCOPE)
endfunction()

# siann_remove_stale_nested_caches(<binary dir> <source dir>)
# Removes each directory of <binary dir>, or <binary dir> itself, whose
# CMakeCache.txt was generated from a source outside both <source dir> and
# <binary dir> (sources a project generates into its build tree stay valid).
function(siann_remove_stale_nested_caches binary_dir source_dir)
  if(NOT IS_DIRECTORY "${binary_dir}")
    return()
  endif()
  file(GLOB caches LIST_DIRECTORIES FALSE
    "${binary_dir}/CMakeCache.txt" "${binary_dir}/*/CMakeCache.txt")
  foreach(cache IN LISTS caches)
    file(STRINGS "${cache}" home REGEX "^CMAKE_HOME_DIRECTORY:[A-Z]+=" LIMIT_COUNT 1)
    if(NOT home)
      continue()
    endif()
    string(REGEX REPLACE "^CMAKE_HOME_DIRECTORY:[A-Z]+=" "" home "${home}")
    _siann_path_within(in_source "${home}" "${source_dir}")
    _siann_path_within(in_binary "${home}" "${binary_dir}")
    if(in_source OR in_binary)
      continue()
    endif()
    get_filename_component(stale "${cache}" DIRECTORY)
    message(STATUS "Removing ${stale}: configured from ${home}, now ${source_dir}")
    file(REMOVE_RECURSE "${stale}")
  endforeach()
endfunction()
