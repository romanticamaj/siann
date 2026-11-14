#pragma once

// A transport port whose device runs at a chosen rate, or has no device
// (m5b-engine-project-media: session.create takes the device's rate; the import
// tests send transport.play while a job converts). Command thread only, except
// `plays`, which the test reads after the answer arrived.

#include <atomic>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "siann/protocol/transport_port.hpp"

namespace siann::protocol::testing {

class RatePort final : public TransportPort {
public:
    explicit RatePort(std::optional<std::int64_t> rate) : deviceRate(rate) {}

    TransportState play() override {
        ++plays;
        playing = true;
        return state();
    }
    TransportState stop() override {
        playing = false;
        return state();
    }
    TransportState locate(std::int64_t frames) override {
        position = frames;
        return state();
    }
    TransportState setCycle(bool) override { return state(); }
    TransportState setClick(bool, std::optional<std::int32_t>) override { return state(); }
    EngineStatus status() const override {
        EngineStatus out;
        if (deviceRate) {
            out.device = DeviceInfo{"fake", *deviceRate, 256, 0, 0};
        } else {
            out.deviceError = DeviceProblem{"no_device", "no device in this test"};
        }
        out.playing = playing;
        return out;
    }
    std::vector<DeviceDescription> devices() const override { return {}; }
    DeviceInfo selectDevice(const std::string&) override { throw TransportPortError("not_found", "no devices"); }

    std::optional<std::int64_t> deviceRate;
    std::atomic<int> plays{0};
    bool playing = false;
    std::int64_t position = 0;

private:
    TransportState state() const { return TransportState{playing, position, false, {}}; }
};

}  // namespace siann::protocol::testing
