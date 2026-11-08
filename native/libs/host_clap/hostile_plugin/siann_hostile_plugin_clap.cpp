// siann_hostile_plugin: a CLAP that breaks the rules on purpose, so the hosting tests
// can check what the host does about each (architecture spec, "siann-host: two
// targets, one interface", Hostile test plugin). Hand-written against the SDK's C
// headers like siann_test_plugin, and like it never installed.
//
// A stereo pass-through with latency 0 and tail 0. Every behaviour is a stepped
// parameter that is off by default, so a default instance is harmless:
// - "allocate": process() allocates and frees on every block.
// - "throwProcess", "throwActivate", "throwLoad", "throwSave", "throwMainThread": a
//   std::runtime_error out of process(), activate, state.load, state.save or
//   on_main_thread. Turning "throwMainThread" on asks for a main-thread callback.
// - "latencyFlap": process() calls latency.changed on every block, and each activate
//   alternates the latency between 64 and 128 frames.
// - "sleep": process() sleeps 50 ms.
// - "callbacksAudio": from process(), params.rescan(VALUES), tail.changed,
//   latency.changed, params.request_flush, request_restart, request_callback and
//   state.mark_dirty.
// - "callbacksMain": from params.get_info, params.get_value, activate and state.load,
//   params.rescan(ALL) and request_restart.
// - "crash": std::abort() when it turns on, at its event in process() or in
//   params.flush, after _set_abort_behavior on MSVC so no dialog appears.
// "level" is a continuous parameter the plugin stores and never uses.
//
// Read-only probes, for the host's side of things:
// - "getValueOnAudioThread": turns on when params.get_value runs on an audio thread
//   that is not the main thread (clap.thread-check).
// - "reentered": turns on when params.get_info or params.get_value is entered while
//   one of them is in flight on the same thread.
// - "activations": how many times activate ran, out of 1e6.
//
// Parameter ids are neither indices nor sorted, as in siann_test_plugin. The
// environment variable SIANN_HOSTILE_PLUGIN_THROW_ACTIVATE set makes the first
// activate of instances created after it throw, which is how instantiate meets it.
//
// State blob: magic "SIANNHP1", version u32, little endian. state.load ignores bytes
// after those and never reads "crash"; state.save never writes it.

#include <clap/clap.h>

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

constexpr std::uint32_t shortFlapLatency = 64;
constexpr std::uint32_t longFlapLatency = 128;
constexpr auto sleepPerBlock = std::chrono::milliseconds(50);
constexpr double maxActivations = 1e6;
constexpr std::size_t allocationBytes = 256;

constexpr char stateMagic[8] = {'S', 'I', 'A', 'N', 'N', 'H', 'P', '1'};
constexpr std::uint32_t stateVersion = 1;
constexpr std::size_t stateSize = sizeof(stateMagic) + sizeof(std::uint32_t);

enum Parameter : std::uint32_t {
    paramAllocate,
    paramThrowProcess,
    paramThrowActivate,
    paramThrowLoad,
    paramThrowSave,
    paramThrowMainThread,
    paramLatencyFlap,
    paramSleep,
    paramCallbacksAudio,
    paramCallbacksMain,
    paramCrash,
    paramLevel,
    paramGetValueOnAudioThread,
    paramReentered,
    paramActivations,
    parameterCount,
};

constexpr const char* parameterNames[parameterCount] = {
    "allocate",       "throwProcess",   "throwActivate", "throwLoad", "throwSave",
    "throwMainThread", "latencyFlap",   "sleep",         "callbacksAudio", "callbacksMain",
    "crash",          "level",          "getValueOnAudioThread", "reentered", "activations",
};

constexpr bool isProbe(std::uint32_t index) { return index >= paramGetValueOnAudioThread; }

constexpr clap_id idOf(std::uint32_t index) { return 9000 - 11 * index; }

constexpr bool indexOf(clap_id id, std::uint32_t& index) {
    if (id > idOf(0) || (idOf(0) - id) % 11 != 0 || (idOf(0) - id) / 11 >= parameterCount) {
        return false;
    }
    index = (idOf(0) - id) / 11;
    return true;
}

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

[[noreturn]] void crashNow() {
#if defined(_MSC_VER)
    // No "abort() has been called" box and no Windows Error Reporting: a headless
    // engine has nobody to click it. The exit code stays 3.
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
#endif
    std::abort();
}

// What allocate writes through, so the allocation cannot be optimized away.
char* volatile allocationSink = nullptr;

// Calls of params.get_info and params.get_value in flight on this thread.
thread_local int tParamsDepth = 0;

