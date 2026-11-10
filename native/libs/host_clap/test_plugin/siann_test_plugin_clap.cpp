// siann_test_plugin as a CLAP, hand-written against the SDK's C headers so the host
// is tested without JUCE, in every build. The same known delay as the VST3 and AU
// builds in libs/host_desktop/test_plugin: stereo audio comes out delayed by exactly
// the latency the plugin declares, so a latency report is checked against audio.
//
// Parameters: "latency" (off: 64 frames, on: 512 frames, which takes a restart),
// "gain" (0 to 1, applied per sample at each event's offset), "futureState" (save
// then writes a state version this plugin does not read, which is how a test gets a
// blob the plugin must refuse), "nudgeGain" (moves "gain" to 0.5 from the main
// thread, the way an editor edit reaches a host: request_callback, then an out-event
// through request_flush) and "tail" (state, no latency change). The tail is a
// quarter second with "latency" or "tail" on, none otherwise.
//
// Probes for the host's side of things, none of them state:
// - "holdProcessBlock": every process() stays in flight for restartWatch before it
//   applies its events.
// - "requestRestart": asks for a restart. Deactivate and activate then each take
//   restartWatch, watching for process() meanwhile, and activate reports through
//   "overlapped" and "restarted".
// - "watchRestore": state load does the same, reporting "overlapped" and "restored".
// - "watchSave": state save waits, up to saveWatch, for a process() call to begin,
//   and reports through "savedWhileProcessing" whether one did (with a values rescan,
//   so the host reads it).
// - "watchFlush": each params.flush after the one that turns it on reports itself
//   through "flushed", as an out-event (a block never does).
// - "rescan": on the main thread, moves "gain" to rescannedGain behind the host's
//   back and calls params.rescan.
// - "wrongThread": turns on when clap.thread-check disagrees with what CLAP says of
//   a call, and when the host offers no thread check.
// - "home:<directory>": the name says which directory holds this file, which tells
//   two installs of the plugin apart.
// - "midiFlood": every process() then pushes 3000 CLAP_EVENT_NOTE_ON output events,
//   more than a host's bounded output list takes, before its parameter out-events.
// - "concurrentProcess": the most process() calls this instance was ever inside at
//   once (plain 0 to 4), pushed as an out-event when it grows, so the host reads it.
// - "midiSysex": every process() then pushes one CLAP_EVENT_MIDI_SYSEX output event,
//   sysexMessage (F0 ... F7, more than 8 data bytes, a size JUCE's MidiMessage keeps
//   on the heap), before its parameter out-events.
//
// Parameter ids are neither indices nor sorted, so a host that takes one for the
// other is caught. The environment variable SIANN_TEST_PLUGIN_LAYOUT changes the
// ports of instances created after it is set: "wide" has 32 channels on the main
// ports, "buses" 16 stereo output ports (32 channels in all, each port within the
// host's limit), "sidechain" a second input port and note ports in both directions.
// SIANN_TEST_PLUGIN_BADINFO set makes params.get_info fail for "tail", a plugin
// that counts a parameter it cannot describe.
//
// Creating an instance prints one line to stdout ("siann_test_plugin: loaded"), as
// a chatty third-party plugin would. When SIANN_TEST_PLUGIN_MARKER names a file, the
// entry point (clap_entry.init, the first code of the library a host runs) appends
// the path it was loaded from and a newline to it: the registry tests' proof that a
// library was never opened (m5-plugin-registry).
//
// State blob: magic "SIANNTP1", version u32, gain f32, latency u8, tail u8, little
// endian. process() does not allocate, lock or do I/O.

#include <clap/clap.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>

