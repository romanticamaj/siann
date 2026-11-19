// The libFuzzer driver of every siann_fuzz_<target> (SIANN_FUZZ=ON, Clang): each
// executable compiles this file with SIANN_FUZZ_TARGET set to its harness.hpp
// function (native/fuzz/CMakeLists.txt).

#include <cstddef>
#include <cstdint>

#include "siann/fuzz/harness.hpp"

#ifndef SIANN_FUZZ_TARGET
#error "SIANN_FUZZ_TARGET names the harness function of this fuzz target"
#endif

extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size) {
    siann::fuzz::SIANN_FUZZ_TARGET(data, size);
    return 0;
}