struct HostilePlugin {
    clap_plugin_t clap{};
    const clap_host_t* host = nullptr;
    const clap_host_latency_t* hostLatency = nullptr;
    const clap_host_params_t* hostParams = nullptr;
    const clap_host_tail_t* hostTail = nullptr;
    const clap_host_state_t* hostState = nullptr;
    const clap_host_thread_check_t* hostThreads = nullptr;

    std::array<std::atomic<double>, parameterCount> values{};
    std::atomic<std::uint32_t> delay{0};
    std::atomic<std::uint32_t> activations{0};
    std::atomic<bool> throwNextActivate{false};

    bool on(Parameter parameter) const { return values[parameter].load() >= 0.5; }

    // The main-thread callbacks of "callbacksMain".
    void callBackFromMain() {
        if (hostParams != nullptr) {
            hostParams->rescan(host, CLAP_PARAM_RESCAN_ALL);
        }
        host->request_restart(host);
    }

    // The audio-thread callbacks of "callbacksAudio".
    void callBackFromAudio() {
        if (hostParams != nullptr) {
            hostParams->rescan(host, CLAP_PARAM_RESCAN_VALUES);
        }
        if (hostTail != nullptr) {
            hostTail->changed(host);
        }
        if (hostLatency != nullptr) {
            hostLatency->changed(host);
        }
        if (hostParams != nullptr) {
            hostParams->request_flush(host);
        }
        host->request_restart(host);
        host->request_callback(host);
        if (hostState != nullptr) {
            hostState->mark_dirty(host);
        }
    }

    // In process() or in params.flush.
    void apply(const clap_event_header_t& header) {
        if (header.space_id != CLAP_CORE_EVENT_SPACE_ID || header.type != CLAP_EVENT_PARAM_VALUE) {
            return;
        }
        const auto& event = reinterpret_cast<const clap_event_param_value_t&>(header);
        std::uint32_t index = 0;
        if (!indexOf(event.param_id, index) || isProbe(index)) {
            return;
        }
        const bool wasOn = values[index].load() >= 0.5;
        values[index].store(event.value);
        const bool turnedOn = !wasOn && event.value >= 0.5;
        if (index == paramCrash && turnedOn) {
            crashNow();
        }
        if (index == paramThrowMainThread && turnedOn) {
            host->request_callback(host);
        }
    }

    void applyAll(const clap_input_events_t* in) {
        const std::uint32_t count = in->size(in);
        for (std::uint32_t i = 0; i < count; ++i) {
            apply(*in->get(in, i));
        }
    }
};

HostilePlugin& self(const clap_plugin_t* plugin) { return *static_cast<HostilePlugin*>(plugin->plugin_data); }

// One params.get_info or params.get_value call: notes a re-entry, and makes the
// callbacks of "callbacksMain" from the outermost call only, so a host that calls
// back in does not recurse for ever.
class ParamsCall {
public:
    explicit ParamsCall(HostilePlugin& plugin) : plugin_(plugin) {
        if (tParamsDepth++ > 0) {
            plugin_.values[paramReentered].store(1.0);
        } else if (plugin_.on(paramCallbacksMain)) {
            plugin_.callBackFromMain();
        }
    }
    ~ParamsCall() { --tParamsDepth; }
    ParamsCall(const ParamsCall&) = delete;
    ParamsCall& operator=(const ParamsCall&) = delete;

private:
    HostilePlugin& plugin_;
};

// --- clap.audio-ports

std::uint32_t audioPortCount(const clap_plugin_t*, bool) { return 1; }

bool audioPortGet(const clap_plugin_t*, std::uint32_t index, bool isInput, clap_audio_port_info_t* info) {
    if (index != 0) {
        return false;
    }
    *info = {};
    info->id = 0;
    std::snprintf(info->name, sizeof(info->name), "%s", isInput ? "In" : "Out");
    info->flags = CLAP_AUDIO_PORT_IS_MAIN;
    info->channel_count = 2;
    info->port_type = CLAP_PORT_STEREO;
    info->in_place_pair = CLAP_INVALID_ID;
    return true;
}

const clap_plugin_audio_ports_t audioPorts = {audioPortCount, audioPortGet};

// --- clap.params

std::uint32_t paramsCount(const clap_plugin_t*) { return parameterCount; }

bool paramsGetInfo(const clap_plugin_t* plugin, std::uint32_t index, clap_param_info_t* info) {
    const ParamsCall call(self(plugin));
    if (index >= parameterCount) {
        return false;
    }
    *info = {};
    info->id = idOf(index);
    if (isProbe(index)) {
        info->flags = CLAP_PARAM_IS_STEPPED | CLAP_PARAM_IS_READONLY;
    } else if (index == paramLevel) {
        info->flags = CLAP_PARAM_IS_AUTOMATABLE;
    } else {
        info->flags = CLAP_PARAM_IS_AUTOMATABLE | CLAP_PARAM_IS_STEPPED;
    }
    std::snprintf(info->name, sizeof(info->name), "%s", parameterNames[index]);
    info->min_value = 0.0;
    info->max_value = index == paramActivations ? maxActivations : 1.0;
    info->default_value = 0.0;
    return true;
}

