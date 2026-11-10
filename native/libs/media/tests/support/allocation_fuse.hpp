#pragma once

// A test-only fuse on the global allocation functions (allocation_fuse.cpp
// replaces operator new for the media test executable). While a fuse is armed,
// any single allocation larger than its limit throws std::bad_alloc instead of
// being made, and the largest request is recorded either way, so a test can
// show that code sizes its buffers by what it has read rather than by what an
// untrusted header claims.

#include <cstddef>

namespace siann::media::testing {

class AllocationFuse {
public:
    explicit AllocationFuse(std::size_t limitBytes);
    ~AllocationFuse();
    AllocationFuse(const AllocationFuse&) = delete;
    AllocationFuse& operator=(const AllocationFuse&) = delete;

    // The largest single request since the fuse was armed.
    std::size_t largest() const noexcept;
    // Whether a request went over the limit (and was refused).
    bool blown() const noexcept;
};

}  // namespace siann::media::testing
