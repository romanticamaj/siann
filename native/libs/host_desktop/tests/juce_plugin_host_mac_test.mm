// macOS-only hosting tests (architecture spec, "Process model"): macOS cannot
// parent windows across processes, so editors float and the engine activates
// itself while one is open.

#include <catch2/catch_test_macros.hpp>

#import <AppKit/AppKit.h>
#import <AudioToolbox/AudioToolbox.h>

#include <cstdint>
#include <string>

#include "siann/host/juce_plugin_host.hpp"

using namespace siann;

namespace {

bool isAccessory() {
    return [NSApp activationPolicy] == NSApplicationActivationPolicyAccessory;
}

bool isRegular() {
    return [NSApp activationPolicy] == NSApplicationActivationPolicyRegular;
}

OSType fourCharCode(NSString* text) {
    const char* bytes = text.UTF8String;
    return (static_cast<OSType>(static_cast<unsigned char>(bytes[0])) << 24) |
           (static_cast<OSType>(static_cast<unsigned char>(bytes[1])) << 16) |
           (static_cast<OSType>(static_cast<unsigned char>(bytes[2])) << 8) |
           static_cast<OSType>(static_cast<unsigned char>(bytes[3]));
}

// The system only lists AUs from its install locations, so a bundle in the build
// tree is registered with this process by hand, from its own Info.plist.
bool registerAudioUnitBundle(const std::string& path) {
    NSBundle* bundle = [NSBundle bundleWithPath:[NSString stringWithUTF8String:path.c_str()]];
    if (bundle == nil || ![bundle load]) {
        return false;
    }
    NSArray* components = [bundle objectForInfoDictionaryKey:@"AudioComponents"];
    NSDictionary* component = components.firstObject;
    if (component == nil) {
        return false;
    }
    AudioComponentDescription description{};
    description.componentType = fourCharCode(component[@"type"]);
    description.componentSubType = fourCharCode(component[@"subtype"]);
    description.componentManufacturer = fourCharCode(component[@"manufacturer"]);

    CFBundleRef cfBundle = CFBundleCreate(kCFAllocatorDefault, (__bridge CFURLRef)bundle.bundleURL);
    if (cfBundle == nullptr) {
        return false;
    }
    auto factory = reinterpret_cast<AudioComponentFactoryFunction>(
        CFBundleGetFunctionPointerForName(cfBundle, (__bridge CFStringRef)component[@"factoryFunction"]));
    CFRelease(cfBundle);
    if (factory == nullptr) {
        return false;
    }
    return AudioComponentRegister(&description, (__bridge CFStringRef)component[@"name"],
                                  [component[@"version"] unsignedIntValue], factory) != nullptr;
}

}  // namespace

TEST_CASE("plugin host: the engine activates itself while an editor is open", "[juce][plugin]") {
    host::MainThreadLoop loop;
    CHECK(isAccessory());

    host::JucePluginHost host;
    const auto descriptors = host.scanPath(SIANN_TEST_PLUGIN_VST3);
    REQUIRE(descriptors.size() == 1);
    auto first = host.instantiate(descriptors.front(), 48'000, 256);
    auto second = host.instantiate(descriptors.front(), 48'000, 256);

    first->openEditor({});
    CHECK(isRegular());
    auto* view = reinterpret_cast<NSView*>(first->editorNativeHandle());
    const bool hasWindow = view != nil && view.window != nil;
    REQUIRE(hasWindow);
    const bool floats = view.window.parentWindow == nil;
    CHECK(floats);

    second->openEditor({});
    first->closeEditor();
    CHECK(isRegular());  // one is still open
    second->closeEditor();
    CHECK(isAccessory());
}

TEST_CASE("plugin host: the CI-built AU is hosted", "[juce][plugin]") {
    host::MainThreadLoop loop;
    REQUIRE(registerAudioUnitBundle(SIANN_TEST_PLUGIN_AU));

    host::JucePluginHost host;
    const auto descriptors = host.scanPath(SIANN_TEST_PLUGIN_AU);
    REQUIRE(descriptors.size() == 1);
    CHECK(descriptors.front().format == "au");
    CHECK(descriptors.front().hasEditor);

    auto instance = host.instantiate(descriptors.front(), 48'000, 256);
    CHECK(instance->latencyFrames() == 64);
    const auto state = instance->getState();
    auto restored = host.instantiate(descriptors.front(), 48'000, 256);
    restored->setState(state);
    CHECK(restored->latencyFrames() == 64);
}
