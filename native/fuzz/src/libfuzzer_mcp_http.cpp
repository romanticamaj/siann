// libFuzzer driver of siann_fuzz_mcp_http (SIANN_FUZZ=ON, Clang): harness.hpp's mcpHttp().

#include <cstddef>
#include <cstdint>
#include <string_view>

#include "siann/fuzz/harness.hpp"

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
    siann::fuzz::mcpHttp(std::string_view(reinterpret_cast<const char*>(data), size));
    return 0;
}
