// The siann-engine command line (architecture spec, "Process model"). Built for
// every launch, because a restart must name the window as it is then.

import * as path from 'node:path';

import type { Backoff } from './supervisor';

export interface EngineLaunch {
  session: string;
  platform: NodeJS.Platform;
  // BrowserWindow.getNativeWindowHandle(); null with no window.
  windowHandle: Buffer | null;
  // The shell's restart backoff: an engine retries its device under it, because
  // the shell restarts only an engine that exits.
  backoff?: Pick<Backoff, 'initialMs' | 'maxMs' | 'resetAfterMs'>;
  // The JSON file the engine keeps plugin approvals in (--plugin-registry;
  // m5-plugin-registry): pluginRegistryFile(userData).
  pluginRegistry?: string;
  // SIANN_ENGINE_TEST_ARGS, only under SIANN_SHELL_TEST: the e2e tests' fake device.
  testArgs?: readonly string[];
}

// macOS cannot own windows across processes, and Linux has no use for it yet: only
// the Windows HWND goes to the engine, in decimal, whatever the pointer size.
function ownerWindow(platform: NodeJS.Platform, handle: Buffer | null): string | null {
  if (platform !== 'win32' || handle === null) return null;
  return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
}

// Approvals belong to the user, not to a session (Protocol v0 item 21).
export function pluginRegistryFile(userData: string): string {
  return path.join(userData, 'plugin-registry.json');
}

export function engineArgs(launch: EngineLaunch): string[] {
  const args = ['--session', launch.session];
  const owner = ownerWindow(launch.platform, launch.windowHandle);
  if (owner !== null) args.push('--owner-window', owner);
  if (launch.backoff) {
    const { initialMs, maxMs, resetAfterMs } = launch.backoff;
    args.push('--device-backoff', `${initialMs}:${maxMs}:${resetAfterMs}`);
  }
  if (launch.pluginRegistry) args.push('--plugin-registry', launch.pluginRegistry);
  if (launch.testArgs) args.push(...launch.testArgs);
  return args;
}
