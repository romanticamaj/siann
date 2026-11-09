// macOS-only hosting tests (architecture spec, "Process model"): macOS cannot
// parent windows across processes, so editors float, at the floating window level
// above other applications' windows, and the engine activates itself while one is
// open.

#include <catch2/catch_test_macros.hpp>

#import <AppKit/AppKit.h>
#import <AudioToolbox/AudioToolbox.h>
#import <objc/runtime.h>

#include <cstdint>
#include <string>

#include "hosting_checks.hpp"
#include "siann/host/juce_plugin_host.hpp"

using namespace siann;

// A CI runner's window server may or may not grant activation, so what the engine
// asks for is counted instead. Nothing else asks here: JUCE does on mouse input only.
static int activationRequests = 0;

@interface NSApplication (SiannActivationCount)
- (void)siannCountedActivateIgnoringOtherApps:(BOOL)flag;
@end

@implementation NSApplication (SiannActivationCount)
- (void)siannCountedActivateIgnoringOtherApps:(BOOL)flag {
    ++activationRequests;
    [self siannCountedActivateIgnoringOtherApps:flag];  // the original, once exchanged
}
@end

namespace {

void countActivationRequests() {
    method_exchangeImplementations(
        class_getInstanceMethod([NSApplication class], @selector(activateIgnoringOtherApps:)),
        class_getInstanceMethod([NSApplication class], @selector(siannCountedActivateIgnoringOtherApps:)));
}

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
    countActivationRequests();

    first->control().openEditor({});
    CHECK(isRegular());
    CHECK(activationRequests == 1);
    auto* view = reinterpret_cast<NSView*>(first->control().editorNativeHandle());
    const bool hasWindow = view != nil && view.window != nil;
    REQUIRE(hasWindow);
    const bool floats = view.window.level == NSFloatingWindowLevel;
    CHECK(floats);

    second->control().openEditor({});
    CHECK(activationRequests == 2);
    first->control().openEditor({});  // brought forward: the engine asks again
    CHECK(activationRequests == 3);
    first->control().closeEditor();
    CHECK(isRegular());  // one is still open
    second->control().closeEditor();
    CHECK(isAccessory());
    countActivationRequests();  // exchanged back
}

TEST_CASE("plugin host: the CI-built AU is hosted", "[juce][plugin]") {
    host::MainThreadLoop loop;
    REQUIRE(registerAudioUnitBundle(SIANN_TEST_PLUGIN_AU));

    host::JucePluginHost host;
    const auto descriptors = host.scanPath(SIANN_TEST_PLUGIN_AU);
    REQUIRE(descriptors.size() == 1);
    CHECK(descriptors.front().format == "au");
    CHECK(descriptors.front().hasEditor);

    hosting_test::checkBuiltTestPlugin(
        [&loop](const std::function<bool()>& predicate) { return loop.runUntil(predicate, hosting_test::eventTimeout); },
        host, descriptors.front());
}

// m4-juce-formats (ADR-0018, Amendment 3): the AU's sysex output reaches the host
// through JUCE's MidiDataConcatenator, which builds a MidiMessage for each one; the
// count and what SIANN allocates are the VST3's.
TEST_CASE("plugin host: an AU's sysex output is counted per event, never as an overflow", "[juce][plugin][midi]") {
    host::MainThreadLoop loop;
    REQUIRE(registerAudioUnitBundle(SIANN_TEST_PLUGIN_AU));

    host::JucePluginHost host;
    const auto descriptors = host.scanPath(SIANN_TEST_PLUGIN_AU);
    REQUIRE(descriptors.size() == 1);
    auto instance = host.instantiate(descriptors.front(), hosting_test::sampleRate, hosting_test::blockFrames);
    hosting_test::checkSysexCounting(*instance);
}
