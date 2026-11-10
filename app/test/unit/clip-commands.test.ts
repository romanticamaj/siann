// A finished timeline gesture becomes exactly one command.execute (spec,
// "Frontend"): place -> clip.place with a clp_<hex> id, move -> clip.move
// (trackId only when the track changed), trim -> clip.trim (the left handle
// adds a clip.move in the same list), delete -> clip.remove; each carries
// expectedRevision, the snapshot's revision. A gesture that changes nothing
// issues nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gestureCommand, newClipId } from '../../src/renderer/timeline/commands';
import { sampleSnapshot } from './support/timeline';

const snapshot = sampleSnapshot();

test('a placement issues one clip.place of the whole media with a client-chosen clp_ id', () => {
  const command = gestureCommand(snapshot, { kind: 'place', mediaId: 'med_sq', trackId: 'trk_a', position: 9600n }, () => 'clp_00ff00ff00ff00ff');
  assert.deepEqual(command, {
    expectedRevision: 'r7',
    commands: [
      {
        op: 'clip.place',
        clipId: 'clp_00ff00ff00ff00ff',
        trackId: 'trk_a',
        mediaId: 'med_sq',
        position: { domain: 'audio', value: '9600' },
        sourceStart: '0',
        length: '48000',
      },
    ],
  });
  // Before the timeline's start it lands at 0.
  const early = gestureCommand(snapshot, { kind: 'place', mediaId: 'med_si', trackId: 'trk_b', position: -50n });
  assert.equal((early!.commands[0] as { position: { value: string } }).position.value, '0');
  assert.match((early!.commands[0] as { clipId: string }).clipId, /^clp_[0-9a-f]{16}$/);
  assert.equal((early!.commands[0] as { length: string }).length, '96000');
});

test('clip ids are clp_ and 16 random hex digits, new each time', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newClipId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^clp_[0-9a-f]{16}$/);
});

test('a drop on the same track issues one clip.move without trackId', () => {
  const command = gestureCommand(snapshot, { kind: 'move', clipId: 'clp_1', deltaFrames: 1200n, trackId: 'trk_b' });
  assert.deepEqual(command, {
    expectedRevision: 'r7',
    commands: [{ op: 'clip.move', clipId: 'clp_1', position: { domain: 'audio', value: '6000' } }],
  });
  assert.ok(!('trackId' in command!.commands[0]!));
});

test('a drop on another track adds trackId', () => {
  const command = gestureCommand(snapshot, { kind: 'move', clipId: 'clp_1', deltaFrames: -10000n, trackId: 'trk_a' });
  assert.deepEqual(command, {
    expectedRevision: 'r7',
    commands: [{ op: 'clip.move', clipId: 'clp_1', position: { domain: 'audio', value: '0' }, trackId: 'trk_a' }],
  });
});

test('a drop where it started issues nothing', () => {
  assert.equal(gestureCommand(snapshot, { kind: 'move', clipId: 'clp_1', deltaFrames: 0n, trackId: 'trk_b' }), null);
  // Snapped back to where it was: also nothing.
  const atZero = gestureCommand(snapshot, { kind: 'move', clipId: 'clp_2', deltaFrames: -5n, trackId: 'trk_a' });
  assert.equal(atZero, null);
});

test('the right handle issues one clip.trim', () => {
  const command = gestureCommand(snapshot, { kind: 'trim', clipId: 'clp_3', edge: 'right', deltaFrames: -4000n });
  assert.deepEqual(command, {
    expectedRevision: 'r7',
    commands: [{ op: 'clip.trim', clipId: 'clp_3', sourceStart: '24000', length: '20000' }],
  });
  assert.equal(gestureCommand(snapshot, { kind: 'trim', clipId: 'clp_3', edge: 'right', deltaFrames: 5n }), null, 'already at the media end');
});

test('the left handle issues clip.trim and clip.move in one command.execute', () => {
  const command = gestureCommand(snapshot, { kind: 'trim', clipId: 'clp_3', edge: 'left', deltaFrames: 4000n });
  assert.deepEqual(command, {
    expectedRevision: 'r7',
    commands: [
      { op: 'clip.trim', clipId: 'clp_3', sourceStart: '28000', length: '20000' },
      { op: 'clip.move', clipId: 'clp_3', position: { domain: 'audio', value: '52000' } },
    ],
  });
});

test('delete issues one clip.remove', () => {
  assert.deepEqual(gestureCommand(snapshot, { kind: 'delete', clipId: 'clp_2' }), {
    expectedRevision: 'r7',
    commands: [{ op: 'clip.remove', clipId: 'clp_2' }],
  });
});

test('a gesture on an entity the snapshot does not hold issues nothing', () => {
  assert.equal(gestureCommand(snapshot, { kind: 'delete', clipId: 'clp_gone' }), null);
  assert.equal(gestureCommand(snapshot, { kind: 'move', clipId: 'clp_gone', deltaFrames: 1n, trackId: 'trk_a' }), null);
  assert.equal(gestureCommand(snapshot, { kind: 'place', mediaId: 'med_gone', trackId: 'trk_a', position: 0n }), null);
  assert.equal(gestureCommand(snapshot, { kind: 'place', mediaId: 'med_sq', trackId: 'trk_gone', position: 0n }), null);
});