namespace {

constexpr std::uint32_t shortLatency = 64;
constexpr std::uint32_t longLatency = 512;
constexpr double nudgedGain = 0.5;
constexpr double rescannedGain = 0.125;
constexpr auto restartWatch = std::chrono::milliseconds(20);
constexpr auto saveWatch = std::chrono::seconds(2);
constexpr double longTailSeconds = 0.25;
constexpr std::uint32_t ringFrames = 1024;  // a power of two above longLatency
constexpr std::uint32_t wideChannels = 32;
constexpr std::uint32_t floodNotes = 3000;
// One sysex message, 10 data bytes between F0 and F7 (a non-commercial id, 0x7D).
constexpr std::array<std::uint8_t, 12> sysexMessage{0xF0, 0x7D, 0x53, 0x49, 0x41, 0x4E,
                                                    0x4E, 0x01, 0x02, 0x03, 0x04, 0xF7};
constexpr double maxConcurrent = 4.0;

constexpr char stateMagic[8] = {'S', 'I', 'A', 'N', 'N', 'T', 'P', '1'};
constexpr std::uint32_t stateVersion = 1;
constexpr std::uint32_t futureStateVersion = 2;
constexpr std::size_t stateSize = sizeof(stateMagic) + sizeof(std::uint32_t) + sizeof(float) + 1 + 1;

enum Parameter : std::uint32_t {
    paramLatency,
    paramGain,
    paramFutureState,
    paramNudgeGain,
    paramRequestRestart,
    paramOverlapped,
    paramRestarted,
    paramWatchRestore,
    paramRestored,
    paramHoldProcessBlock,
    paramTail,
    paramRescan,
    paramWrongThread,
    paramHome,
    paramWatchSave,
    paramSavedWhileProcessing,
    paramWatchFlush,
    paramFlushed,
    paramMidiFlood,
    paramConcurrentProcess,
    paramMidiSysex,
    parameterCount,
};

constexpr const char* parameterNames[parameterCount] = {
    "latency",  "gain",   "futureState",      "nudgeGain", "requestRestart", "overlapped",  "restarted",
    "watchRestore", "restored", "holdProcessBlock", "tail",      "rescan",         "wrongThread", "home:",
    "watchSave", "savedWhileProcessing", "watchFlush", "flushed", "midiFlood", "concurrentProcess", "midiSysex",
};

constexpr clap_id idOf(std::uint32_t index) { return 5000 - 7 * index; }

constexpr bool indexOf(clap_id id, std::uint32_t& index) {
    if (id > idOf(0) || (idOf(0) - id) % 7 != 0 || (idOf(0) - id) / 7 >= parameterCount) {
        return false;
    }
    index = (idOf(0) - id) / 7;
    return true;
}

enum class Layout { stereo, wide, buses, sidechain };

constexpr std::uint32_t busesOutputPorts = 16;

std::string homeDirectoryName;

std::string environmentValue(const char* name) {
#if defined(_MSC_VER)
    char* value = nullptr;
    std::size_t size = 0;
    if (_dupenv_s(&value, &size, name) != 0 || value == nullptr) {
        return {};
    }
    std::string result(value);
    std::free(value);
    return result;
#else
    const char* value = std::getenv(name);
    return value == nullptr ? std::string() : std::string(value);
#endif
}

struct TestPlugin {
    clap_plugin_t clap{};
    const clap_host_t* host = nullptr;
    const clap_host_latency_t* hostLatency = nullptr;
    const clap_host_params_t* hostParams = nullptr;
    const clap_host_tail_t* hostTail = nullptr;
    const clap_host_thread_check_t* hostThreads = nullptr;
    Layout layout = Layout::stereo;
    bool badInfo = false;
    double sampleRate = 48'000.0;

    std::array<std::atomic<double>, parameterCount> values{};
    std::atomic<std::uint32_t> delay{shortLatency};
    std::atomic<bool> inProcess{false};
    std::atomic<bool> restarting{false};
    std::atomic<bool> sawOverlap{false};
    std::atomic<bool> nudgeRequested{false};
    std::atomic<bool> rescanRequested{false};
    std::atomic<bool> nudgeOutPending{false};
    std::atomic<std::uint64_t> processCalls{0};
    std::atomic<int> entered{0};
    std::atomic<int> mostEntered{0};

    std::array<std::array<float, ringFrames>, 2> ring{};
    std::uint32_t writeIndex = 0;

    bool on(Parameter parameter) const { return values[parameter].load() >= 0.5; }

    std::uint32_t wantedDelay() const { return on(paramLatency) ? longLatency : shortLatency; }

    void mustBeMainThread() {
        if (hostThreads == nullptr || !hostThreads->is_main_thread(host)) {
            values[paramWrongThread].store(1.0);
        }
    }

    void mustBeAudioThread() {
        if (hostThreads == nullptr || !hostThreads->is_audio_thread(host)) {
            values[paramWrongThread].store(1.0);
        }
    }

    void watchForProcess() {
        const auto end = std::chrono::steady_clock::now() + restartWatch;
        while (std::chrono::steady_clock::now() < end) {
            if (inProcess.load()) {
                sawOverlap.store(true);
            }
        }
    }

