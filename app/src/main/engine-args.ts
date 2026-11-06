// The siann-engine command line (architecture spec, "Process model"). Built for
// every launch, because a restart must name the window as it is then.

export interface EngineLaunch {
  session: string;
  platform: NodeJS.Platform;
  // BrowserWindow.getNativeWindowHandle(); null with no window.
  windowHandle: Buffer | null;
  // SIANN_OPEN_EDITOR: a plugin bundle whose editor the engine opens at launch.
  openEditor?: string;
}

// macOS cannot own windows across processes, and Linux has no use for it yet: only
// the Windows HWND goes to the engine, in decimal, whatever the pointer size.
function ownerWindow(platform: NodeJS.Platform, handle: Buffer | null): string | null {
  if (platform !== 'win32' || handle === null) return null;
  return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
}

export function engineArgs(launch: EngineLaunch): string[] {
  const args = ['--session', launch.session];
  const owner = ownerWindow(launch.platform, launch.windowHandle);
  if (owner !== null) args.push('--owner-window', owner);
  if (launch.openEditor) args.push('--open-editor', launch.openEditor);
  return args;
}
