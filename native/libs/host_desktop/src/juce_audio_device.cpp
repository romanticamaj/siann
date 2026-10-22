#include "siann/host/juce_audio_device.hpp"

#include <juce_audio_devices/juce_audio_devices.h>

#include <atomic>
#include <cmath>

#include "siann/rt/realtime_thread.hpp"

namespace siann::host {

namespace {

// JUCE device types expect a MessageManager to exist; the engine's main thread
// runs the real message loop (architecture spec, "Process model").
void ensureMessageManager() {
    juce::MessageManager::getInstance();
}

std::vector<std::unique_ptr<juce::AudioIODeviceType>> createTypes() {
    ensureMessageManager();
    juce::AudioDeviceManager manager;
    juce::OwnedArray<juce::AudioIODeviceType> owned;
    manager.createAudioDeviceTypes(owned);
    std::vector<std::unique_ptr<juce::AudioIODeviceType>> types;
    while (!owned.isEmpty()) {
        types.emplace_back(owned.removeAndReturn(0));
    }
    for (auto& type : types) {
        type->scanForDevices();
    }
    return types;
}

}  // namespace

struct JuceAudioDevice::Impl final : juce::AudioIODeviceCallback {
    std::vector<std::unique_ptr<juce::AudioIODeviceType>> types;
    std::unique_ptr<juce::AudioIODevice> device;
    AudioCallback callback;
    std::function<void(bool)> onStopped;
    std::vector<float*> inputPointers;
    std::vector<float*> outputPointers;
    std::atomic<bool> errorReported{false};

    void audioDeviceIOCallbackWithContext(const float* const* inputData, int numInputs, float* const* outputData,
                                          int numOutputs, int numSamples,
                                          const juce::AudioIODeviceCallbackContext&) override {
        const rt::ScopedRealtimeThread realtime;
        const int inputs = std::min(numInputs, static_cast<int>(inputPointers.size()));
        for (int c = 0; c < inputs; ++c) {
            inputPointers[static_cast<std::size_t>(c)] = const_cast<float*>(inputData[c]);
        }
        const int outputs = std::min(numOutputs, static_cast<int>(outputPointers.size()));
        for (int c = 0; c < outputs; ++c) {
            outputPointers[static_cast<std::size_t>(c)] = outputData[c];
        }
        const AudioBufferView in{inputPointers.data(), inputs, numSamples};
        const AudioBufferView out{outputPointers.data(), outputs, numSamples};
        if (callback) {
            callback(in, out);
        } else {
            out.clear();
        }
    }

    void audioDeviceAboutToStart(juce::AudioIODevice*) override {}
    void audioDeviceStopped() override {}

    void audioDeviceError(const juce::String&) override {
        // Any thread. Report once; the control side stops the device.
        if (!errorReported.exchange(true) && onStopped) {
            onStopped(true);
        }
    }
};

JuceAudioDevice::JuceAudioDevice() : impl_(std::make_unique<Impl>()) {}

JuceAudioDevice::~JuceAudioDevice() {
    close();
}

std::vector<DeviceDescription> JuceAudioDevice::listOutputDevices() {
    std::vector<DeviceDescription> out;
    for (const auto& type : createTypes()) {
        const auto names = type->getDeviceNames(false);
        const int defaultIndex = type->getDefaultDeviceIndex(false);
        for (int i = 0; i < names.size(); ++i) {
            out.push_back({type->getTypeName().toStdString(), names[i].toStdString(), i == defaultIndex});
        }
    }
    return out;
}

AudioDeviceStatus JuceAudioDevice::open(const AudioDeviceConfig& config) {
    close();
    impl_->types = createTypes();

    juce::AudioIODeviceType* type = nullptr;
    juce::String name;
    if (config.deviceId.empty()) {
        for (auto& t : impl_->types) {
            const auto names = t->getDeviceNames(false);
            if (!names.isEmpty()) {
                type = t.get();
                const int index = t->getDefaultDeviceIndex(false);
                name = names[index >= 0 ? index : 0];
                break;
            }
        }
    } else {
        const auto slash = config.deviceId.find('/');
        const juce::String typeName = config.deviceId.substr(0, slash);
        name = slash == std::string::npos ? juce::String() : juce::String(config.deviceId.substr(slash + 1));
        for (auto& t : impl_->types) {
            if (t->getTypeName() == typeName) {
                type = t.get();
            }
        }
    }
    if (type == nullptr || name.isEmpty()) {
        throw DeviceError("no_device", "no audio output device matches '" + config.deviceId + "'");
    }
    const juce::String inputName = config.inputChannels > 0 ? name : juce::String();
    impl_->device.reset(type->createDevice(name, inputName));
    if (!impl_->device) {
        throw DeviceError("no_device", "cannot create audio device '" + name.toStdString() + "'");
    }

    juce::BigInteger inputs;
    juce::BigInteger outputs;
    if (config.inputChannels > 0) {
        inputs.setRange(0, config.inputChannels, true);
    }
    outputs.setRange(0, config.outputChannels, true);
    const juce::String error = impl_->device->open(inputs, outputs, static_cast<double>(config.sampleRate),
                                                   config.bufferFrames);
    if (error.isNotEmpty()) {
        impl_->device.reset();
        throw DeviceError("device_open_failed", error.toStdString());
    }
    const double rate = impl_->device->getCurrentSampleRate();
    if (std::lround(rate) != config.sampleRate) {
        impl_->device->close();
        impl_->device.reset();
        throw DeviceError("sample_rate_unsupported", "the device runs at " + std::to_string(std::lround(rate)) +
                                                         " Hz, not " + std::to_string(config.sampleRate) + " Hz");
    }
    impl_->inputPointers.assign(static_cast<std::size_t>(std::max(config.inputChannels, 0)), nullptr);
    impl_->outputPointers.assign(static_cast<std::size_t>(config.outputChannels), nullptr);
    return AudioDeviceStatus{std::lround(rate), impl_->device->getCurrentBufferSizeSamples(),
                             impl_->device->getInputLatencyInSamples(), impl_->device->getOutputLatencyInSamples()};
}

void JuceAudioDevice::start(AudioCallback callback) {
    if (!impl_->device) {
        throw DeviceError("no_device", "open the device before starting it");
    }
    impl_->callback = std::move(callback);
    impl_->errorReported.store(false);
    impl_->device->start(impl_.get());
}

void JuceAudioDevice::stop() {
    if (impl_->device) {
        impl_->device->stop();  // flushes pending callbacks before returning
    }
}

void JuceAudioDevice::close() {
    if (impl_->device) {
        impl_->device->stop();
        impl_->device->close();
        impl_->device.reset();
    }
    impl_->types.clear();
}

void JuceAudioDevice::setOnStopped(std::function<void(bool lost)> handler) {
    impl_->onStopped = std::move(handler);
}

std::vector<double> JuceAudioDevice::availableSampleRates() const {
    std::vector<double> rates;
    if (impl_->device) {
        for (const double r : impl_->device->getAvailableSampleRates()) {
            rates.push_back(r);
        }
    }
    return rates;
}

}  // namespace siann::host
