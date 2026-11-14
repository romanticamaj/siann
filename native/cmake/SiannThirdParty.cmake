# Third-party code for the native core, pinned by commit. SOURCE_SUBDIR points
# at a directory without a CMakeLists.txt so that no upstream targets or tests
# are added; SIANN defines its own targets below.
include(FetchContent)

# dr_libs wav-0.14.5 (public domain / MIT-0): WAV decoding.
siann_declare_dependency(
  dr_libs
  NO_SUBMODULES  # its tests' miniaudio submodule: 200 MB, and paths past MAX_PATH
  GIT_REPOSITORY https://github.com/mackron/dr_libs.git
  GIT_TAG fa931f3285ced10ace628f7f1ac951e1951e7ea6
  SOURCE_SUBDIR siann-no-cmake
)

# r8brain-free-src version-6.5 (MIT): offline sample-rate conversion.
siann_declare_dependency(
  r8brain
  GIT_REPOSITORY https://github.com/avaneev/r8brain-free-src.git
  GIT_TAG 3c930bf6825c0cfea4a813210c83b1a650c820b5
  SOURCE_SUBDIR siann-no-cmake
)

# IXWebSocket v11.4.6 (BSD-3-Clause): HTTP and WebSocket for siann-protocol.
# Built without zlib and TLS (IXWEBSOCKET_USE_ZLIB / IXWEBSOCKET_USE_TLS
# undefined): the server binds 127.0.0.1 only; TLS arrives with LAN mode.
siann_declare_dependency(
  ixwebsocket
  GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
  GIT_TAG 2efe037c9cc96fd536774f17bdb5215161ee5087
  SOURCE_SUBDIR siann-no-cmake
)

# CLAP SDK 1.2.10 (MIT, header-only): plugin hosting on both host targets, and the
# test plugin. The commit's LICENSE was read when it was pinned.
siann_declare_dependency(
  clap
  GIT_REPOSITORY https://github.com/free-audio/clap.git
  GIT_TAG 195b42a004144fab0b3cf95e9c067187d15365b7
  SOURCE_SUBDIR siann-no-cmake
)

FetchContent_MakeAvailable(dr_libs r8brain ixwebsocket clap)

add_library(siann_third_party_dr_libs INTERFACE)
target_include_directories(siann_third_party_dr_libs SYSTEM INTERFACE "${dr_libs_SOURCE_DIR}")

add_library(siann_third_party_clap INTERFACE)
target_include_directories(siann_third_party_clap SYSTEM INTERFACE "${clap_SOURCE_DIR}/include")

add_library(siann_third_party_r8brain STATIC "${r8brain_SOURCE_DIR}/r8bbase.cpp")
target_include_directories(siann_third_party_r8brain SYSTEM PUBLIC "${r8brain_SOURCE_DIR}")
target_compile_features(siann_third_party_r8brain PUBLIC cxx_std_20)
if(MSVC)
  target_compile_options(siann_third_party_r8brain PRIVATE /W0 /utf-8)
else()
  target_compile_options(siann_third_party_r8brain PRIVATE -w)
endif()

# Upstream's source list without the TLS back ends (OpenSSL, MbedTLS, Apple).
set(SIANN_IXWEBSOCKET_SOURCES
  IXBench.cpp
  IXCancellationRequest.cpp
  IXConnectionState.cpp
  IXDNSLookup.cpp
  IXExponentialBackoff.cpp
  IXGetFreePort.cpp
  IXGzipCodec.cpp
  IXHttp.cpp
  IXHttpClient.cpp
  IXHttpServer.cpp
  IXNetSystem.cpp
  IXSelectInterrupt.cpp
  IXSelectInterruptFactory.cpp
  IXSelectInterruptPipe.cpp
  IXSelectInterruptEvent.cpp
  IXSetThreadName.cpp
  IXSocket.cpp
  IXSocketConnect.cpp
  IXSocketFactory.cpp
  IXSocketServer.cpp
  IXSocketTLSOptions.cpp
  IXStrCaseCompare.cpp
  IXUdpSocket.cpp
  IXUrlParser.cpp
  IXUuid.cpp
  IXUserAgent.cpp
  IXWebSocket.cpp
  IXWebSocketCloseConstants.cpp
  IXWebSocketHandshake.cpp
  IXWebSocketHttpHeaders.cpp
  IXWebSocketPerMessageDeflate.cpp
  IXWebSocketPerMessageDeflateCodec.cpp
  IXWebSocketPerMessageDeflateOptions.cpp
  IXWebSocketProxyServer.cpp
  IXWebSocketServer.cpp
  IXWebSocketTransport.cpp
)
list(TRANSFORM SIANN_IXWEBSOCKET_SOURCES PREPEND "${ixwebsocket_SOURCE_DIR}/ixwebsocket/")
add_library(siann_third_party_ixwebsocket STATIC ${SIANN_IXWEBSOCKET_SOURCES})
target_include_directories(siann_third_party_ixwebsocket SYSTEM PUBLIC "${ixwebsocket_SOURCE_DIR}")
target_compile_features(siann_third_party_ixwebsocket PUBLIC cxx_std_20)
if(MSVC)
  target_compile_options(siann_third_party_ixwebsocket PRIVATE /W0 /utf-8)
else()
  target_compile_options(siann_third_party_ixwebsocket PRIVATE -w)
endif()
if(WIN32)
  target_compile_definitions(siann_third_party_ixwebsocket PRIVATE _CRT_SECURE_NO_WARNINGS)
  target_link_libraries(siann_third_party_ixwebsocket PUBLIC ws2_32 wsock32 shlwapi)
else()
  find_package(Threads REQUIRED)
  target_link_libraries(siann_third_party_ixwebsocket PUBLIC Threads::Threads)
endif()
