#include "editor_platform.hpp"

#import <AppKit/AppKit.h>

namespace siann::host::editor_platform {

namespace {

int openEditors = 0;  // main thread only

}  // namespace

void startInBackground() {
    // NSApp is nil until something creates it: only JUCEApplication's own start does.
    [[NSApplication sharedApplication] setActivationPolicy:NSApplicationActivationPolicyAccessory];
}

void editorOpened() {
    if (openEditors++ == 0) {
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    }
}

void editorShown(std::uintptr_t view) {
    NSWindow* window = [reinterpret_cast<NSView*>(view) window];
    [window setCollectionBehavior:[window collectionBehavior] | NSWindowCollectionBehaviorFullScreenAuxiliary];
}

void editorRaised() {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [NSApp activateIgnoringOtherApps:YES];
#pragma clang diagnostic pop
}

void editorClosed() {
    if (--openEditors == 0) {
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    }
}

}  // namespace siann::host::editor_platform
