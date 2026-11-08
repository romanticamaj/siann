#pragma once

// Host interfaces (architecture spec, "siann-host: two targets, one
// interface"). Pure interfaces with no implementation: siann-host-desktop
// (JUCE) and siann-host-headless implement them and are linked only into
// engine executables. The M1 draft, refined by the M0 plugin-hosting spike; M2
// and M4 extend it. The one body is setBlocksComing's.
//
// kMaxBlockOutputEvents is the per-block output limit midiOutputOverflows counts against.
//
// Thread contract, as the spec states it: process() runs on the audio thread
// only and must not allocate, lock, log, throw or do I/O, with one exception the
// spec records: the locks a format's hosting wrapper takes around the plugin (see
// "Locks inside a hosted plugin's processBlock"). scan, instantiate and all of
// PluginControl run on the main thread, getState with processing paused where the
// format requires it (VST3, AU and CLAP do not: a CLAP getState with a value still
// on its way waits for a block to deliver it while blocks are coming, see
// setBlocksComing, and pauses to flush it only when none is). capabilities,
// latencyFrames and tailFrames may be read from any thread and never enter the
// plugin. Plugin events arrive on any thread, see
// setEventSink. Control-only calls are a separate interface from process() (spec,
// "siann-host-api"): PluginControl, which the audio thread has no use for.

#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "siann/host/buffer.hpp"

namespace siann::host {

struct AudioDeviceConfig {
    std::string deviceId;
    std::int64_t sampleRate = 48'000;
    int bufferFrames = 256;
    int inputChannels = 0;
    int outputChannels = 2;
};

struct AudioDeviceStatus {
    std::int64_t sampleRate = 0;
    int bufferFrames = 0;
    int inputLatencyFrames = 0;
    int outputLatencyFrames = 0;
};

// A device that cannot be had.
class DeviceError : public std::runtime_error {
public:
    DeviceError(std::string code, const std::string& message)
        : std::runtime_error(message), code_(std::move(code)) {}

