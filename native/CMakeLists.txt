cmake_minimum_required(VERSION 3.25)

project(siann_native VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(SIANN_BUILD_TESTS "Build SIANN native tests" ON)
option(SIANN_WERROR "Treat compiler warnings as errors" OFF)
set(SIANN_FIXTURES_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../fixtures"
    CACHE PATH "Fixtures shared by the Node bridge and the native engine")

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(SiannCompileOptions)
include(SiannThirdParty)

if(SIANN_BUILD_TESTS)
  enable_testing()
  include(FetchContent)
  # Catch2 v3.7.1, pinned by commit.
  FetchContent_Declare(
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
add_subdirectory(libs/host_fake)
add_subdirectory(libs/graph)
add_subdirectory(libs/engine)
add_subdirectory(libs/realtime)
add_subdirectory(apps/cli)
