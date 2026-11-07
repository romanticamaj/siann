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
//
// Structural edits while playing ("Publishing and retiring graphs", "State
// migration"): update() hands the engine a newer document; tick() compiles
// the latest one when no transition is in flight, reuses every disk stream
// whose track has the same flattened clip list, registers new streams with
// the butler prefilled from the playhead, and publishes the graph once they
// are ready, or after 1 s regardless (their underruns are then counted until
// the butler catches up). A stream is destroyed only after the last graph that
// used it has retired and the butler has released it.

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
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

// The limits on what switching the live graph to an auditioned proposal may
// instantiate (spec, "Proposal audition (A/B)", M3 budget stand-in): bytes of
// new disk-stream buffers and nodes in the compiled graph. Unlimited by
// default. At namespace scope so GCC sees the default member initializers
// when traits are checked inside PlaybackOptions.
struct AuditionBudget {
    std::size_t maxBytes = SIZE_MAX;
    std::size_t maxNodes = SIZE_MAX;
};

// What compiling a document would instantiate against the live graph.
struct AuditionCost {
    std::size_t bytes = 0;       // buffers of the disk streams that cannot be reused
    std::size_t newStreams = 0;  // tracks whose stream cannot be reused
    std::size_t nodes = 0;       // nodes of the compiled graph
};

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
    AuditionBudget auditionBudget{};
    // The clock the driver times each device callback with (GraphDriver::Options::
    // nowNanos); nullptr is the steady clock. Tests and `--fake-callback-nanos`.
    std::int64_t (*callbackClock)() noexcept = nullptr;
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

