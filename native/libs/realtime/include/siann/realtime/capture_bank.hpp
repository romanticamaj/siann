#pragma once

// The capture bank (m5b-engine-record; spec, "Recording"): a fixed number of
// preallocated slots the graph driver feeds with every input block. A slot is a
// Recorder of up to two channels, a channel map {port, channels} into the
// device input and an armed flag, packed into one atomic so the audio thread
// reads a consistent map with one load. Arming, disarming and starting a slot's
// recorder are control-side calls that are legal while the device runs: the
// audio thread allocates nothing, takes no lock and never blocks here.
//
// Every block, each armed slot is metered (peak and RMS per channel, written to
// atomics the meter publisher reads), whether the transport plays or not, and
// its recorder is handed the slot's channels (it keeps them only while it
// records and the transport plays). A map that reaches past the device's input
// channels is skipped.

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

#include "siann/host/buffer.hpp"
#include "siann/realtime/recorder.hpp"

namespace siann::realtime {

// The newest input meter of a slot: the last metered block's peak and RMS per
// channel, and how many blocks were metered since the bank was built.
struct InputMeterReading {
    int channels = 0;
    std::array<float, 2> peak{};
    std::array<float, 2> rms{};
    std::uint64_t blocks = 0;
};

// At namespace scope so GCC sees the default member initializers when traits
// are checked inside GraphDriver::Options.
struct CaptureOptions {
    std::size_t slots = 0;  // 0: no bank
    Recorder::Options recorder{};
};

class CaptureBank {
public:
    static constexpr int kMaxChannels = 2;

    explicit CaptureBank(const CaptureOptions& options);
    CaptureBank(const CaptureBank&) = delete;
    CaptureBank& operator=(const CaptureBank&) = delete;

    std::size_t size() const noexcept { return slots_.size(); }

    // Control side, any time. channels is 1 or 2, port non-negative.
    void arm(std::size_t slot, int port, int channels) noexcept;
    void disarm(std::size_t slot) noexcept;
    bool armed(std::size_t slot) const noexcept;
    Recorder& recorder(std::size_t slot) noexcept { return slots_[slot]->recorder; }
    InputMeterReading meter(std::size_t slot) const noexcept;

    // Audio thread: one input block stamped with its timeline position.
    void process(const host::AudioBufferView& input, std::int64_t timelinePosition, bool playing) noexcept;

private:
    struct Slot {
        explicit Slot(const Recorder::Options& options) : recorder(kMaxChannels, options) {}
        Recorder recorder;
        // kArmed | port << 8 | channels; 0 is disarmed.
        std::atomic<std::uint32_t> map{0};
        std::atomic<int> meterChannels{0};
        std::array<std::atomic<float>, kMaxChannels> peak{};
        std::array<std::atomic<float>, kMaxChannels> rms{};
        std::atomic<std::uint64_t> blocks{0};
    };

    std::vector<std::unique_ptr<Slot>> slots_;
};

}  // namespace siann::realtime