    void askForRestart() {
        restarting.store(true);
        host->request_restart(host);
    }

    // In process() at the event's offset, or in flush.
    void apply(const clap_event_header_t& header) {
        if (header.space_id != CLAP_CORE_EVENT_SPACE_ID || header.type != CLAP_EVENT_PARAM_VALUE) {
            return;
        }
        const auto& event = reinterpret_cast<const clap_event_param_value_t&>(header);
        std::uint32_t index = 0;
        if (!indexOf(event.param_id, index)) {
            return;
        }
        values[index].store(event.value);
        const bool turnedOn = event.value >= 0.5;
        switch (index) {
            case paramLatency:
                if (wantedDelay() != delay.load()) {
                    askForRestart();
                }
                break;
            case paramRequestRestart:
                if (turnedOn) {
                    askForRestart();
                }
                break;
            case paramNudgeGain:
                if (turnedOn) {
                    nudgeRequested.store(true);
                    host->request_callback(host);
                }
                break;
            case paramRescan:
                if (turnedOn) {
                    rescanRequested.store(true);
                    host->request_callback(host);
                }
                break;
            case paramTail:
                if (hostTail != nullptr) {
                    hostTail->changed(host);
                }
                break;
            default:
                break;
        }
    }

    void pushPendingOutEvents(const clap_output_events_t* out) {
        if (nudgeOutPending.exchange(false)) {
            pushValue(out, paramGain, nudgedGain);
        }
    }

    // An edit of the plugin's own, which the host must take.
    void pushValue(const clap_output_events_t* out, Parameter parameter, double value) {
        values[parameter].store(value);
        clap_event_param_value_t event{};
        event.header.size = sizeof(event);
        event.header.time = 0;
        event.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
        event.header.type = CLAP_EVENT_PARAM_VALUE;
        event.param_id = idOf(parameter);
        event.note_id = -1;
        event.port_index = -1;
        event.channel = -1;
        event.key = -1;
        event.value = value;
        out->try_push(out, &event.header);
    }