namespace detail {

// What a track's disk stream renders: equal keys mean the stream can be reused.
struct StreamClipKey {
    std::int64_t timelineStart = 0;
    std::int64_t sourceStart = 0;
    std::int64_t length = 0;
    float gain = 1.0f;
    hash::Digest media{};
    friend bool operator==(const StreamClipKey&, const StreamClipKey&) = default;
};

struct StreamKey {
    int channels = 0;
    std::vector<StreamClipKey> clips;
    friend bool operator==(const StreamKey&, const StreamKey&) = default;
};

struct TrackStream {
    realtime::DiskStream* stream = nullptr;
    StreamKey key;
};

// A compiled graph that waits for its new streams to be prefilled. Defined at
// namespace scope so GCC sees the default member initializers when
// std::optional checks its traits inside PlaybackEngine.
struct PreparedPlayback {
    std::unique_ptr<graph::PreparedGraph> graph;
    std::map<std::string, graph::NodeId> slots;
    std::map<std::string, graph::NodeId> meterSlots;
    std::map<std::string, TrackStream> tracks;    // by track id
    std::vector<realtime::DiskStream*> fresh;     // created by this compile
    std::chrono::steady_clock::time_point since{};
};

struct OwnedStream {
    std::unique_ptr<realtime::DiskStream> stream;
    bool removing = false;  // the butler was asked to drop it
};

}  // namespace detail

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
    // the playhead (unless playOnStart is false) and starts the device, asking
    // it for the session's sample rate (config.sampleRate is replaced). A
    // device that runs at another rate plays through device-side SRC;
    // resampling() says so.
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
    // returns to the document's value. So does AuditionError
    // audition_not_found when the gesture branch was closed (merged or
    // discarded on the session, not through the Auditioner).
    const command::Revision* endGesture(const std::string& trackId, std::uint32_t paramId, std::string actor,
                                        std::string time);

    // Where endGesture commits: main (nothing, the default) or the proposal
    // branch being heard (session.commitOn). The Auditioner sets it.
    void setGestureBranch(std::optional<command::BranchId> branchId) { gestureBranch_ = std::move(branchId); }
    const std::optional<command::BranchId>& gestureBranch() const noexcept { return gestureBranch_; }

    // What compiling the document now would instantiate: the streams of the
    // newest published graph that it could not reuse (two ring slots of
    // ringFrames, rounded up to a power of two, per channel) and its node
    // count. Reads the document only; nothing is opened or allocated for audio.
    AuditionCost estimateCost(const model::Document& document) const;
    const PlaybackOptions& options() const noexcept { return options_; }

    // Control thread: a newer document, normally the session's head after a
    // commit. An edit that only changes track gain, pan or mute goes through
    // the parameter channel; anything else is structural and is compiled by
    // the next tick(). Only the latest document is kept, so rapid edits
    // coalesce into one compile.
    void update(const model::Document& document);

    // Control thread: transport and dispatcher ticks, driver poll
    // (retirements), destruction of released streams, then compile and
    // publish the pending document. The poll also answers a node's latency
    // change with a recompile; the recompiled graph keeps every slot, the
    // dispatcher's epoch and the streams of the graph it came from, so nothing
    // else changes here.
    void tick();

    // Underruns summed over every stream, including destroyed ones.
    std::uint64_t underruns() const noexcept;

    // Latency changes the engine could not compensate (spec, "Latency
    // model"): the count, and the fault while the live graph is misaligned
    // because of one (the node, its new latency and the GraphError code).
    std::uint64_t latencyRecompileFailures() const noexcept { return driver_.latencyRecompileFailures(); }
    const std::optional<realtime::LatencyFault>& latencyFault() const noexcept { return driver_.latencyFault(); }

    // Graphs compiled so far, the one load() publishes included.
    std::size_t compileCount() const noexcept { return compileCount_; }
    // The stream of a track in the most recently published graph, or nullptr.
    const realtime::DiskStream* streamFor(const std::string& trackId) const noexcept;

    // Device-side SRC state of the running (or last started) device.
    const realtime::ResamplingState& resampling() const noexcept { return driver_.resampling(); }

    realtime::GraphDriver& driver() noexcept { return driver_; }
    const realtime::GraphDriver& driver() const noexcept { return driver_; }
    realtime::Butler& butler() noexcept { return butler_; }
    realtime::ControlDispatcher& dispatcher() noexcept { return dispatcher_; }
    realtime::Transport& transport() noexcept { return transport_; }
    const realtime::Transport& transport() const noexcept { return transport_; }
    const std::map<std::string, graph::NodeId>& slots() const noexcept { return slots_; }
    const std::map<std::string, graph::NodeId>& meterSlots() const noexcept { return meterSlots_; }
    // Streams alive: used by a graph, or waiting to be released and destroyed.
    std::size_t streamCount() const noexcept { return streams_.size(); }
    session::Session& session() noexcept { return session_; }

private:
    void compile(const model::Document& document);
    bool preparedReady() const;
    void publishPrepared();
    void retired(std::uint64_t epoch);
    bool inUse(const realtime::DiskStream* stream) const;
    void destroyReleased();

    session::Session& session_;
    PlaybackOptions options_;
    // Declared before the butler and the driver: both refer to the streams,
    // and the driver's retire callback uses everything up to the butler.
    std::map<const realtime::DiskStream*, detail::OwnedStream> streams_;
    std::map<std::uint64_t, std::vector<realtime::DiskStream*>> epochStreams_;
    std::optional<detail::PreparedPlayback> prepared_;
    std::map<std::string, detail::TrackStream> liveTracks_;  // newest published graph
    std::optional<model::Document> latest_;
    std::optional<model::Document> pendingDoc_;
    std::size_t compileCount_ = 0;
    std::uint64_t destroyedUnderruns_ = 0;
    realtime::Butler butler_;
    realtime::GraphDriver driver_;
    realtime::ControlDispatcher dispatcher_;
    realtime::Transport transport_;
    std::map<std::string, graph::NodeId> slots_;
    std::map<std::string, graph::NodeId> meterSlots_;
    bool loaded_ = false;
    std::optional<command::BranchId> gestureBranch_;
};

}  // namespace siann::playback
