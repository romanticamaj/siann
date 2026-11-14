#include "siann/realtime/capture_bank.hpp"

#include <algorithm>
#include <cmath>

namespace siann::realtime {

namespace {

constexpr std::uint32_t kArmed = 1u << 31;
constexpr std::uint32_t kPortMask = (1u << 23) - 1;

std::uint32_t pack(int port, int channels) noexcept {
    return kArmed | ((static_cast<std::uint32_t>(port) & kPortMask) << 8) | (static_cast<std::uint32_t>(channels) & 0xFF);
}

}  // namespace

CaptureBank::CaptureBank(const CaptureOptions& options) {
    slots_.reserve(options.slots);
    for (std::size_t i = 0; i < options.slots; ++i) {
        slots_.push_back(std::make_unique<Slot>(options.recorder));
    }
}

void CaptureBank::arm(std::size_t slot, int port, int channels) noexcept {
    if (slot >= slots_.size() || port < 0 || channels < 1 || channels > kMaxChannels) {
        return;
    }
    slots_[slot]->map.store(pack(port, channels), std::memory_order_release);
}

void CaptureBank::disarm(std::size_t slot) noexcept {
    if (slot < slots_.size()) {
        slots_[slot]->map.store(0, std::memory_order_release);
    }
}

bool CaptureBank::armed(std::size_t slot) const noexcept {
    return slot < slots_.size() && (slots_[slot]->map.load(std::memory_order_acquire) & kArmed) != 0;
}

InputMeterReading CaptureBank::meter(std::size_t slot) const noexcept {
    InputMeterReading out;
    if (slot >= slots_.size()) {
        return out;
    }
    const Slot& s = *slots_[slot];
    out.blocks = s.blocks.load(std::memory_order_acquire);
    out.channels = s.meterChannels.load(std::memory_order_relaxed);
    for (int c = 0; c < kMaxChannels; ++c) {
        out.peak[static_cast<std::size_t>(c)] = s.peak[static_cast<std::size_t>(c)].load(std::memory_order_relaxed);
        out.rms[static_cast<std::size_t>(c)] = s.rms[static_cast<std::size_t>(c)].load(std::memory_order_relaxed);
    }
    return out;
}

void CaptureBank::process(const host::AudioBufferView& input, std::int64_t timelinePosition, bool playing) noexcept {
    for (const std::unique_ptr<Slot>& owned : slots_) {
        Slot& slot = *owned;
        const std::uint32_t map = slot.map.load(std::memory_order_acquire);
        if ((map & kArmed) == 0) {
            continue;
        }
        const int port = static_cast<int>((map >> 8) & kPortMask);
        const int channels = static_cast<int>(map & 0xFF);
        if (port + channels > input.channelCount || input.channels == nullptr) {
            continue;  // the open input does not reach this map
        }
        const host::AudioBufferView view{input.channels + port, channels, input.frames};
        for (int c = 0; c < channels; ++c) {
            const float* samples = view.channel(c);
            float peak = 0.0f;
            double sum = 0.0;
            for (int i = 0; i < view.frames; ++i) {
                const float v = samples[i];
                peak = std::max(peak, std::abs(v));
                sum += static_cast<double>(v) * static_cast<double>(v);
            }
            const float rms = view.frames > 0 ? static_cast<float>(std::sqrt(sum / view.frames)) : 0.0f;
            slot.peak[static_cast<std::size_t>(c)].store(peak, std::memory_order_relaxed);
            slot.rms[static_cast<std::size_t>(c)].store(rms, std::memory_order_relaxed);
        }
        slot.meterChannels.store(channels, std::memory_order_relaxed);
        slot.blocks.fetch_add(1, std::memory_order_release);
        slot.recorder.capture(view, timelinePosition, playing);
    }
}

}  // namespace siann::realtime