    // One of: no_device, device_open_failed, no_audio_backend.
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

// Called on the audio thread for each device block.
using AudioCallback = std::function<void(const AudioBufferView& input, const AudioBufferView& output)>;

class AudioDevice {
public:
    virtual ~AudioDevice() = default;
    virtual AudioDeviceStatus open(const AudioDeviceConfig& config) = 0;
    virtual void start(AudioCallback callback) = 0;
    // Called (off the audio thread, after the last callback) when the device
    // stops on its own; lost is true when the device disappeared.
    virtual void setOnStopped(std::function<void(bool lost)> handler) = 0;
    // Returns only after the callback has exited and will not run again.
    virtual void stop() = 0;
    virtual void close() = 0;
};

struct MidiInputEvent {
    std::int64_t hostTimeNanos = 0;
    std::uint8_t bytes[3] = {0, 0, 0};
    int length = 0;
};

class MidiDevice {
public:
    virtual ~MidiDevice() = default;
    virtual void open(const std::string& deviceId, std::function<void(const MidiInputEvent&)> onInput) = 0;
    virtual void close() = 0;
};

// Steinberg's limit on events in one block, which SIANN applies to every format.
inline constexpr int kMaxBlockOutputEvents = 2048;

struct PluginDescriptor {
    std::string format;  // "clap", "vst3", "au", "lv2"
    std::string uid;     // the same wherever the plugin is installed; empty until probed
    std::string name;
    std::string vendor;  // empty until probed
    std::string path;    // bundle path, or the system's identifier for an AU
    std::string version;  // empty until probed
    bool hasEditor = false;  // false until probed
};

struct PluginCapabilities {
    bool sampleAccurateParameters = false;
    bool midiInput = false;
    bool midiOutput = false;
    bool sidechain = false;
    bool variableLatency = false;
    bool editor = false;
};

struct PluginParameterInfo {
    std::string id;
    std::string name;
    double defaultValue = 0.0;  // normalized, 0 to 1
    bool automatable = true;
};

// Plain data, so it fits the bounded queue behind `pluginEventAny`.
struct PluginEvent {
    enum class Kind {
        latencyChanged,    // latencyFrames holds the new latency
        parameterEdited,   // parameterIndex and value (normalized) hold the edit
        restartRequested,  // parameters or programs changed: read them again
        failed,            // the plugin threw: the instance passes input through until replaced
    };
    Kind kind = Kind::latencyChanged;
    int parameterIndex = -1;
    double value = 0.0;
    int latencyFrames = 0;
};

// The window an editor belongs to, as the platform's handle (an HWND on
// Windows). 0 for none. macOS cannot own windows across processes and ignores it.
struct EditorOwner {
    std::uintptr_t nativeWindow = 0;
};

// The main-thread side of a loaded plugin: state, parameters, editor and events.
// Message-shaped so an out-of-process worker can implement it: nothing here points
// into the plugin.
class PluginControl {
public:
    virtual ~PluginControl() = default;
    virtual std::vector<std::uint8_t> getState() = 0;
    // Throws, with parameters unchanged, on a blob that getState of this plugin
    // did not produce (wrong format version, wrong plugin, truncated). A plugin
    // that refuses its own payload keeps its parameters: VST3 and AU report nothing
    // of it, CLAP does and the host throws bad_state.
    // During playback, a process() call in flight finishes first and later ones pass
    // their input through until this returns, so no value set before it lands after
    // it. process() does not wait for this; this waits for the block in flight.
    // A load that throws leaves the instance failed, parameters unknown.
    virtual void setState(const std::vector<std::uint8_t>& state) = 0;
    // Values are normalized, 0 to 1. The plugin's processor sees a new value by its
    // next process() call at the latest; getState may miss a value until then.
    virtual std::vector<PluginParameterInfo> parameters() const = 0;
    virtual double getParameter(int index) const = 0;
    virtual void setParameter(int index, double value) = 0;
    // Opening an open editor brings it forward and applies owner.
    virtual void openEditor(EditorOwner owner) = 0;
    virtual void closeEditor() = 0;
    virtual bool editorOpen() const = 0;
    // The editor's top-level native window (HWND, NSView, X11 window); 0 when
    // closed.
    virtual std::uintptr_t editorNativeHandle() const = 0;
    // The sink runs on whichever thread the plugin reports from, the audio thread
    // included, so it must not block or allocate: it feeds `pluginEventAny`. The
    // instance adds no wait of its own around the sink; a report from the audio
    // thread still passes the hosting wrapper's listener lock, see the spec.
    virtual void setEventSink(std::function<void(const PluginEvent&)> sink) = 0;
    // Main thread, from the owner's tick: reads again what a report from another
    // thread only marked stale (the tail, for JUCE's formats), so no listener path
    // allocates or posts a message. Formats that read on the reporting thread do
    // nothing.
    virtual void pollStale() = 0;
};

// A loaded plugin as the audio thread sees it. Message-shaped, like PluginControl.
class PluginInstance {
public:
    // Main thread, after the last process() call. Closes an open editor.
    virtual ~PluginInstance() = default;
    // Any thread.
    virtual PluginCapabilities capabilities() const = 0;
    virtual int latencyFrames() const = 0;
    // The value from load, the last setState or the last change the plugin reported.
    virtual int tailFrames() const = 0;
    // The audio thread, or the offline render thread during bounce and export;
    // never both at once (the graph moves between the drivers, spec "Realtime
    // data flow"). CLAP delivers `events` at their offsets; JUCE's formats discard them.
    virtual void process(const AudioBufferView& input, const AudioBufferView& output, EventList events) noexcept = 0;
    // Main thread, from the driver that calls process(): true when its callback
    // source starts, false once it has stopped. A format that waits for a block to
    // deliver a value (CLAP) waits while this is true and pauses once it is false;
    // told nothing, it guesses from the last block. The one method with a body:
    // formats that never wait for a block ignore it.
    virtual void setBlocksComing(bool /*coming*/) {}
    // Any thread. Blocks whose MIDI or note output exceeded what the instance takes
    // in one block (2048 events, Steinberg's limit, for every format); the events
    // past it are lost. Counted once per block. Until MIDI tracks exist (M6b) the
    // graph drops the rest of the output too.
    virtual std::uint64_t midiOutputOverflows() const noexcept = 0;
    // Main thread. Lives as long as the instance.
    virtual PluginControl& control() = 0;
};

class PluginHost {
public:
    virtual ~PluginHost() = default;
    // Main thread. What the format's default locations hold, without running any
    // plugin code: format, path and name only.
    virtual std::vector<PluginDescriptor> scan() = 0;
    // Main thread. Probes one bundle, which may hold several plugins. This loads
    // it and opens an instance, so a plugin that crashes here crashes the process
    // until plugins run in worker processes.
    virtual std::vector<PluginDescriptor> scanPath(const std::string& path) = 0;
    // Main thread; asynchronous formats complete before this returns. Takes a
    // descriptor from scanPath, or one from scan(), whose path it probes first.
    // The path decides which install loads; the uid is the same at all of them.
    virtual std::unique_ptr<PluginInstance> instantiate(const PluginDescriptor& descriptor, std::int64_t sampleRate,
                                                        int maxBlockFrames) = 0;
};

struct MediaInfo {
    int channels = 0;
    std::int64_t sampleRate = 0;
    std::int64_t frames = 0;
};

// Streaming media access for the butler thread (M2). M1 decodes whole files.
class MediaReader {
public:
    virtual ~MediaReader() = default;
    virtual MediaInfo info() const = 0;
    // Reads planar frames starting at a frame position; returns frames read.
    virtual std::int64_t read(std::int64_t position, const AudioBufferView& destination) = 0;
};

}  // namespace siann::host
