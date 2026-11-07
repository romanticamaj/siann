#include "siann/host/juce_plugin_host.hpp"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <thread>

#include "editor_platform.hpp"
#include "siann/host/state_envelope.hpp"

namespace siann::host {

namespace {

constexpr auto instantiateTimeout = std::chrono::seconds(60);

// One dispatch slice: long enough not to spin, short enough for a predicate to
// be seen promptly.
constexpr int dispatchSliceMilliseconds = 5;

// juce::AudioBuffer holds up to this many channel pointers without allocating,
// which process() depends on.
constexpr int maxPluginChannels = 31;

bool dispatchUntil(const std::function<bool()>& predicate, std::chrono::steady_clock::duration timeout) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    auto* messageManager = juce::MessageManager::getInstance();
    for (;;) {
        if (predicate()) {
            return true;
        }
        if (std::chrono::steady_clock::now() >= deadline) {
            return false;
        }
        messageManager->runDispatchLoopUntil(dispatchSliceMilliseconds);
    }
}

juce::String fromUtf8(const std::string& text) {
    return juce::String::fromUTF8(text.c_str(), static_cast<int>(text.size()));
}

std::string formatKey(const juce::String& formatName) {
    return formatName == "AudioUnit" ? "au" : formatName.toLowerCase().toStdString();
}

// Names one plugin wherever it is installed: state saved with it must load on
// another machine. JUCE's createIdentifierString hashes the install path in.
std::string stableUid(const juce::PluginDescription& description) {
    const int id = description.uniqueId != 0 ? description.uniqueId : description.deprecatedUid;
    return formatKey(description.pluginFormatName) + "-" + description.name.toStdString() + "-" +
           juce::String::toHexString(id).toStdString();
}

// The window an editor lives in. JUCE parents a plugin's view in it; the window
// is a top-level one so the platform can own it (Windows) or float it (macOS).
class EditorWindow final : public juce::DocumentWindow {
public:
    EditorWindow(const juce::String& windowTitle, juce::AudioProcessorEditor* editor,
                 std::function<void()> onCloseButton)
        : juce::DocumentWindow(windowTitle, juce::Colours::black, juce::DocumentWindow::closeButton, true),
          onCloseButton_(std::move(onCloseButton)) {
        setUsingNativeTitleBar(true);
        setContentOwned(editor, true);
        setResizable(editor->isResizable(), false);
        setAlwaysOnTop(editor_platform::editorsFloat);
        centreWithSize(getWidth(), getHeight());
        setVisible(true);
    }

    std::uintptr_t nativeHandle() const {
        auto* peer = getPeer();
        return peer == nullptr ? 0 : reinterpret_cast<std::uintptr_t>(peer->getNativeHandle());
    }

