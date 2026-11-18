// The shell's record of projects and its launch choice (m5b-ui-project;
// architecture spec, "Process model", "Session at launch"): the recent list in
// <userData>/recent-projects.json (siann.recent.v1: at most ten absolute
// bundle paths, newest first, deduplicated, gone entries dropped) and the
// bundle the engine is launched on: SIANN_SESSION_DIR, else the last bundle,
// else the adopted M0 default, else the scratch bundle with the start view.
// Pure, over an in-memory file system.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  RECENT_FILE,
  RECENT_MAX,
  RECENT_SCHEMA,
  SCRATCH_BUNDLE,
  addRecent,
  bundleName,
  launchSession,
  liveRecent,
  parseRecent,
  serializeRecent,
  type ProjectsFs,
} from '../../src/main/projects';

const ROOT = path.resolve('/siann-projects-test');
const at = (...parts: string[]) => path.join(ROOT, ...parts);

class MemoryFs implements ProjectsFs {
  readonly files = new Map<string, string>();
  readText(file: string): string | null {
    return this.files.get(file) ?? null;
  }
  writeText(file: string, text: string): void {
    this.files.set(file, text);
  }
  isFile(file: string): boolean {
    return this.files.has(file);
  }
  // A bundle on disk is a directory with a session.json.
  bundle(dir: string): string {
    this.files.set(path.join(dir, 'session.json'), '{}');
    return dir;
  }
}

test('the recent list adds newest first, deduplicates and keeps ten', () => {
  let list: string[] = [];
  for (let i = 1; i <= 12; i += 1) list = addRecent(list, at(`p${i}.siann`));
  assert.equal(RECENT_MAX, 10);
  assert.equal(list.length, 10);
  assert.equal(list[0], at('p12.siann'));
  assert.equal(list[9], at('p3.siann'));
  // Opened again: it moves to the front, once.
  list = addRecent(list, at('p5.siann'));
  assert.equal(list[0], at('p5.siann'));
  assert.equal(list.filter((p) => p === at('p5.siann')).length, 1);
  assert.equal(list.length, 10);
  // The same folder written another way is one entry.
  list = addRecent(list, `${at('p7.siann')}${path.sep}`);
  assert.equal(list[0], at('p7.siann'));
  assert.equal(list.filter((p) => p === at('p7.siann')).length, 1);
});

test('the record round-trips; a malformed file, another schema and relative or non-string entries are ignored', () => {
  const list = [at('b.siann'), at('a.siann')];
  const text = serializeRecent(list);
  assert.deepEqual(JSON.parse(text), { schema: RECENT_SCHEMA, recent: list });
  assert.deepEqual(parseRecent(text), list);
  assert.deepEqual(parseRecent(null), []);
  assert.deepEqual(parseRecent('{not json'), []);
  assert.deepEqual(parseRecent(JSON.stringify({ schema: 'siann.recent.v0', recent: list })), []);
  assert.deepEqual(parseRecent(JSON.stringify({ schema: RECENT_SCHEMA, recent: 'x' })), []);
  assert.deepEqual(parseRecent(JSON.stringify({ schema: RECENT_SCHEMA, recent: [at('a.siann'), 'relative.siann', 7, null, at('a.siann')] })), [at('a.siann')]);
  // More than ten in the file: the first ten.
  const many = Array.from({ length: 14 }, (_, i) => at(`m${i}.siann`));
  assert.deepEqual(parseRecent(JSON.stringify({ schema: RECENT_SCHEMA, recent: many })), many.slice(0, 10));
});

test('gone entries are dropped and a bundle is named by its folder', () => {
  const fs = new MemoryFs();
  const kept = fs.bundle(at('Kept.siann'));
  assert.deepEqual(liveRecent([at('Gone.siann'), kept], fs), [kept]);
  assert.equal(bundleName(at('Night Drive.siann')), 'Night Drive');
  assert.equal(bundleName(at('Folder')), 'Folder');
});

test('launchSession: SIANN_SESSION_DIR wins, with no start view and the record untouched', () => {
  const fs = new MemoryFs();
  fs.writeText(at('user', RECENT_FILE), serializeRecent([fs.bundle(at('Last.siann'))]));
  const choice = launchSession({ sessionDir: at('tests'), userData: at('user'), fs });
  assert.deepEqual(choice, { bundle: at('tests', 'Untitled.siann'), startView: false, recent: [at('Last.siann')], write: false });
});

test('launchSession: the bundle opened last, when its session.json exists; gone entries leave the record', () => {
  const fs = new MemoryFs();
  const last = fs.bundle(at('Last.siann'));
  const older = fs.bundle(at('Older.siann'));
  fs.writeText(at('user', RECENT_FILE), serializeRecent([last, at('Gone.siann'), older]));
  assert.deepEqual(launchSession({ userData: at('user'), fs }), { bundle: last, startView: false, recent: [last, older], write: true });
});

test('launchSession: no record but the M0 default exists: it is adopted as the last bundle', () => {
  const fs = new MemoryFs();
  const old = fs.bundle(at('user', 'sessions', 'Untitled.siann'));
  assert.deepEqual(launchSession({ userData: at('user'), fs }), { bundle: old, startView: false, recent: [old], write: true });
  // A record, even an empty one, means the default was seen before: not adopted again.
  fs.writeText(at('user', RECENT_FILE), serializeRecent([]));
  assert.deepEqual(launchSession({ userData: at('user'), fs }), { bundle: at('user', SCRATCH_BUNDLE), startView: true, recent: [], write: false });
});

test('launchSession: no bundle, or the last one gone: the scratch bundle with the start view, never recent', () => {
  const fs = new MemoryFs();
  assert.equal(SCRATCH_BUNDLE, 'start.siann');
  assert.deepEqual(launchSession({ userData: at('user'), fs }), { bundle: at('user', 'start.siann'), startView: true, recent: [], write: false });
  // The last bundle deleted: the start view, even though an older one exists; the record drops it.
  const older = fs.bundle(at('Older.siann'));
  fs.writeText(at('user', RECENT_FILE), serializeRecent([at('Deleted.siann'), older]));
  assert.deepEqual(launchSession({ userData: at('user'), fs }), { bundle: at('user', 'start.siann'), startView: true, recent: [older], write: true });
  // The scratch bundle is never added, even when a record names it.
  assert.deepEqual(addRecent([older], at('user', 'start.siann'), at('user', 'start.siann')), [older]);
});
