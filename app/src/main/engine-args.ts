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
  // SIANN_ENGINE_TEST_ARGS (engineTestArgs), only under SIANN_SHELL_TEST: the e2e
  // tests' fake device and plugin directories.
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

// SIANN_ENGINE_TEST_ARGS: a JSON array of strings, which carries an argument with a
// space in it (a plugin build path), or plain words split at spaces. Text that
// starts with "[" and is not an array of strings throws: a test must not run with
// arguments it did not mean.
// The renderer argument of SIANN_TEST_CAPABILITIES (m5-ui-loop-click): the
// file's JSON, which the session client uses in place of the engine's
// engine.capabilities answer. Only under SIANN_SHELL_TEST=1; nothing otherwise.
// The sandboxed preload reads no files, so the JSON travels in the argument.
export const TEST_CAPABILITIES_ARG = '--siann-test-capabilities=';

export function testCapabilitiesArgs(env: Readonly<Record<string, string | undefined>>, readFile: (file: string) => string): string[] {
  const file = env.SIANN_TEST_CAPABILITIES;
  if (env.SIANN_SHELL_TEST !== '1' || !file) return [];
  const parsed: unknown = JSON.parse(readFile(file));
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { methods?: unknown }).methods)) {
    throw new Error(`SIANN_TEST_CAPABILITIES is not an engine.capabilities answer: ${file}`);
  }
  return [`${TEST_CAPABILITIES_ARG}${encodeURIComponent(JSON.stringify(parsed))}`];
}

// The renderer argument of SIANN_FIDELITY_ENVIRONMENT (m5-ui-alignment-chrome;
// UI redesign 10.2): the environment object of app/test/fidelity/manifest.json
// as JSON, whose device and engineAbout the session client answers in place
// of the engine's, so the status bar reads as the mockup's. Only under
// SIANN_SHELL_TEST=1; nothing otherwise. Text that is not a JSON object throws.
export const TEST_ENVIRONMENT_ARG = '--siann-test-environment=';

export function fidelityEnvironmentArgs(env: Readonly<Record<string, string | undefined>>): string[] {
  const text = env.SIANN_FIDELITY_ENVIRONMENT;
  if (env.SIANN_SHELL_TEST !== '1' || !text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`SIANN_FIDELITY_ENVIRONMENT is not JSON: ${text}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`SIANN_FIDELITY_ENVIRONMENT must be a JSON object: ${text}`);
  }
  return [`${TEST_ENVIRONMENT_ARG}${encodeURIComponent(JSON.stringify(parsed))}`];
}

export function engineTestArgs(text: string | undefined): string[] | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) return trimmed.split(' ').filter(Boolean);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`SIANN_ENGINE_TEST_ARGS is not a JSON array: ${text}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === 'string')) {
    throw new Error(`SIANN_ENGINE_TEST_ARGS must be an array of strings: ${text}`);
  }
  return parsed;
}
