// The track list's commands (m5-ui-arrange; UI redesign spec 3.3): the T key
// or the + button adds a track with track.add (a client-chosen trk_ id of 16
// lowercase hex digits, as clip ids are chosen, two channels, and the
// catalog's default name with the next free number); a rename sends
// track.rename, and nothing when the name is empty or unchanged. Every
// command list carries the snapshot's revision. Framework-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { translator } from '../../src/renderer/i18n/t';
import { addTrackCommand, newTrackId, nextTrackName, renameTrackCommand } from '../../src/renderer/timeline/track-commands';
import { sampleSnapshot, snapshotOf, track } from './support/timeline';

const name = (n: number) => translator('en')('track.defaultName', { n: String(n) });

test('a new track id is trk_ and 16 lowercase hex digits, different each time', () => {
  const ids = new Set(Array.from({ length: 20 }, () => newTrackId()));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, /^trk_[0-9a-f]{16}$/);
});

test('the default name takes the next free number', () => {
  assert.equal(name(1), 'Audio 1');
  const empty = snapshotOf([], [], [], []);
  assert.equal(nextTrackName(empty, name), 'Audio 1');
  const taken = snapshotOf(['a', 'b'], [{ ...track('a'), name: 'Audio 1' }, { ...track('b'), name: 'Audio 3' }], [], []);
  assert.equal(nextTrackName(taken, name), 'Audio 2');
  const zh = (n: number) => translator('zh-Hant')('track.defaultName', { n: String(n) });
  assert.notEqual(nextTrackName(empty, zh), 'Audio 1');
});

test('track.add with the id, the name, two channels and the snapshot revision', () => {
  const snapshot = sampleSnapshot();
  const command = addTrackCommand(snapshot, 'Audio 1', () => 'trk_00112233445566ff');
  assert.deepEqual(command, {
    expectedRevision: 'r7',
    commands: [{ op: 'track.add', trackId: 'trk_00112233445566ff', name: 'Audio 1', channels: 2 }],
  });
  assert.match(String((addTrackCommand(snapshot, 'Audio 1').commands[0] as { trackId: string }).trackId), /^trk_[0-9a-f]{16}$/);
});

test('track.rename, trimmed; nothing for an empty or unchanged name or an unknown track', () => {
  const snapshot = sampleSnapshot();
  assert.deepEqual(renameTrackCommand(snapshot, 'trk_a', '  Bass  '), {
    expectedRevision: 'r7',
    commands: [{ op: 'track.rename', trackId: 'trk_a', name: 'Bass' }],
  });
  assert.equal(renameTrackCommand(snapshot, 'trk_a', 'trk_a'), null, 'unchanged');
  assert.equal(renameTrackCommand(snapshot, 'trk_a', '   '), null, 'empty');
  assert.equal(renameTrackCommand(snapshot, 'trk_a', ''), null, 'empty');
  assert.equal(renameTrackCommand(snapshot, 'trk_gone', 'X'), null, 'unknown track');
});
