# The running build's source location and commit (ADR-0017, point 4: AGPL
# section 13). Captured at build time, not configure time: a custom target runs
# this file in script mode on every build and rewrites the header only when
# its content changes, so a new commit is picked up without reconfiguring and
# an unchanged one rebuilds nothing.
#
# Builds from a tarball (no .git) set the cache variables:
#   SIANN_SOURCE_COMMIT  40 hex characters
#   SIANN_SOURCE_URL     where the corresponding source is offered

if(CMAKE_SCRIPT_MODE_FILE)
  # Script mode: SOURCE_DIR, TEMPLATE, OUTPUT, URL, COMMIT_OVERRIDE, NAME,
  # VERSION and LICENSE come in as -D definitions.
  set(SIANN_BUILD_COMMIT "")
  set(SIANN_BUILD_DIRTY "false")
  if(COMMIT_OVERRIDE)
    string(TOLOWER "${COMMIT_OVERRIDE}" SIANN_BUILD_COMMIT)
  else()
    find_program(SIANN_GIT git)
    if(SIANN_GIT)
      execute_process(COMMAND "${SIANN_GIT}" -C "${SOURCE_DIR}" rev-parse HEAD
                      OUTPUT_VARIABLE head RESULT_VARIABLE head_result
                      OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
      if(head_result EQUAL 0)
        set(SIANN_BUILD_COMMIT "${head}")
        execute_process(COMMAND "${SIANN_GIT}" -C "${SOURCE_DIR}" status --porcelain
                        OUTPUT_VARIABLE status RESULT_VARIABLE status_result
                        OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET)
        if(NOT status_result EQUAL 0 OR NOT status STREQUAL "")
          set(SIANN_BUILD_DIRTY "true")
        endif()
      endif()
    endif()
  endif()
  string(LENGTH "${SIANN_BUILD_COMMIT}" commit_length)
  if(COMMIT_OVERRIDE AND (NOT SIANN_BUILD_COMMIT MATCHES "^[0-9a-f]+$" OR NOT commit_length EQUAL 40))
    message(FATAL_ERROR "SIANN_SOURCE_COMMIT must be 40 hex characters, got '${COMMIT_OVERRIDE}'")
  endif()
  if(NOT SIANN_BUILD_COMMIT MATCHES "^[0-9a-f]+$" OR NOT commit_length EQUAL 40)
    # Unknown: 40 zeros rather than nothing, so clients see a well-formed value.
    string(REPEAT "0" 40 SIANN_BUILD_COMMIT)
  endif()
  set(SIANN_BUILD_URL "${URL}")
  set(SIANN_BUILD_NAME "${NAME}")
  set(SIANN_BUILD_VERSION "${VERSION}")
  set(SIANN_BUILD_LICENSE "${LICENSE}")
  # configure_file leaves the output untouched when the content is the same.
  configure_file("${TEMPLATE}" "${OUTPUT}" @ONLY)
  return()
endif()

set(SIANN_SOURCE_URL "https://github.com/romanticamaj/siann"
    CACHE STRING "Where the source of this build is offered (ADR-0017)")
set(SIANN_SOURCE_COMMIT ""
    CACHE STRING "Commit of this build when it is not built from a git checkout")

# Generates <binary dir>/generated/siann_build_info.hpp for `target` from
# `template` at build time.
function(siann_add_build_info target template)
  set(dir "${CMAKE_CURRENT_BINARY_DIR}/generated")
  set(output "${dir}/siann_build_info.hpp")
  if(SIANN_WITH_JUCE)
    set(license "AGPL-3.0-or-later")
  else()
    set(license "GPL-2.0-or-later")
  endif()
  add_custom_target(${target}_build_info
    COMMAND "${CMAKE_COMMAND}"
            "-DSOURCE_DIR=${PROJECT_SOURCE_DIR}"
            "-DTEMPLATE=${template}"
            "-DOUTPUT=${output}"
            "-DURL=${SIANN_SOURCE_URL}"
            "-DCOMMIT_OVERRIDE=${SIANN_SOURCE_COMMIT}"
            "-DNAME=siann-engine"
            "-DVERSION=${PROJECT_VERSION}"
            "-DLICENSE=${license}"
            -P "${CMAKE_CURRENT_FUNCTION_LIST_FILE}"
    BYPRODUCTS "${output}"
    COMMENT "Capturing the source commit for ${target}"
    VERBATIM)
  add_dependencies(${target} ${target}_build_info)
  target_include_directories(${target} PRIVATE "${dir}")
  target_compile_definitions(${target} PRIVATE SIANN_BUILD_INFO_REQUIRED=1)
endfunction()