    void closeButtonPressed() override { onCloseButton_(); }

private:
    std::function<void()> onCloseButton_;
};

class JucePluginInstance final : public PluginInstance,
                                 private PluginControl,
                                 private juce::AudioProcessorListener,
                                 private juce::AsyncUpdater {
public:
    using EventSink = std::function<void(const PluginEvent&)>;

    JucePluginInstance(std::unique_ptr<juce::AudioPluginInstance> plugin, std::string uid, std::int64_t sampleRate,
                       int maxBlockFrames)
        : plugin_(std::move(plugin)), uid_(std::move(uid)), sampleRate_(static_cast<double>(sampleRate)),
          maxBlockFrames_(maxBlockFrames) {
        plugin_->prepareToPlay(sampleRate_, maxBlockFrames_);
        inputChannels_ = plugin_->getTotalNumInputChannels();
        outputChannels_ = plugin_->getTotalNumOutputChannels();
        channels_ = std::max(inputChannels_, outputChannels_);
        if (channels_ > maxPluginChannels) {
            plugin_->releaseResources();
            throw PluginError("plugin_load_failed", "the plugin has more channels than the host processes");
        }
        pointers_.assign(static_cast<std::size_t>(channels_), nullptr);
        scratch_.assign(static_cast<std::size_t>(channels_) * static_cast<std::size_t>(maxBlockFrames_), 0.0f);
        midi_.ensureSize(4096);

        capabilities_.sampleAccurateParameters = false;  // JUCE hands parameters over per block
        capabilities_.midiInput = plugin_->acceptsMidi();
        capabilities_.midiOutput = plugin_->producesMidi();
        capabilities_.sidechain = plugin_->getBusCount(true) > 1;
        capabilities_.variableLatency = true;  // both formats can change it, and it is reported when they do
        capabilities_.editor = plugin_->hasEditor();
        readLatency();
        readTail();

        plugin_->addListener(this);
    }

    ~JucePluginInstance() override {
        closeEditor();
        plugin_->removeListener(this);
        plugin_->releaseResources();
    }

    PluginCapabilities capabilities() const override { return capabilities_; }

    int latencyFrames() const override { return latencyFrames_.load(std::memory_order_relaxed); }

    int tailFrames() const override { return tailFrames_.load(std::memory_order_relaxed); }

    void process(const AudioBufferView& input, const AudioBufferView& output, EventList) noexcept override {
        const int frames = output.frames;
        if (frames <= 0 || frames > maxBlockFrames_) {
            output.clear();
            return;
        }
        // JUCE processes in place: the plugin's channels are the output view's,
        // and scratch for those the view does not have.
        const auto bytes = static_cast<std::size_t>(frames) * sizeof(float);
        for (int c = 0; c < channels_; ++c) {
            float* channel = c < output.channelCount
                                 ? output.channels[c]
                                 : scratch_.data() + static_cast<std::size_t>(c) * static_cast<std::size_t>(maxBlockFrames_);
            pointers_[static_cast<std::size_t>(c)] = channel;
            const float* source = c < inputChannels_ && c < input.channelCount ? input.channels[c] : nullptr;
            if (source == nullptr) {
                std::memset(channel, 0, bytes);
            } else if (source != channel) {
                std::memcpy(channel, source, bytes);
            }
        }
        midi_.clear();  // M0: the EventList is discarded; the plugin gets no MIDI input
        juce::AudioBuffer<float> buffer(pointers_.data(), channels_, frames);
        // setState's half of this is in ProcessingPause. Skipped, the block passes
        // its input through.
        processing_.store(true);
        if (paused_.load() == 0) {
            // SIANN takes no lock here; JUCE's wrapper does inside processBlock
            // (processMutex, the MIDI lists' lock, a parameter's listenerLock around
            // the sink): the audited exception under "Realtime rules and
            // enforcement" (ADR-0018).
            plugin_->processBlock(buffer, midi_);
        }
        processing_.store(false);
        for (int c = outputChannels_; c < output.channelCount; ++c) {
            std::memset(output.channels[c], 0, bytes);
        }
    }

    PluginControl& control() override { return *this; }

private:
    // Holds the plugin out of processing: the block in flight finishes, and until
    // this goes process() skips the plugin. Only this side ever waits. A count,
    // not a flag, so a pause inside a pause ends when the outer one does. Both
    // atomics stay sequentially consistent, or each side could miss the other's
    // store.
    class ProcessingPause {
    public:
        explicit ProcessingPause(JucePluginInstance& instance) : instance_(instance) {
            instance_.paused_.fetch_add(1);
            while (instance_.processing_.load()) {
                std::this_thread::yield();
            }
        }
        ~ProcessingPause() { instance_.paused_.fetch_sub(1); }
        ProcessingPause(const ProcessingPause&) = delete;
        ProcessingPause& operator=(const ProcessingPause&) = delete;

    private:
        JucePluginInstance& instance_;
    };

    // Main thread: the formats allow this call nowhere else (VST3 getTailSamples).
    void readTail() {
        const double frames = plugin_->getTailLengthSeconds() * sampleRate_;
        const bool beyondInt = !std::isfinite(frames) || frames >= static_cast<double>(std::numeric_limits<int>::max());
        tailFrames_.store(beyondInt ? std::numeric_limits<int>::max() : static_cast<int>(std::ceil(frames)),
                          std::memory_order_relaxed);
    }

    // Message thread, where JUCE writes the plugin's latency (a plain int).
    void readLatency() { latencyFrames_.store(plugin_->getLatencySamples(), std::memory_order_relaxed); }

    void handleAsyncUpdate() override { readTail(); }

    std::vector<std::uint8_t> getState() override {
        juce::MemoryBlock payload;
        plugin_->getStateInformation(payload);

        return wrapPluginState(uid_, {static_cast<const std::uint8_t*>(payload.getData()), payload.getSize()});
    }

    void setState(const std::vector<std::uint8_t>& state) override {
        const auto payload = unwrapPluginState(state, uid_);
        {
            const ProcessingPause pause(*this);
            plugin_->setStateInformation(payload.data(), static_cast<int>(payload.size()));
        }
        readLatency();
        // A tail the state changed without a latency report. A hosted VST3 built
        // with JUCE also ends setComponentState in a kParamValuesChanged restart,
        // which reaches audioProcessorChanged and reads the tail anyway; a hosted
        // AU reports nothing synchronously, so there this read is the only one
        // (checkBuiltTestPlugin checks it on macOS).
        readTail();
    }

    std::vector<PluginParameterInfo> parameters() const override {
        const auto& all = plugin_->getParameters();
        std::vector<PluginParameterInfo> result;
        result.reserve(static_cast<std::size_t>(all.size()));
        for (int i = 0; i < all.size(); ++i) {
            const auto* parameter = plugin_->getHostedParameter(i);
            PluginParameterInfo info;
            info.id = parameter->getParameterID().toStdString();
            info.name = parameter->getName(256).toStdString();
            info.defaultValue = parameter->getDefaultValue();
            info.automatable = parameter->isAutomatable();
            result.push_back(std::move(info));
        }
        return result;
    }

    double getParameter(int index) const override { return parameterAt(index).getValue(); }

    void setParameter(int index, double value) override {
        parameterAt(index).setValue(static_cast<float>(std::clamp(value, 0.0, 1.0)));
    }

    void openEditor(EditorOwner owner) override {
        if (editor_ == nullptr) {
            auto* editor = plugin_->createEditorAndMakeActive();
            if (editor == nullptr) {
                throw PluginError("editor_failed", "the plugin has no editor");
            }
            editor_ = std::make_unique<EditorWindow>(plugin_->getName(), editor, [this, alive = std::weak_ptr<int>(alive_)] {
                // Not from inside the window's own event.
                juce::MessageManager::callAsync([this, alive] {
                    if (!alive.expired()) {
                        closeEditor();
                    }
                });
            });
            editor_platform::editorOpened();
            editor_platform::editorShown(editor_->nativeHandle());
        }
        editor_platform::applyOwner(editor_->nativeHandle(), owner.nativeWindow);
        editor_->toFront(true);
        editor_platform::editorRaised();
    }

    void closeEditor() override {
        if (editor_ != nullptr) {
            editor_.reset();
            editor_platform::editorClosed();
        }
    }

    bool editorOpen() const override { return editor_ != nullptr; }

    std::uintptr_t editorNativeHandle() const override { return editor_ == nullptr ? 0 : editor_->nativeHandle(); }

    void setEventSink(EventSink sink) override {
        // A plugin may be reporting on another thread right now, so the previous
        // sink stays alive until the instance goes; sinks are set rarely.
        sinks_.push_back(std::make_unique<EventSink>(std::move(sink)));
        sink_.store(sinks_.back().get(), std::memory_order_release);
    }

    juce::AudioProcessorParameter& parameterAt(int index) const {
        const auto& all = plugin_->getParameters();
        if (index < 0 || index >= all.size()) {
            throw PluginError("bad_parameter", "no parameter " + std::to_string(index));
        }
        return *all[index];
    }

    void emit(const PluginEvent& event) const {
        const EventSink* sink = sink_.load(std::memory_order_acquire);
        if (sink != nullptr && *sink) {
            (*sink)(event);
        }
    }

    void audioProcessorParameterChanged(juce::AudioProcessor*, int parameterIndex, float newValue) override {
        PluginEvent event;
        event.kind = PluginEvent::Kind::parameterEdited;
        event.parameterIndex = parameterIndex;
        event.value = newValue;
        emit(event);
    }

    void audioProcessorChanged(juce::AudioProcessor*, const ChangeDetails& details) override {
        if (details.latencyChanged || details.parameterInfoChanged || details.programChanged) {
            if (juce::MessageManager::existsAndIsCurrentThread()) {
                readTail();  // before the event goes out, so its reader sees the new tail
            } else {
                triggerAsyncUpdate();
            }
        }
        if (details.latencyChanged) {
            // On the reporting thread, which for a hosted VST3 or AU is the message
            // thread; a plugin reporting from elsewhere hands over its own int.
            readLatency();
            PluginEvent event;
            event.kind = PluginEvent::Kind::latencyChanged;
            event.latencyFrames = latencyFrames_.load(std::memory_order_relaxed);
            emit(event);
        }
        if (details.parameterInfoChanged || details.programChanged) {
            PluginEvent event;
            event.kind = PluginEvent::Kind::restartRequested;
            emit(event);
        }
    }

    juce::ScopedJuceInitialiser_GUI gui_;  // first in, last out: everything below needs JUCE
    std::unique_ptr<juce::AudioPluginInstance> plugin_;
    std::string uid_;
    double sampleRate_;
    int maxBlockFrames_;
    int inputChannels_ = 0;
    int outputChannels_ = 0;
    int channels_ = 0;
    PluginCapabilities capabilities_;
    std::vector<float*> pointers_;
    std::vector<float> scratch_;
    juce::MidiBuffer midi_;
    std::vector<std::unique_ptr<EventSink>> sinks_;
    std::atomic<const EventSink*> sink_{nullptr};
    std::atomic<int> tailFrames_{0};
    std::atomic<int> latencyFrames_{0};  // JUCE's own int is written on the message thread; this is read anywhere
    std::atomic<bool> processing_{false};
    std::atomic<int> paused_{0};
    std::unique_ptr<EditorWindow> editor_;
    std::shared_ptr<int> alive_ = std::make_shared<int>(0);
};

}  // namespace

