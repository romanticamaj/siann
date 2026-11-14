cmake_minimum_required(VERSION 3.25)

project(siann_native VERSION 0.1.0 LANGUAGES CXX)

# sccache or ccache when installed, and a shared third-party source cache when
# SIANN_DEPS_CACHE_DIR is set (scripts/check-all.js sets both up).
include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/SiannCompilerCache.cmake")
include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/SiannDependencyCache.cmake")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(SIANN_BUILD_TESTS "Build SIANN native tests" ON)
option(SIANN_WERROR "Treat compiler warnings as errors" OFF)
option(SIANN_WITH_JUCE "Build the JUCE desktop host target (AGPLv3, ADR-0017)" OFF)
set(SIANN_FIXTURES_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../fixtures"
    CACHE PATH "Fixtures shared by the Node bridge and the native engine")

option(SIANN_RTSAN "Build everything with Clang RealtimeSanitizer (-fsanitize=realtime, Clang 20+)" OFF)

# Before any target, third-party code included: r8brain's process() and
# Catch2 run inside realtime scopes in the tests, so they are instrumented
# and linked against the sanitizer runtime too.
if(SIANN_RTSAN)
  if(NOT CMAKE_CXX_COMPILER_ID STREQUAL "Clang" OR CMAKE_CXX_COMPILER_VERSION VERSION_LESS 20)
    message(FATAL_ERROR "SIANN_RTSAN needs Clang 20 or later (found ${CMAKE_CXX_COMPILER_ID} "
                        "${CMAKE_CXX_COMPILER_VERSION}); install it from apt.llvm.org")
  endif()
  add_compile_options(-fsanitize=realtime -fno-omit-frame-pointer)
  add_link_options(-fsanitize=realtime)
  add_compile_definitions(SIANN_RTSAN=1)
endif()

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(SiannCompileOptions)
include(SiannThirdParty)
include(SiannBuildInfo)

if(SIANN_BUILD_TESTS)
  enable_testing()
  include(FetchContent)
  # Catch2 v3.7.1, pinned by commit.
  siann_declare_dependency(
    Catch2
    GIT_REPOSITORY https://github.com/catchorg/Catch2.git
    GIT_TAG 9827c148c397289df17d3967692619a198032a24
  )
  FetchContent_MakeAvailable(Catch2)
  list(APPEND CMAKE_MODULE_PATH "${catch2_SOURCE_DIR}/extras")
  include(Catch)
endif()

add_subdirectory(libs/hash)
add_subdirectory(libs/time)
add_subdirectory(libs/midi)
add_subdirectory(libs/model)
add_subdirectory(libs/command)
add_subdirectory(libs/io)
add_subdirectory(libs/media)
add_subdirectory(libs/session)
add_subdirectory(libs/rt)
add_subdirectory(libs/host_api)
add_subdirectory(libs/host_common)
add_subdirectory(libs/host_fake)
add_subdirectory(libs/graph)
add_subdirectory(libs/engine)
add_subdirectory(libs/realtime)
add_subdirectory(libs/playback)
add_subdirectory(libs/protocol)
add_subdirectory(libs/host_clap)

# Before the CLI, which links the desktop host when it is built.
if(SIANN_WITH_JUCE)
  include(SiannJuce)
  add_subdirectory(libs/host_desktop)
endif()

add_subdirectory(apps/cli)
add_subdirectory(apps/engine)
