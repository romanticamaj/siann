#pragma once

// Host interfaces (architecture spec, "siann-host: two targets, one
// interface"). Pure interfaces with no implementation: siann-host-desktop
// (JUCE) and siann-host-headless implement them and are linked only into
// engine executables. The M1 draft, refined by the M0 plugin-hosting spike; M2
// and M4 extend it.
//
// Thread contract, as the spec states it: process() runs on the audio thread
// only and must not allocate, lock, log, throw or do I/O. scan, instantiate,
// setState, parameter and editor calls run on the main thread. getState runs on
// the main thread, with processing paused where the format requires it (VST3
// and AU do not). capabilities, latencyFrames and tailFrames may be read from
// any thread. Plugin events arrive on any thread, see setEventSink.

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
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

// A loaded plugin. Message-shaped so an out-of-process worker can implement it:
// nothing here points into the plugin.
class PluginInstance {
public:
    // Main thread, after the last process() call. Closes an open editor.
    virtual ~PluginInstance() = default;
    // Any thread.
    virtual PluginCapabilities capabilities() const = 0;
    virtual int latencyFrames() const = 0;
    virtual int tailFrames() const = 0;
    // Audio thread only.
    virtual void process(const AudioBufferView& input, const AudioBufferView& output, EventList events) noexcept = 0;
    // Main thread.
    virtual std::vector<std::uint8_t> getState() = 0;
    // Throws, with parameters unchanged, on a blob that getState of this plugin
    // did not produce (wrong format version, wrong plugin, truncated). What a
    // plugin does with its own payload stays between it and the blob: a plugin
    // that refuses it keeps its parameters, and no format reports that refusal.
    virtual void setState(const std::vector<std::uint8_t>& state) = 0;
    // Main thread. Values are normalized, 0 to 1. The plugin's processor sees a
    // new value by its next process() call at the latest.
    virtual std::vector<PluginParameterInfo> parameters() const = 0;
    virtual double getParameter(int index) const = 0;
    virtual void setParameter(int index, double value) = 0;
    // Main thread. Opening an open editor brings it forward and applies owner.
    virtual void openEditor(EditorOwner owner) = 0;
    virtual void closeEditor() = 0;
    virtual bool editorOpen() const = 0;
    // The editor's top-level native window (HWND, NSView, X11 window); 0 when
    // closed.
    virtual std::uintptr_t editorNativeHandle() const = 0;
    // Main thread. The sink runs on whichever thread the plugin reports from,
    // the audio thread included, so it must not block or allocate: it feeds
    // `pluginEventAny`. The instance never blocks on the sink's behalf.
    virtual void setEventSink(std::function<void(const PluginEvent&)> sink) = 0;
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
