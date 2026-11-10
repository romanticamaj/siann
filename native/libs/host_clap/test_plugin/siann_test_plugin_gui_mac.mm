// siann_test_plugin's editor view on macOS (siann_test_plugin_gui.hpp): a plain
// NSView whose layer is one flat colour. No subclass, so two installs of the plugin
// loaded at once define no Objective-C class twice. Manual reference counting.

#include "siann_test_plugin_gui.hpp"

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

namespace siann_test_plugin_gui {

void* createView(std::uintptr_t parent, std::uint32_t width, std::uint32_t height) {
    if (parent == 0) {
        return nullptr;
    }
    NSView* view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];  // retained: the plugin's
    [view setWantsLayer:YES];
    [[view layer] setBackgroundColor:[[NSColor colorWithCalibratedRed:0x2a / 255.0
                                                                green:0x6f / 255.0
                                                                 blue:0x97 / 255.0
                                                                alpha:1.0] CGColor]];
    [view setHidden:YES];
    [reinterpret_cast<NSView*>(parent) addSubview:view];
    return view;
}

void resizeView(void* view, std::uint32_t width, std::uint32_t height) {
    [static_cast<NSView*>(view) setFrameSize:NSMakeSize(width, height)];
}

void showView(void* view, bool visible) { [static_cast<NSView*>(view) setHidden:visible ? NO : YES]; }

void destroyView(void* view) {
    NSView* nsView = static_cast<NSView*>(view);
    [nsView removeFromSuperview];
    [nsView release];
}

void releaseViews() {}

}  // namespace siann_test_plugin_gui
