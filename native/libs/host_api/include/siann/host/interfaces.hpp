#pragma once

// Host interfaces (architecture spec, "siann-host: two targets, one
// interface"). Pure interfaces with no implementation: siann-host-desktop
// (JUCE) and siann-host-headless implement them and are linked only into
// engine executables. This is the M1 draft; the M0 spike and M2 refine it.
//
// Thread contract: process() runs on the audio thread only and must not
// allocate, lock, log, throw or do I/O. instantiate, setState and editor calls
// run on the main thread. getState runs on the main thread, with processing
// paused where the format requires it.

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
    std::string uid;
    std::string name;
    std::string vendor;
};

struct PluginCapabilities {
    bool sampleAccurateParameters = false;
    bool midiInput = false;
    bool midiOutput = false;
    bool sidechain = false;
    bool variableLatency = false;
    bool editor = false;
};

// A loaded plugin. Message-shaped so an out-of-process worker can implement it.
class PluginInstance {
public:
    virtual ~PluginInstance() = default;
    virtual PluginCapabilities capabilities() const = 0;
    virtual int latencyFrames() const = 0;
    virtual int tailFrames() const = 0;
    // Audio thread only.
    virtual void process(const AudioBufferView& input, const AudioBufferView& output, EventList events) noexcept = 0;
    // Main thread.
    virtual std::vector<std::uint8_t> getState() = 0;
    virtual void setState(const std::vector<std::uint8_t>& state) = 0;
};

class PluginHost {
public:
    virtual ~PluginHost() = default;
    virtual std::vector<PluginDescriptor> scan() = 0;
    // Main thread; asynchronous formats complete before this returns in M1.
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
