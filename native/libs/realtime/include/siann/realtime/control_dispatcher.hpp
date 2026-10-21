#pragma once

// The control dispatcher (revision 3.1, "Two channels into the audio
// thread"): the only producer of the driver's paramInbox. It maps entity
// parameters to graph slots for the published epoch, keeps the overlay of
// values held by open gestures, and re-sends that overlay after each graph
// publication so a held fader survives a recompile.
//
// Producer methods may be called from any non-realtime thread; they never
// wait for queue space, because pending values coalesce per parameter
// (latest wins). tick() runs on the dispatcher's own thread.

#include <cstdint>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

#include "siann/graph/graph.hpp"
#include "siann/realtime/graph_driver.hpp"

namespace siann::realtime {

struct ParamKey {
    std::string entity;  // for example "track:trk_drums"
    std::uint32_t paramId = 0;
    friend auto operator<=>(const ParamKey&, const ParamKey&) = default;
};

class ControlDispatcher {
public:
    explicit ControlDispatcher(GraphDriver& driver) : driver_(driver) {}

    // Any non-realtime thread.
    void setParameter(const ParamKey& key, double value, int rampFrames);
    void beginGesture(const ParamKey& key);
    void updateGesture(const ParamKey& key, double value, int rampFrames);
    // Ends the gesture and returns the last value, for the command layer to
    // commit as one revision; nullopt if no gesture was open or it never moved.
    std::optional<double> endGesture(const ParamKey& key);

    // The command side calls this after publishing a graph, with the slot of
    // every addressable entity in that graph.
    void graphPublished(std::uint64_t epoch, std::map<std::string, graph::NodeId> slots);

    // Dispatcher thread: pushes pending changes to the driver. Changes the
    // driver cannot take yet stay pending. Returns how many were pushed.
    std::size_t tick();

    std::size_t pendingCount() const;
    bool gestureOpen(const ParamKey& key) const;

private:
    struct Pending {
        double value = 0.0;
        int rampFrames = 0;
    };
    struct Gesture {
        std::optional<double> value;
    };

    GraphDriver& driver_;
    mutable std::mutex mutex_;
    std::uint64_t epoch_ = 0;
    std::map<std::string, graph::NodeId> slots_;
    std::map<ParamKey, Pending> pending_;
    std::map<ParamKey, Gesture> gestures_;
};

}  // namespace siann::realtime