struct MainThreadLoop::Impl {
    juce::ScopedJuceInitialiser_GUI gui;
};

MainThreadLoop::MainThreadLoop() : impl_(std::make_unique<Impl>()) {
    juce::MessageManager::getInstance()->setCurrentThreadAsMessageThread();
    editor_platform::startInBackground();
}

MainThreadLoop::~MainThreadLoop() = default;

bool MainThreadLoop::runUntil(const std::function<bool()>& predicate, std::chrono::milliseconds timeout) {
    return dispatchUntil(predicate, timeout);
}

struct JucePluginHost::Impl {
    juce::ScopedJuceInitialiser_GUI gui;
    juce::AudioPluginFormatManager formats;
    // By descriptor uid, then path: a uid is the same at every install of a plugin,
    // and each install is loaded from where it is.
    std::map<std::string, std::map<std::string, juce::PluginDescription>> known;

    Impl() { juce::addDefaultFormatsToManager(formats); }

    // path is what the caller named; an AU is opened by the system's identifier.
    PluginDescriptor remember(const juce::PluginDescription& description, const std::string& path) {
        PluginDescriptor descriptor;
        descriptor.format = formatKey(description.pluginFormatName);
        descriptor.uid = stableUid(description);
        descriptor.name = description.name.toStdString();
        descriptor.vendor = description.manufacturerName.toStdString();
        descriptor.path = descriptor.format == "au" ? description.fileOrIdentifier.toStdString() : path;
        descriptor.version = description.version.toStdString();
        known[descriptor.uid][descriptor.path] = description;
        return descriptor;
    }

