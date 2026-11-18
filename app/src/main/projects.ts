// The shell's record of projects and its launch choice (m5b-ui-project;
// architecture spec, "Process model", "Session at launch"). Pure over an
// injected file system, so the unit tests need no disk.
//
// The record is <userData>/recent-projects.json, {"schema": "siann.recent.v1",
// "recent": [<absolute bundle path>, ...]}: at most RECENT_MAX entries,
// newest first, deduplicated; the first is the bundle opened last. It lives in
// user data, never in a session. A malformed file, another schema and an entry
// that is not an absolute path are ignored; entries whose session.json is gone
// are dropped when the record is read.
//
// The bundle the engine is launched on, in this order: SIANN_SESSION_DIR
// (tests) gives <dir>/Untitled.siann and no start view; else the bundle opened
// last, when its session.json exists; else, with no record at all, the M0
// default <userData>/sessions/Untitled.siann when it exists, adopted as the
// last bundle; else the scratch bundle <userData>/start.siann with the
// renderer's start view. The scratch bundle is never recent.

import * as path from 'node:path';

export const RECENT_SCHEMA = 'siann.recent.v1';
export const RECENT_MAX = 10;
export const RECENT_FILE = 'recent-projects.json';
export const SCRATCH_BUNDLE = 'start.siann';
// The bundle the shell passed before m5b-ui-project, under userData.
const M0_BUNDLE = path.join('sessions', 'Untitled.siann');
const SESSION_FILE = 'session.json';
const BUNDLE_SUFFIX = '.siann';

export interface ProjectsFs {
  // The file's text, or null when it cannot be read.
  readText(file: string): string | null;
  writeText(file: string, text: string): void;
  isFile(file: string): boolean;
}

export interface LaunchChoice {
  readonly bundle: string;
  // The renderer shows the start view (the bundle is the scratch one).
  readonly startView: boolean;
  // The recent list as it stands after the choice.
  readonly recent: string[];
  // The record must be written (an entry was dropped or the M0 bundle adopted).
  readonly write: boolean;
}

// The path as one entry: resolved, without a trailing separator.
function normal(bundle: string): string {
  const resolved = path.resolve(bundle);
  const root = path.parse(resolved).root;
  return resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
}

// Windows and macOS file systems compare names without case by default.
function same(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

export function isBundlePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value) && !value.includes('\0');
}

// The bundle at the front, once; at most RECENT_MAX. The scratch bundle, when
// named, is never added.
export function addRecent(list: readonly string[], bundle: string, scratch?: string, platform: NodeJS.Platform = process.platform): string[] {
  const entry = normal(bundle);
  if (scratch !== undefined && same(entry, normal(scratch), platform)) return [...list];
  return [entry, ...list.filter((other) => !same(other, entry, platform))].slice(0, RECENT_MAX);
}

export function parseRecent(text: string | null, platform: NodeJS.Platform = process.platform): string[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const record = parsed as { schema?: unknown; recent?: unknown };
  if (record.schema !== RECENT_SCHEMA || !Array.isArray(record.recent)) return [];
  const out: string[] = [];
  for (const entry of record.recent) {
    if (!isBundlePath(entry)) continue;
    const bundle = normal(entry);
    if (!out.some((other) => same(other, bundle, platform))) out.push(bundle);
  }
  return out.slice(0, RECENT_MAX);
}

export function serializeRecent(list: readonly string[]): string {
  return `${JSON.stringify({ schema: RECENT_SCHEMA, recent: list }, null, 2)}\n`;
}

export function bundleExists(bundle: string, fs: Pick<ProjectsFs, 'isFile'>): boolean {
  return fs.isFile(path.join(bundle, SESSION_FILE));
}

export function liveRecent(list: readonly string[], fs: Pick<ProjectsFs, 'isFile'>): string[] {
  return list.filter((bundle) => bundleExists(bundle, fs));
}

// "Night Drive" for .../Night Drive.siann.
export function bundleName(bundle: string): string {
  const base = path.basename(bundle);
  return base.toLowerCase().endsWith(BUNDLE_SUFFIX) && base.length > BUNDLE_SUFFIX.length ? base.slice(0, -BUNDLE_SUFFIX.length) : base;
}

export function recentFile(userData: string): string {
  return path.join(userData, RECENT_FILE);
}

export function scratchBundle(userData: string): string {
  return path.join(userData, SCRATCH_BUNDLE);
}

export function launchSession(options: { sessionDir?: string; userData: string; fs: ProjectsFs; platform?: NodeJS.Platform }): LaunchChoice {
  const { fs, userData } = options;
  const platform = options.platform ?? process.platform;
  const text = fs.readText(recentFile(userData));
  const stored = parseRecent(text, platform);
  const live = liveRecent(stored, fs);
  if (options.sessionDir) {
    return { bundle: path.join(options.sessionDir, 'Untitled.siann'), startView: false, recent: live, write: false };
  }
  const changed = live.length !== stored.length;
  const last = stored[0];
  if (last !== undefined && bundleExists(last, fs)) return { bundle: last, startView: false, recent: live, write: changed };
  if (text === null) {
    const old = path.join(userData, M0_BUNDLE);
    if (bundleExists(old, fs)) return { bundle: old, startView: false, recent: [old], write: true };
  }
  return { bundle: scratchBundle(userData), startView: true, recent: live, write: changed };
}