bool paramsGetValue(const clap_plugin_t* plugin, clap_id id, double* value) {
    auto& hostile = self(plugin);
    const ParamsCall call(hostile);
    if (hostile.hostThreads != nullptr && hostile.hostThreads->is_audio_thread(hostile.host) &&
        !hostile.hostThreads->is_main_thread(hostile.host)) {
        hostile.values[paramGetValueOnAudioThread].store(1.0);
    }
    std::uint32_t index = 0;
    if (!indexOf(id, index)) {
        return false;
    }
    *value = hostile.values[index].load();
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

void paramsFlush(const clap_plugin_t* plugin, const clap_input_events_t* in, const clap_output_events_t*) {
    self(plugin).applyAll(in);
}

const clap_plugin_params_t params = {paramsCount,       paramsGetInfo,     paramsGetValue,
                                     paramsValueToText, paramsTextToValue, paramsFlush};

// --- clap.latency, clap.tail

std::uint32_t latencyGet(const clap_plugin_t* plugin) { return self(plugin).delay.load(); }

const clap_plugin_latency_t latency = {latencyGet};

std::uint32_t tailGet(const clap_plugin_t*) { return 0; }

const clap_plugin_tail_t tail = {tailGet};

// --- clap.state

bool stateSave(const clap_plugin_t* plugin, const clap_ostream_t* stream) {
    if (self(plugin).on(paramThrowSave)) {
        throw std::runtime_error("siann_hostile_plugin: throwSave");
    }
    std::array<std::uint8_t, stateSize> blob{};
    std::memcpy(blob.data(), stateMagic, sizeof(stateMagic));
    for (std::size_t i = 0; i < sizeof(std::uint32_t); ++i) {
        blob[sizeof(stateMagic) + i] = static_cast<std::uint8_t>((stateVersion >> (8 * i)) & 0xff);
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
    auto& hostile = self(plugin);
    if (hostile.on(paramThrowLoad)) {
        throw std::runtime_error("siann_hostile_plugin: throwLoad");
    }
    std::array<std::uint8_t, stateSize> blob{};
    std::size_t size = 0;
    while (size < blob.size()) {
        const auto count = stream->read(stream, blob.data() + size, blob.size() - size);
        if (count <= 0) {
            break;
        }
        size += static_cast<std::size_t>(count);
    }
    if (size != stateSize || std::memcmp(blob.data(), stateMagic, sizeof(stateMagic)) != 0) {
        return false;
    }
    std::uint32_t version = 0;
    for (std::size_t i = 0; i < sizeof(std::uint32_t); ++i) {
        version |= static_cast<std::uint32_t>(blob[sizeof(stateMagic) + i]) << (8 * i);
    }
    if (version != stateVersion) {
        return false;
    }
    // Whatever follows is left unread: a blob that holds "crash" never turns it on.
    if (hostile.on(paramCallbacksMain)) {
        hostile.callBackFromMain();
    }
    return true;
}

const clap_plugin_state_t state = {stateSave, stateLoad};

// --- clap_plugin

bool pluginInit(const clap_plugin_t* plugin) {
    auto& hostile = self(plugin);
    const auto extension = [&](const char* id) { return hostile.host->get_extension(hostile.host, id); };
    hostile.hostLatency = static_cast<const clap_host_latency_t*>(extension(CLAP_EXT_LATENCY));
    hostile.hostParams = static_cast<const clap_host_params_t*>(extension(CLAP_EXT_PARAMS));
    hostile.hostTail = static_cast<const clap_host_tail_t*>(extension(CLAP_EXT_TAIL));
    hostile.hostState = static_cast<const clap_host_state_t*>(extension(CLAP_EXT_STATE));
    hostile.hostThreads = static_cast<const clap_host_thread_check_t*>(extension(CLAP_EXT_THREAD_CHECK));
    return true;
}

void pluginDestroy(const clap_plugin_t* plugin) { delete &self(plugin); }

bool pluginActivate(const clap_plugin_t* plugin, double, std::uint32_t, std::uint32_t) {
    auto& hostile = self(plugin);
    if (hostile.throwNextActivate.exchange(false) || hostile.on(paramThrowActivate)) {
        throw std::runtime_error("siann_hostile_plugin: throwActivate");
    }
    const auto count = hostile.activations.fetch_add(1) + 1;
    hostile.values[paramActivations].store(static_cast<double>(count));
    if (hostile.on(paramLatencyFlap)) {
        const std::uint32_t next = hostile.delay.load() == shortFlapLatency ? longFlapLatency : shortFlapLatency;
        hostile.delay.store(next);
        if (hostile.hostLatency != nullptr) {
            hostile.hostLatency->changed(hostile.host);  // inside activate, where CLAP wants it
        }
    }
    if (hostile.on(paramCallbacksMain)) {
        hostile.callBackFromMain();
    }
    return true;
}

void pluginDeactivate(const clap_plugin_t*) {}

bool pluginStartProcessing(const clap_plugin_t*) { return true; }

void pluginStopProcessing(const clap_plugin_t*) {}

void pluginReset(const clap_plugin_t*) {}

clap_process_status pluginProcess(const clap_plugin_t* plugin, const clap_process_t* process) {
    auto& hostile = self(plugin);
    hostile.applyAll(process->in_events);
    if (hostile.on(paramSleep)) {
        std::this_thread::sleep_for(sleepPerBlock);
    }
    if (hostile.on(paramAllocate)) {
        allocationSink = new char[allocationBytes];
        allocationSink[0] = 1;
        delete[] allocationSink;
        allocationSink = nullptr;
    }
    if (hostile.on(paramCallbacksAudio)) {
        hostile.callBackFromAudio();
    }
    if (hostile.on(paramLatencyFlap) && hostile.hostLatency != nullptr) {
        hostile.hostLatency->changed(hostile.host);  // a main-thread call, from the audio thread
    }
    if (hostile.on(paramThrowProcess)) {
        throw std::runtime_error("siann_hostile_plugin: throwProcess");
    }
    const std::uint32_t frames = process->frames_count;
    const clap_audio_buffer_t& input = process->audio_inputs[0];
    const clap_audio_buffer_t& output = process->audio_outputs[0];
    for (std::uint32_t c = 0; c < output.channel_count; ++c) {
        if (c < input.channel_count) {
            std::memcpy(output.data32[c], input.data32[c], frames * sizeof(float));
        } else {
            std::memset(output.data32[c], 0, frames * sizeof(float));
        }
    }
    return CLAP_PROCESS_CONTINUE;
}

const void* pluginGetExtension(const clap_plugin_t*, const char* id) {
    if (std::strcmp(id, CLAP_EXT_AUDIO_PORTS) == 0) {
        return &audioPorts;
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
    if (self(plugin).on(paramThrowMainThread)) {
        throw std::runtime_error("siann_hostile_plugin: throwMainThread");
    }
}

// --- the factory and the entry

const char* const features[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, nullptr};

const clap_plugin_descriptor_t descriptor = {
    CLAP_VERSION_INIT, "org.siann.hostile-plugin", "SIANN Hostile Plugin", "SIANN", "", "", "", "1.0.0",
    "Breaks the hosting rules on purpose", features,
};

std::uint32_t factoryCount(const clap_plugin_factory_t*) { return 1; }

const clap_plugin_descriptor_t* factoryDescriptor(const clap_plugin_factory_t*, std::uint32_t index) {
    return index == 0 ? &descriptor : nullptr;
}

const clap_plugin_t* factoryCreate(const clap_plugin_factory_t*, const clap_host_t* host, const char* id) {
    if (std::strcmp(id, descriptor.id) != 0) {
        return nullptr;
    }
    auto* hostile = new HostilePlugin;
    hostile->host = host;
    hostile->throwNextActivate.store(!environmentValue("SIANN_HOSTILE_PLUGIN_THROW_ACTIVATE").empty());
    hostile->clap.desc = &descriptor;
    hostile->clap.plugin_data = hostile;
    hostile->clap.init = pluginInit;
    hostile->clap.destroy = pluginDestroy;
    hostile->clap.activate = pluginActivate;
    hostile->clap.deactivate = pluginDeactivate;
    hostile->clap.start_processing = pluginStartProcessing;
    hostile->clap.stop_processing = pluginStopProcessing;
    hostile->clap.reset = pluginReset;
    hostile->clap.process = pluginProcess;
    hostile->clap.get_extension = pluginGetExtension;
    hostile->clap.on_main_thread = pluginOnMainThread;
    return &hostile->clap;
}

const clap_plugin_factory_t factory = {factoryCount, factoryDescriptor, factoryCreate};

bool entryInit(const char*) { return true; }

void entryDeinit() {}

const void* entryGetFactory(const char* id) {
    return std::strcmp(id, CLAP_PLUGIN_FACTORY_ID) == 0 ? &factory : nullptr;
}

}  // namespace

// clap/entry.h declares it exported, extern and with C linkage; this inherits all three.
const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, entryInit, entryDeinit, entryGetFactory};