    // The install a descriptor names. No path names the only install there is.
    const juce::PluginDescription* find(const std::string& uid, const std::string& path) const {
        const auto installs = known.find(uid);
        if (installs == known.end()) {
            return nullptr;
        }
        if (path.empty()) {
            return installs->second.size() == 1 ? &installs->second.begin()->second : nullptr;
        }
        const auto install = installs->second.find(path);
        return install == installs->second.end() ? nullptr : &install->second;
    }

    // Always the asynchronous call, pumped here: an AUv3 cannot be created any
    // other way on the message thread, and one path serves both formats.
    std::unique_ptr<juce::AudioPluginInstance> create(const juce::PluginDescription& description, double sampleRate,
                                                      int blockFrames) {
        struct Pending {
            std::unique_ptr<juce::AudioPluginInstance> instance;
            juce::String error;
            bool done = false;
        };
        auto pending = std::make_shared<Pending>();
        formats.createPluginInstanceAsync(description, sampleRate, blockFrames,
                                          [pending](std::unique_ptr<juce::AudioPluginInstance> instance,
                                                    const juce::String& error) {
                                              pending->instance = std::move(instance);
                                              pending->error = error;
                                              pending->done = true;
                                          });
        if (!dispatchUntil([&] { return pending->done; }, instantiateTimeout)) {
            throw PluginError("plugin_load_failed", description.name.toStdString() + " did not load in time");
        }
        if (pending->instance == nullptr) {
            throw PluginError("plugin_load_failed",
                              description.name.toStdString() + ": " + pending->error.toStdString());
        }
        return std::move(pending->instance);
    }
};

