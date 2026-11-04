// RealtimeSanitizer canary (architecture spec, "Realtime rules and
// enforcement"). Built and registered only when SIANN_RTSAN is ON. Each mode
// does one forbidden thing inside siann::rt::ScopedRealtimeThread; ctest
// expects a RealtimeSanitizer report for it, which proves that the scope every
// audio callback runs in is the sanitizer's realtime context. "disabled" does
// the same allocation under ScopedRealtimeSanitizerDisabler and must exit 0.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>

#include <time.h>

#include "siann/rt/realtime_thread.hpp"

namespace {

int allocateBlock() {
    void* volatile p = std::malloc(64);
    std::free(p);
    return 0;
}

int lockMutex() {
    static std::mutex mutex;
    mutex.lock();
    mutex.unlock();
    return 0;
}

int sleepBriefly() {
    const timespec duration{0, 1'000'000};
    nanosleep(&duration, nullptr);
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::fputs("usage: siann_rtsan_canary alloc|lock|sleep|disabled\n", stderr);
        return 2;
    }
    if (!siann::rt::realtimeSanitizerActive()) {
        std::fputs("canary: this build has no sanitizer runtime\n", stderr);
        return 1;
    }
    const char* mode = argv[1];
    if (std::strcmp(mode, "disabled") == 0) {
        const siann::rt::ScopedRealtimeThread realtime;
        // Reason: this mode checks that the disabler silences the sanitizer.
        const siann::rt::ScopedRealtimeSanitizerDisabler allowed;
        return allocateBlock();
    }
    int result = 2;
    {
        const siann::rt::ScopedRealtimeThread realtime;
        if (std::strcmp(mode, "alloc") == 0) {
            result = allocateBlock();
        } else if (std::strcmp(mode, "lock") == 0) {
            result = lockMutex();
        } else if (std::strcmp(mode, "sleep") == 0) {
            result = sleepBriefly();
        }
    }
    if (result == 2) {
        std::fprintf(stderr, "canary: unknown mode %s\n", mode);
        return 2;
    }
    // Reached only when the sanitizer did not halt the process.
    std::fputs("canary: no sanitizer report\n", stderr);
    return 1;
}
