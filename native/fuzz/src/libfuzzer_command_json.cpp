// libFuzzer driver of siann_fuzz_command_json (SIANN_FUZZ=ON, Clang): harness.hpp's commandJson().

#include <cstddef>
#include <cstdint>
#include <string_view>

#include "siann/fuzz/harness.hpp"

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
    siann::fuzz::commandJson(std::string_view(reinterpret_cast<const char*>(data), size));
    return 0;
}
