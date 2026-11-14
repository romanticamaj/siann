#pragma once

// The protocol server's way to recording (m5b-engine-record; architecture spec,
// "Recording", Protocol v0 item 28; docs/schemas/protocol-engine-v0.md). The
// engine host implements it beside TransportPort and hands it to the server in
// ServerOptions::recordPort. Every call runs on the command thread. Refusals are
// TransportPortError (no_device, no_input, not_found, nothing_armed,
// invalid_state) or session::SessionError (take_not_found, take_has_no_audio),
// whose codes the server passes through.

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "siann/command/history.hpp"
#include "siann/hash/json.hpp"
#include "siann/protocol/transport_port.hpp"

namespace siann::protocol {

// One take of the current recording, or of the last one once it ended.
struct RecordTakeState {
    std::string takeId;
    std::string trackId;
    // Where the take lands: its first frame's position minus the record offset;
    // empty until that frame is captured.
    std::optional<std::int64_t> startFrame{};
    std::int64_t durableFrames = 0;
    // Set once the recording ended: stop, overflow, disk or device.
    std::optional<std::string> endedBy{};
    std::uint64_t overflows = 0;

    friend bool operator==(const RecordTakeState&, const RecordTakeState&) = default;
};

// record.arm's result and record.changed's payload.
struct RecordState {
    bool recording = false;
    std::vector<std::string> armed{};  // track ids, in id order
    std::vector<RecordTakeState> takes{};

    friend bool operator==(const RecordState&, const RecordState&) = default;
};

// A take in media/recording/ that is not being recorded (left by a crash, or by
// a commit that failed): what session.sync and the auth reply list.
struct PendingTake {
    std::string takeId;
    std::string trackId;
    int channels = 1;
    std::int64_t sampleRate = 0;
    std::optional<std::int64_t> startFrame{};
    std::optional<std::string> endedBy{};
    std::optional<std::uint64_t> overflows{};
};

// record.recover_take: the revision that committed the take (accepted), or
// trashed (rejected).
struct RecoverResult {
    const command::Revision* revision = nullptr;
    bool trashed = false;
};

class RecordPort {
public:
    virtual ~RecordPort() = default;

    // record.arm: engine state, never a revision.
    virtual RecordState arm(const std::string& trackId, bool armed) = 0;
    // transport.record: true begins a take per armed track and plays; false ends
    // the recording and commits it as one revision.
    virtual TransportState record(bool enabled) = 0;
    virtual RecordState recordState() const = 0;
    virtual std::vector<PendingTake> pendingTakes() const = 0;
    // record.recover_take, committed with `actor` and `time` when accepted.
    virtual RecoverResult recoverTake(const std::string& takeId, bool accept, std::string actor, std::string time) = 0;
};

// The record state as JSON: {recording, armed, takes: [{takeId, trackId,
// startFrame, durableFrames, endedBy?, overflows?}]}, 64-bit values as decimal
// strings and startFrame null until known.
json::Object recordStateJson(const RecordState& state);

// The pending takes as JSON: [{takeId, trackId, channels, sampleRate,
// startFrame, endedBy?, overflows?}].
json::Value pendingTakesJson(const std::vector<PendingTake>& takes);

}  // namespace siann::protocol
