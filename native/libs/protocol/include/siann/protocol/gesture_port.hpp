#pragma once

// The protocol server's way to the fader gestures of the playback engine
// (architecture spec, "Gestures", Protocol v0 item 24;
// docs/schemas/protocol-gestures-v0.md). siann-protocol does not link the
// playback engine; the engine host implements this interface over
// playback::PlaybackEngine and hands it to the server in ServerOptions, as it
// does TransportPort. Every call runs on the command thread.
//
// The server owns the leases (which connection holds a target, and until when);
// the port only moves the sound and commits.

#include <stdexcept>
#include <string>
#include <utility>

#include "siann/command/history.hpp"

namespace siann::protocol {

// A track fader parameter, {ref: "track:<id>", param}; the master gain,
// {ref: "master:master", param: "gain"} (m5b-engine-master), which always exists
// as a target: its start value is 0 while the master entity is absent; a bus
// fader's gain, {ref: "bus:<id>", param: "gain"}, or a send's level,
// {ref: "send:<id>", param: "level"} (m5b-engine-buses-sends).
struct GestureTarget {
    enum class Kind { track, master, bus, send };

    Kind kind = Kind::track;
    std::string id;     // the track, bus or send id; empty for the master
    std::string param;  // "gain", "pan" or "mute" on a track; "gain" on the master or a bus; "level" on a send

    static GestureTarget track(std::string trackId, std::string trackParam) {
        return GestureTarget{Kind::track, std::move(trackId), std::move(trackParam)};
    }
    static GestureTarget masterGain() { return GestureTarget{Kind::master, std::string(), "gain"}; }
    static GestureTarget busGain(std::string busId) { return GestureTarget{Kind::bus, std::move(busId), "gain"}; }
    static GestureTarget sendLevel(std::string sendId) {
        return GestureTarget{Kind::send, std::move(sendId), "level"};
    }
    bool isMaster() const noexcept { return kind == Kind::master; }
    std::string ref() const {
        switch (kind) {
            case Kind::master: return "master:master";
            case Kind::bus: return "bus:" + id;
            case Kind::send: return "send:" + id;
            case Kind::track: break;
        }
        return "track:" + id;
    }
    friend bool operator==(const GestureTarget&, const GestureTarget&) = default;
};

// What ending a gesture did: the value it started from, the value it committed
// (the start value when it never moved), and the revision, or nullptr when the
// gesture never moved and nothing was committed. The revision lives in the
// session's history.
struct GestureEnd {
    double startValue = 0.0;
    double value = 0.0;
    const command::Revision* revision = nullptr;
};

// Thrown by a port. Codes: not_found (no such track, bus or send; never for the master),
// audition_not_found, or whatever the port cannot do. A command::CommandError
// from the commit (invalid_gain, invalid_pan, invalid_mute) passes through
// unchanged.
class GesturePortError : public std::runtime_error {
public:
    GesturePortError(std::string code, const std::string& message)
        : std::runtime_error(message), code_(std::move(code)) {}

    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

class GesturePort {
public:
    virtual ~GesturePort() = default;

    // Opens the gesture and returns the head document's value of the parameter.
    virtual double begin(const GestureTarget& target) = 0;
    // Moves the sound to `value`; the gesture's last accepted value.
    virtual void update(const GestureTarget& target, double value) = 0;
    // Commits the last accepted value as one revision (with `actor` and `time`:
    // a track.set_*, master.set_gain, bus.set_gain or send.set_level), or nothing when the
    // gesture never moved. The gesture is closed afterwards
    // also when the commit throws; the sound then returns to the document's value.
    virtual GestureEnd end(const GestureTarget& target, std::string actor, std::string time) = 0;
    // Closes the gesture without a commit; the sound returns to the document's value.
    virtual void cancel(const GestureTarget& target) = 0;
};

}  // namespace siann::protocol
