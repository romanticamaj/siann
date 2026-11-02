#pragma once

// Playback of a session document through the realtime engine (architecture
// spec, revision 3.1, "Realtime data flow", "Two channels into the audio
// thread" and "Gestures").
//
// compileForPlayback() builds the realtime counterpart of
// engine::compileDocument(): per track a streaming player over a disk stream
// and a track fader, all into the master bus, plus the entity-to-slot map the
// control dispatcher addresses parameters with ("track:<trackId>" -> fader).
// A MeterNode follows each fader and the master bus; their slots go to the
// dispatcher too, which collects the meters from the driver's meterOutbox.
//
// PlaybackEngine owns the graph driver, the control dispatcher, the transport,
// the butler and the disk streams. Its methods run on one non-realtime control thread; the
// audio thread only runs the driver's callback. Fader gestures move the sound
// through the parameter channel; ending one commits exactly one revision on
// the caller's thread.

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "siann/command/history.hpp"
#include "siann/graph/graph.hpp"
#include "siann/host/interfaces.hpp"
#include "siann/model/document.hpp"
#include "siann/realtime/control_dispatcher.hpp"
#include "siann/realtime/disk_stream.hpp"
#include "siann/realtime/graph_driver.hpp"
#include "siann/realtime/transport.hpp"
#include "siann/session/session.hpp"

namespace siann::playback {

struct PlaybackOptions {
    int maxBlockFrames = 512;
    int fadeFrames = 240;
    std::size_t ringFrames = 65'536;
    realtime::Butler::Options butler{};
    // false: the caller drives butler().runOnce() itself (tests).
    bool butlerThread = true;
    // true: start() plays at once from the playhead. false: the transport
    // stays stopped until transport().play().
    bool playOnStart = true;
    realtime::Transport::Options transport{};
};

struct CompiledPlayback {
    std::unique_ptr<graph::PreparedGraph> graph;
    std::vector<std::unique_ptr<realtime::DiskStream>> streams;  // must outlive graph
    std::map<std::string, graph::NodeId> slots;
    // MeterNode per metered entity: trackSlotKey(id) after each fader and
    // masterMeterKey() after the master bus (the graph's output).
    std::map<std::string, graph::NodeId> meterSlots;
};

// Slot key of a track's fader in the dispatcher's map.
std::string trackSlotKey(const std::string& trackId);
// Meter key of the master bus in the dispatcher's meter map.
std::string masterMeterKey();

// Throws engine::EngineError (media_missing, media_hash_mismatch,
// media_mismatch) like engine::loadMedia().
CompiledPlayback compileForPlayback(const model::Document& document, const std::filesystem::path& bundle,
                                    const PlaybackOptions& options);

class PlaybackEngine {
public:
    PlaybackEngine(session::Session& session, PlaybackOptions options);
    ~PlaybackEngine();
    PlaybackEngine(const PlaybackEngine&) = delete;
    PlaybackEngine& operator=(const PlaybackEngine&) = delete;

    // Compiles the session's head document, registers its streams with the
    // butler (prefilling from timeline 0) and publishes the graph. Once.
    void load();

    // Starts the butler thread (unless disabled), then plays the driver from
    // the playhead (unless playOnStart is false) and starts the device.
    void start(host::AudioDevice& device, const host::AudioDeviceConfig& config);
    void stop();

    // Parameter gestures on a track fader: gain, pan or mute (TrackFaderNode
    // parameter ids). Any other id throws std::invalid_argument before a
    // gesture opens, so every open gesture can be ended.
    void beginGesture(const std::string& trackId, std::uint32_t paramId);
    void updateGesture(const std::string& trackId, std::uint32_t paramId, double value, int rampFrames);
    // Commits the gesture's last value as one revision (track.set_gain,
    // track.set_pan or track.set_mute) and sends the committed value to the
    // audio thread. Returns nullptr when the gesture never moved.
    // A command::CommandError propagates and commits nothing; the sound then
    // returns to the document's value.
    const command::Revision* endGesture(const std::string& trackId, std::uint32_t paramId, std::string actor,
                                        std::string time);

    // Control thread: transport and dispatcher ticks, then the driver poll.
    // The poll also answers a node's latency change with a recompile; the
    // recompiled graph keeps every slot and the dispatcher's epoch, so nothing
    // else changes here.
    void tick();

    // Underruns summed over every stream.
    std::uint64_t underruns() const noexcept;

    realtime::GraphDriver& driver() noexcept { return driver_; }
    realtime::Butler& butler() noexcept { return butler_; }
    realtime::ControlDispatcher& dispatcher() noexcept { return dispatcher_; }
    realtime::Transport& transport() noexcept { return transport_; }
    const std::map<std::string, graph::NodeId>& slots() const noexcept { return slots_; }
    const std::map<std::string, graph::NodeId>& meterSlots() const noexcept { return meterSlots_; }
    std::size_t streamCount() const noexcept { return streams_.size(); }
    session::Session& session() noexcept { return session_; }

private:
    session::Session& session_;
    PlaybackOptions options_;
    // Declared before the butler and the driver: both refer to the streams.
    std::vector<std::unique_ptr<realtime::DiskStream>> streams_;
    realtime::Butler butler_;
    realtime::GraphDriver driver_;
    realtime::ControlDispatcher dispatcher_;
    realtime::Transport transport_;
    std::map<std::string, graph::NodeId> slots_;
    std::map<std::string, graph::NodeId> meterSlots_;
    bool loaded_ = false;
};

}  // namespace siann::playback
