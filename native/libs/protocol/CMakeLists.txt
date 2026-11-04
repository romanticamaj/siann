add_library(siann_protocol
  src/protocol_server.cpp
  src/ix_transport.cpp
)
add_library(siann::protocol ALIAS siann_protocol)
target_include_directories(siann_protocol PUBLIC include)
target_link_libraries(siann_protocol PUBLIC siann::session PRIVATE siann_third_party_ixwebsocket)
target_compile_features(siann_protocol PUBLIC cxx_std_20)
siann_apply_compile_options(siann_protocol)

if(SIANN_BUILD_TESTS)
  add_executable(siann_protocol_tests
    tests/protocol_server_test.cpp
    tests/ix_transport_test.cpp
  )
  # The IXWebSocket client drives the loopback tests.
  target_link_libraries(siann_protocol_tests PRIVATE siann::protocol siann_third_party_ixwebsocket
    Catch2::Catch2WithMain)
  siann_apply_compile_options(siann_protocol_tests)
  catch_discover_tests(siann_protocol_tests)
endif()