    void render(const clap_process_t& process, std::uint32_t begin, std::uint32_t end) {
        const auto gain = static_cast<float>(values[paramGain].load(std::memory_order_relaxed));
        const std::uint32_t active = delay.load(std::memory_order_relaxed);
        const clap_audio_buffer_t& input = process.audio_inputs[0];
        const clap_audio_buffer_t& output = process.audio_outputs[0];
        const std::uint32_t channels = std::min({input.channel_count, output.channel_count, std::uint32_t{2}});
        constexpr std::uint32_t mask = ringFrames - 1;
        for (std::uint32_t c = 0; c < channels; ++c) {
            auto& line = ring[c];
            for (std::uint32_t i = begin; i < end; ++i) {
                const std::uint32_t write = (writeIndex + i) & mask;
                line[write] = input.data32[c][i];
                output.data32[c][i] = line[(write - active) & mask] * gain;
            }
        }
        for (std::uint32_t c = channels; c < output.channel_count; ++c) {
            std::fill(output.data32[c] + begin, output.data32[c] + end, 0.0f);
        }
        for (std::uint32_t port = 1; port < process.audio_outputs_count; ++port) {
            const clap_audio_buffer_t& extra = process.audio_outputs[port];
            for (std::uint32_t c = 0; c < extra.channel_count; ++c) {
                std::fill(extra.data32[c] + begin, extra.data32[c] + end, 0.0f);
            }
        }
    }
};

TestPlugin& self(const clap_plugin_t* plugin) { return *static_cast<TestPlugin*>(plugin->plugin_data); }

// --- clap.audio-ports

std::uint32_t audioPortCount(const clap_plugin_t* plugin, bool isInput) {
    const Layout layout = self(plugin).layout;
    if (isInput) {
        return layout == Layout::sidechain ? 2 : 1;
    }
    return layout == Layout::buses ? busesOutputPorts : 1;
}

bool audioPortGet(const clap_plugin_t* plugin, std::uint32_t index, bool isInput, clap_audio_port_info_t* info) {
    if (index >= audioPortCount(plugin, isInput)) {
        return false;
    }
    const bool wide = self(plugin).layout == Layout::wide;
    *info = {};
    info->id = index;
    std::snprintf(info->name, sizeof(info->name), "%s %u", isInput ? "In" : "Out", static_cast<unsigned>(index));
    info->flags = index == 0 ? CLAP_AUDIO_PORT_IS_MAIN : 0;
    info->channel_count = wide ? wideChannels : 2;
    info->port_type = wide ? nullptr : CLAP_PORT_STEREO;
    info->in_place_pair = CLAP_INVALID_ID;
    return true;
}

const clap_plugin_audio_ports_t audioPorts = {audioPortCount, audioPortGet};

// --- clap.note-ports

std::uint32_t notePortCount(const clap_plugin_t*, bool) { return 1; }

bool notePortGet(const clap_plugin_t*, std::uint32_t index, bool, clap_note_port_info_t* info) {
    if (index != 0) {
        return false;
    }
    *info = {};
    info->id = 0;
    info->supported_dialects = CLAP_NOTE_DIALECT_MIDI;
    info->preferred_dialect = CLAP_NOTE_DIALECT_MIDI;
    std::snprintf(info->name, sizeof(info->name), "Notes");
    return true;
}

const clap_plugin_note_ports_t notePorts = {notePortCount, notePortGet};

// --- clap.params

std::uint32_t paramsCount(const clap_plugin_t*) { return parameterCount; }

bool paramsGetInfo(const clap_plugin_t* plugin, std::uint32_t index, clap_param_info_t* info) {
    if (index >= parameterCount || (index == paramTail && self(plugin).badInfo)) {
        return false;
    }
    *info = {};
    info->id = idOf(index);
    info->flags = CLAP_PARAM_IS_AUTOMATABLE | (index == paramGain ? 0u : static_cast<std::uint32_t>(CLAP_PARAM_IS_STEPPED));
    std::snprintf(info->name, sizeof(info->name), "%s%s", parameterNames[index],
                  index == paramHome ? homeDirectoryName.c_str() : "");
    info->min_value = 0.0;
    info->max_value = index == paramConcurrentProcess ? maxConcurrent : 1.0;
    info->default_value = index == paramGain ? 1.0 : 0.0;
    return true;
}

bool paramsGetValue(const clap_plugin_t* plugin, clap_id id, double* value) {
    std::uint32_t index = 0;
    if (!indexOf(id, index)) {
        return false;
    }
    *value = self(plugin).values[index].load();
    return true;
}

bool paramsValueToText(const clap_plugin_t*, clap_id, double value, char* text, std::uint32_t capacity) {
    std::snprintf(text, capacity, "%g", value);
    return true;
}

bool paramsTextToValue(const clap_plugin_t*, clap_id, const char* text, double* value) {
    *value = std::atof(text);
    return true;
}

void paramsFlush(const clap_plugin_t* plugin, const clap_input_events_t* in, const clap_output_events_t* out) {
    auto& test = self(plugin);
    test.mustBeAudioThread();
    const bool watching = test.on(paramWatchFlush);
    const std::uint32_t count = in->size(in);
    for (std::uint32_t i = 0; i < count; ++i) {
        test.apply(*in->get(in, i));
    }
    test.pushPendingOutEvents(out);
    if (watching) {
        test.pushValue(out, paramFlushed, 1.0);
    }
}

const clap_plugin_params_t params = {paramsCount,       paramsGetInfo,     paramsGetValue,
                                     paramsValueToText, paramsTextToValue, paramsFlush};

// --- clap.latency, clap.tail

std::uint32_t latencyGet(const clap_plugin_t* plugin) { return self(plugin).delay.load(); }

const clap_plugin_latency_t latency = {latencyGet};

std::uint32_t tailGet(const clap_plugin_t* plugin) {
    const auto& test = self(plugin);
    return test.on(paramLatency) || test.on(paramTail) ? static_cast<std::uint32_t>(longTailSeconds * test.sampleRate) : 0;
}

const clap_plugin_tail_t tail = {tailGet};

// --- clap.state

template <typename T>
void putLittleEndian(std::uint8_t*& at, T value) {
    for (std::size_t i = 0; i < sizeof(T); ++i) {
        *at++ = static_cast<std::uint8_t>((value >> (8 * i)) & 0xff);
    }
}

bool stateSave(const clap_plugin_t* plugin, const clap_ostream_t* stream) {
    auto& test = self(plugin);
    test.mustBeMainThread();
    std::array<std::uint8_t, stateSize> blob{};
    std::memcpy(blob.data(), stateMagic, sizeof(stateMagic));
    std::uint8_t* at = blob.data() + sizeof(stateMagic);
    putLittleEndian<std::uint32_t>(at, test.on(paramFutureState) ? futureStateVersion : stateVersion);
    const auto gain = static_cast<float>(test.values[paramGain].load());
    std::uint32_t gainBits = 0;
    std::memcpy(&gainBits, &gain, sizeof(gainBits));
    putLittleEndian<std::uint32_t>(at, gainBits);
    *at++ = test.on(paramLatency) ? 1 : 0;
    *at++ = test.on(paramTail) ? 1 : 0;
    if (test.on(paramWatchSave)) {
        const std::uint64_t before = test.processCalls.load();
        const auto end = std::chrono::steady_clock::now() + saveWatch;
        while (test.processCalls.load() == before && std::chrono::steady_clock::now() < end) {
        }
        test.values[paramSavedWhileProcessing].store(test.processCalls.load() != before ? 1.0 : 0.0);
        if (test.hostParams != nullptr) {
            test.hostParams->rescan(test.host, CLAP_PARAM_RESCAN_VALUES);  // the host reads it now
        }
    }
    std::size_t written = 0;
    while (written < blob.size()) {
        const auto count = stream->write(stream, blob.data() + written, blob.size() - written);
        if (count <= 0) {
            return false;
        }
        written += static_cast<std::size_t>(count);
    }
    return true;
}

bool stateLoad(const clap_plugin_t* plugin, const clap_istream_t* stream) {
    auto& test = self(plugin);
    test.mustBeMainThread();
    std::array<std::uint8_t, stateSize + 1> blob{};  // one over, to notice a longer blob
    std::size_t size = 0;
    while (size < blob.size()) {
        const auto count = stream->read(stream, blob.data() + size, blob.size() - size);
        if (count < 0) {
            return false;
        }
        if (count == 0) {
            break;
        }
        size += static_cast<std::size_t>(count);
    }
    if (size != stateSize || std::memcmp(blob.data(), stateMagic, sizeof(stateMagic)) != 0) {
        return false;
    }
    const std::uint8_t* at = blob.data() + sizeof(stateMagic);
    std::uint32_t version = 0;
    std::uint32_t gainBits = 0;
    for (std::size_t i = 0; i < 4; ++i) {
        version |= static_cast<std::uint32_t>(at[i]) << (8 * i);
        gainBits |= static_cast<std::uint32_t>(at[4 + i]) << (8 * i);
    }
    if (version != stateVersion) {
        return false;
    }
    float gain = 0.0f;
    std::memcpy(&gain, &gainBits, sizeof(gain));
    test.values[paramGain].store(gain);
    test.values[paramLatency].store(at[8] != 0 ? 1.0 : 0.0);
    test.values[paramTail].store(at[9] != 0 ? 1.0 : 0.0);
    if (test.on(paramWatchRestore)) {
        test.watchForProcess();
        test.values[paramOverlapped].store(test.sawOverlap.load() ? 1.0 : 0.0);
        test.values[paramRestored].store(1.0);
    }
    if (test.wantedDelay() != test.delay.load() && test.hostLatency != nullptr) {
        // Told on the main thread with the plugin active, as plugins do: the host
        // has to restart it for this to take effect.
        test.restarting.store(true);
        test.hostLatency->changed(test.host);
    }
    return true;
}

const clap_plugin_state_t state = {stateSave, stateLoad};

// --- clap_plugin

bool pluginInit(const clap_plugin_t* plugin) {
    auto& test = self(plugin);
    const auto extension = [&](const char* id) { return test.host->get_extension(test.host, id); };
    test.hostLatency = static_cast<const clap_host_latency_t*>(extension(CLAP_EXT_LATENCY));
    test.hostParams = static_cast<const clap_host_params_t*>(extension(CLAP_EXT_PARAMS));
    test.hostTail = static_cast<const clap_host_tail_t*>(extension(CLAP_EXT_TAIL));
    test.hostThreads = static_cast<const clap_host_thread_check_t*>(extension(CLAP_EXT_THREAD_CHECK));
    return true;
}

void pluginDestroy(const clap_plugin_t* plugin) { delete &self(plugin); }

bool pluginActivate(const clap_plugin_t* plugin, double sampleRate, std::uint32_t, std::uint32_t) {
    auto& test = self(plugin);
    test.mustBeMainThread();
    const bool wasRestarting = test.restarting.load();
    if (wasRestarting) {
        test.watchForProcess();
    }
    test.sampleRate = sampleRate;
    for (auto& channel : test.ring) {
        channel.fill(0.0f);
    }
    test.writeIndex = 0;
    const std::uint32_t wanted = test.wantedDelay();
    if (wanted != test.delay.exchange(wanted) && test.hostLatency != nullptr) {
        test.hostLatency->changed(test.host);
    }
    if (wasRestarting) {
        test.restarting.store(false);
        test.values[paramOverlapped].store(test.sawOverlap.load() ? 1.0 : 0.0);
        test.values[paramRestarted].store(1.0);
    }
    return true;
}

void pluginDeactivate(const clap_plugin_t* plugin) {
    auto& test = self(plugin);
    test.mustBeMainThread();
    if (test.restarting.load()) {
        test.watchForProcess();
    }
}

bool pluginStartProcessing(const clap_plugin_t* plugin) {
    self(plugin).mustBeAudioThread();
    return true;
}

void pluginStopProcessing(const clap_plugin_t* plugin) { self(plugin).mustBeAudioThread(); }

void pluginReset(const clap_plugin_t* plugin) {
    auto& test = self(plugin);
    test.mustBeAudioThread();
    for (auto& channel : test.ring) {
        channel.fill(0.0f);
    }
}

clap_process_status pluginProcess(const clap_plugin_t* plugin, const clap_process_t* process) {
    auto& test = self(plugin);
    const int inside = test.entered.fetch_add(1) + 1;
    int most = test.mostEntered.load();
    bool grew = false;
    while (inside > most) {
        if (test.mostEntered.compare_exchange_weak(most, inside)) {
            grew = true;
            break;
        }
    }
    test.inProcess.store(true);
    test.processCalls.fetch_add(1);
    test.mustBeAudioThread();
    if (test.on(paramHoldProcessBlock)) {
        // A slow plugin: the block stays in flight for restartWatch, its events not
        // applied yet, so a host that must wait for it has something to wait for.
        const auto end = std::chrono::steady_clock::now() + restartWatch;
        while (std::chrono::steady_clock::now() < end) {
        }
    }
    const std::uint32_t frames = process->frames_count;
    const clap_input_events_t* in = process->in_events;
    const std::uint32_t count = in->size(in);
    std::uint32_t next = 0;
    std::uint32_t cursor = 0;
    while (cursor < frames) {
        while (next < count && in->get(in, next)->time <= cursor) {
            test.apply(*in->get(in, next));
            ++next;
        }
        const std::uint32_t end = next < count ? std::min(frames, in->get(in, next)->time) : frames;
        test.render(*process, cursor, end);
        cursor = end;
    }
    for (; next < count; ++next) {
        test.apply(*in->get(in, next));
    }
    test.writeIndex = (test.writeIndex + frames) & (ringFrames - 1);
    if (test.on(paramMidiFlood)) {
        for (std::uint32_t i = 0; i < floodNotes; ++i) {
            clap_event_note_t note{};
            note.header.size = sizeof(note);
            note.header.time = frames == 0 ? 0 : i % frames;
            note.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
            note.header.type = CLAP_EVENT_NOTE_ON;
            note.note_id = -1;
            note.port_index = 0;
            note.channel = 0;
            note.key = static_cast<std::int16_t>(i % 128);
            note.velocity = 1.0;
            process->out_events->try_push(process->out_events, &note.header);
        }
    }
    if (test.on(paramMidiSysex)) {
        clap_event_midi_sysex_t sysex{};
        sysex.header.size = sizeof(sysex);
        sysex.header.time = 0;
        sysex.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
        sysex.header.type = CLAP_EVENT_MIDI_SYSEX;
        sysex.port_index = 0;
        sysex.buffer = sysexMessage.data();
        sysex.size = static_cast<std::uint32_t>(sysexMessage.size());
        process->out_events->try_push(process->out_events, &sysex.header);
    }
    test.pushPendingOutEvents(process->out_events);
    if (grew) {
        test.pushValue(process->out_events, paramConcurrentProcess, static_cast<double>(inside));
    }
    test.inProcess.store(false);
    test.entered.fetch_sub(1);
    return CLAP_PROCESS_CONTINUE;
}

const void* pluginGetExtension(const clap_plugin_t* plugin, const char* id) {
    if (std::strcmp(id, CLAP_EXT_AUDIO_PORTS) == 0) {
        return &audioPorts;
    }
    if (std::strcmp(id, CLAP_EXT_NOTE_PORTS) == 0) {
        return self(plugin).layout == Layout::sidechain ? &notePorts : nullptr;
    }
    if (std::strcmp(id, CLAP_EXT_PARAMS) == 0) {
        return &params;
    }
    if (std::strcmp(id, CLAP_EXT_LATENCY) == 0) {
        return &latency;
    }
    if (std::strcmp(id, CLAP_EXT_TAIL) == 0) {
        return &tail;
    }
    if (std::strcmp(id, CLAP_EXT_STATE) == 0) {
        return &state;
    }
    return nullptr;
}

void pluginOnMainThread(const clap_plugin_t* plugin) {
    auto& test = self(plugin);
    test.mustBeMainThread();
    if (test.nudgeRequested.exchange(false)) {
        test.nudgeOutPending.store(true);
        test.hostParams->request_flush(test.host);
    }
    if (test.rescanRequested.exchange(false)) {
        test.values[paramGain].store(rescannedGain);
        test.hostParams->rescan(test.host, CLAP_PARAM_RESCAN_VALUES);
    }
}

// --- the factory and the entry

const char* const features[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, nullptr};

const clap_plugin_descriptor_t descriptor = {
    CLAP_VERSION_INIT, "org.siann.test-plugin", "SIANN Test Plugin", "SIANN", "", "", "", "1.0.0", "A known delay",
    features,
};

std::uint32_t factoryCount(const clap_plugin_factory_t*) { return 1; }

const clap_plugin_descriptor_t* factoryDescriptor(const clap_plugin_factory_t*, std::uint32_t index) {
    return index == 0 ? &descriptor : nullptr;
}

const clap_plugin_t* factoryCreate(const clap_plugin_factory_t*, const clap_host_t* host, const char* id) {
    if (std::strcmp(id, descriptor.id) != 0) {
        return nullptr;
    }
    auto* test = new TestPlugin;
    test->host = host;
    const std::string layout = environmentValue("SIANN_TEST_PLUGIN_LAYOUT");
    test->layout = layout == "wide"        ? Layout::wide
                   : layout == "buses"     ? Layout::buses
                   : layout == "sidechain" ? Layout::sidechain
                                           : Layout::stereo;
    test->badInfo = !environmentValue("SIANN_TEST_PLUGIN_BADINFO").empty();
    test->values[paramGain].store(1.0);
    test->clap.desc = &descriptor;
    test->clap.plugin_data = test;
    test->clap.init = pluginInit;
    test->clap.destroy = pluginDestroy;
    test->clap.activate = pluginActivate;
    test->clap.deactivate = pluginDeactivate;
    test->clap.start_processing = pluginStartProcessing;
    test->clap.stop_processing = pluginStopProcessing;
    test->clap.reset = pluginReset;
    test->clap.process = pluginProcess;
    test->clap.get_extension = pluginGetExtension;
    test->clap.on_main_thread = pluginOnMainThread;
    // What a chatty plugin does: a host must keep its launcher handshake away from this.
    std::fputs("siann_test_plugin: loaded\n", stdout);
    std::fflush(stdout);
    return &test->clap;
}

const clap_plugin_factory_t factory = {factoryCount, factoryDescriptor, factoryCreate};

bool entryInit(const char* path) {
    homeDirectoryName = std::filesystem::path(path).parent_path().filename().string();
    if (const std::string marker = environmentValue("SIANN_TEST_PLUGIN_MARKER"); !marker.empty()) {
        std::FILE* file = nullptr;
#if defined(_MSC_VER)
        if (fopen_s(&file, marker.c_str(), "ab") != 0) {
            file = nullptr;
        }
#else
        file = std::fopen(marker.c_str(), "ab");
#endif
        if (file != nullptr) {
            std::fputs(path, file);
            std::fputs("\n", file);
            std::fclose(file);
        }
    }
    return true;
}

void entryDeinit() {}

const void* entryGetFactory(const char* id) {
    return std::strcmp(id, CLAP_PLUGIN_FACTORY_ID) == 0 ? &factory : nullptr;
}

}  // namespace

// clap/entry.h declares it exported, extern and with C linkage; this inherits all three.
const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, entryInit, entryDeinit, entryGetFactory};
