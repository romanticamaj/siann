# Third-party code for the native core, pinned by commit. SOURCE_SUBDIR points
# at a directory without a CMakeLists.txt so that no upstream targets or tests
# are added; SIANN defines its own targets below.
include(FetchContent)

# dr_libs wav-0.14.5 (public domain / MIT-0): WAV decoding.
FetchContent_Declare(
  dr_libs
  GIT_REPOSITORY https://github.com/mackron/dr_libs.git
  GIT_TAG fa931f3285ced10ace628f7f1ac951e1951e7ea6
  SOURCE_SUBDIR siann-no-cmake
)

# r8brain-free-src version-6.5 (MIT): offline sample-rate conversion.
FetchContent_Declare(
  r8brain
  GIT_REPOSITORY https://github.com/avaneev/r8brain-free-src.git
  GIT_TAG 3c930bf6825c0cfea4a813210c83b1a650c820b5
  SOURCE_SUBDIR siann-no-cmake
)

FetchContent_MakeAvailable(dr_libs r8brain)

add_library(siann_third_party_dr_libs INTERFACE)
target_include_directories(siann_third_party_dr_libs SYSTEM INTERFACE "${dr_libs_SOURCE_DIR}")

add_library(siann_third_party_r8brain STATIC "${r8brain_SOURCE_DIR}/r8bbase.cpp")
target_include_directories(siann_third_party_r8brain SYSTEM PUBLIC "${r8brain_SOURCE_DIR}")
target_compile_features(siann_third_party_r8brain PUBLIC cxx_std_20)
if(MSVC)
  target_compile_options(siann_third_party_r8brain PRIVATE /W0 /utf-8)
else()
  target_compile_options(siann_third_party_r8brain PRIVATE -w)
endif()