JucePluginHost::JucePluginHost() : impl_(std::make_unique<Impl>()) { editor_platform::failLoadsWithoutDialogs(); }
JucePluginHost::~JucePluginHost() = default;

std::vector<PluginDescriptor> JucePluginHost::scan() {
    // Lists without loading: loading a bundle runs its code in this process, and
    // one plugin that crashes on load would take the engine with it.
    std::vector<PluginDescriptor> result;
    for (auto* format : impl_->formats.getFormats()) {
        const auto key = formatKey(format->getName());
        for (const auto& candidate : format->searchPathsForPlugins(format->getDefaultLocationsToSearch(), true, false)) {
            PluginDescriptor descriptor;
            descriptor.format = key;
            descriptor.path = candidate.toStdString();
            descriptor.name = key == "au" ? format->getNameOfPluginFromIdentifier(candidate).toStdString()
                                          : juce::File(candidate).getFileNameWithoutExtension().toStdString();
            result.push_back(std::move(descriptor));
        }
    }
    return result;
}

std::vector<PluginDescriptor> JucePluginHost::scanPath(const std::string& path) {
    const auto target = fromUtf8(path);
    const bool isIdentifier = target.startsWithIgnoreCase("AudioUnit:");
    if (!isIdentifier && !juce::File::getCurrentWorkingDirectory().getChildFile(target).exists()) {
        throw PluginError("plugin_not_found", "no such plugin: " + path);
    }
    juce::AudioPluginFormat* format = nullptr;
    for (auto* candidate : impl_->formats.getFormats()) {
        if (candidate->fileMightContainThisPluginType(target)) {
            format = candidate;
            break;
        }
    }
    if (format == nullptr) {
        throw PluginError("plugin_load_failed", "not a plugin format this host loads: " + path);
    }
    juce::KnownPluginList list;
    juce::OwnedArray<juce::PluginDescription> found;
    list.scanAndAddFile(target, false, found, *format);
    if (found.isEmpty()) {
        throw PluginError("plugin_load_failed", "no plugin in " + path);
    }
    std::vector<PluginDescriptor> result;
    for (const auto* description : found) {
        auto descriptor = impl_->remember(*description, path);
        try {
            descriptor.hasEditor = impl_->create(*description, 44'100.0, 512)->hasEditor();
        } catch (const PluginError&) {
            descriptor.hasEditor = false;  // listed all the same; instantiate reports why it fails
        }
        result.push_back(std::move(descriptor));
    }
    return result;
}

std::unique_ptr<PluginInstance> JucePluginHost::instantiate(const PluginDescriptor& descriptor, std::int64_t sampleRate,
                                                            int maxBlockFrames) {
    // A descriptor from scan(), or one kept from an earlier run, is probed first.
    std::string uid = descriptor.uid;
    const juce::PluginDescription* description = impl_->find(uid, descriptor.path);
    if (description == nullptr && !descriptor.path.empty()) {
        const auto probed = scanPath(descriptor.path);
        const auto match = std::find_if(probed.begin(), probed.end(),
                                        [&](const PluginDescriptor& found) { return uid.empty() || found.uid == uid; });
        if (match != probed.end()) {
            uid = match->uid;
            description = impl_->find(uid, match->path);
        }
    }
    if (description == nullptr) {
        throw PluginError("plugin_not_found", "unknown plugin, or more than one install of it: " + descriptor.name);
    }
    auto plugin = impl_->create(*description, static_cast<double>(sampleRate), maxBlockFrames);
    return std::make_unique<JucePluginInstance>(std::move(plugin), uid, sampleRate, maxBlockFrames);
}

}  // namespace siann::host
