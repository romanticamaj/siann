#pragma once

// Transport orchestration (architecture spec, revision 3.1, "Locate").
//
// locate(target) takes a new generation and asks the butler to prepare the
// target at once. The dispatcher's tick() sends the locate to the audio thread
// through the driver's transportInbox when the butler is ready for that
// generation, or when it has not become ready within readyTimeout; the late
// locate then proceeds and the streams count underruns until their data
// arrives. Only the newest locate is ever pending, so a newer one cancels an
// older one that has not been sent.
//
// Play from stop is a locate to the current position that carries the start:
// the audio thread moves the playhead and starts it at the same block
// boundary. stop() pauses at once.
//
// locate(), play(), stop() and the getters may be called from any
// non-realtime thread; tick() runs on the control dispatcher's thread, the
// single producer of transportInbox. Nothing here runs on the audio thread.

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <optional>

#include "siann/realtime/disk_stream.hpp"
#include "siann/realtime/graph_driver.hpp"

namespace siann::realtime {

class Transport {
public:
    struct Options {
        std::chrono::milliseconds readyTimeout{1'000};
    };

    struct Status {
        bool playing = false;
        std::int64_t position = 0;
        std::uint64_t generation = 0;
        bool pendingLocate = false;
        std::uint64_t lateLocates = 0;
        std::uint64_t underruns = 0;  // summed over the butler's streams
    };

    Transport(GraphDriver& driver, Butler& butler, Options options);
    Transport(const Transport&) = delete;
    Transport& operator=(const Transport&) = delete;

    // A new generation; the butler starts preparing the target immediately.
    void locate(std::int64_t target);

    // While stopped: a locate to position() carrying the start (a pending
    // locate just gains the start). While playing: nothing.
    void play();

    // Pauses the playhead at the next block. A pending locate is kept but no
    // longer starts the transport, and neither does one already sent.
    void stop();

    // Dispatcher thread. Sends the pending locate when the butler is ready or
    // the timeout (counted from the first tick that saw it) has passed.
    // Returns the number of commands sent (0 or 1); a full transportInbox
    // keeps the locate pending for the next tick.
    std::size_t tick(std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now());

    // True while the playhead advances, or a start is pending or on its way
    // to the audio thread.
    bool playing() const;
    // The pending or sent target until the audio thread has applied it, then
    // the playhead.
    std::int64_t position() const;
    std::uint64_t generation() const;
    bool pendingLocate() const;
    // Locates that proceeded without the butler being ready.
    std::uint64_t lateLocates() const;
    Status status() const;

private:
    struct Pending {
        std::uint64_t generation = 0;
        std::int64_t target = 0;
        bool play = false;
        std::optional<std::chrono::steady_clock::time_point> seenAt;  // first tick
    };
    struct Sent {
        std::uint64_t generation = 0;
        std::int64_t target = 0;
        bool play = false;
    };

    bool playingLocked() const noexcept;
    std::int64_t positionLocked() const noexcept;
    bool sentUnapplied() const noexcept;

    GraphDriver& driver_;
    Butler& butler_;
    Options options_;
    mutable std::mutex mutex_;
    std::optional<Pending> pending_;
    std::optional<Sent> sent_;  // the last command sent
    std::uint64_t generation_ = 0;
    std::uint64_t lateLocates_ = 0;
};

}  // namespace siann::realtime
