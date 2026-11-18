// Nudge (m5b-ui-edit-more; UI redesign spec 3.2 "Editing", 3.6): Ctrl+Left
// and Ctrl+Right move the selection by a step (clip.move, the whole
// selection stopping at the timeline's start); Alt+Left and Alt+Shift+Right
// move the start (clip.trim and clip.move together, the audio staying where
// it is, clamped at the media's start, the timeline's start and one frame of
// length); Alt+Shift+Left and Alt+Right move the end (clip.trim, clamped to
// the media's length and one frame). One list for the selection.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nudgeCommand } from '../../src/renderer/timeline/edit-commands';
import { applyClipCommands } from './support/apply';
import { clip, media, snapshotOf, track } from './support/timeline';

// med_long is 100000 frames. clp_a at 10000 (source 5000, 20000 long),
// clp_b at 50000 on trk_b (source 0, 30000 long), clp_end at 60000 using the
// media to its end (source 70000, 30000 long).
function session() {
  return snapshotOf(
    ['trk_a', 'trk_b'],
    [track('trk_a'), track('trk_b')],
    [media('med_long', '100000')],
    [
      clip('clp_a', 'trk_a', 'med_long', '10000', '5000', '20000'),
      clip('clp_b', 'trk_b', 'med_long', '50000', '0', '30000'),
      clip('clp_end', 'trk_a', 'med_long', '60000', '70000', '30000'),
    ],
  );
}

const pos = (c: { position: { value: string } }) => c.position.value;

test('position: clip.move of every selected clip by the step, right or left', () => {
  const right = nudgeCommand(session(), ['clp_a', 'clp_b'], 4000n, 'position');
  assert.deepEqual(right, {
    expectedRevision: 'r7',
    commands: [
      { op: 'clip.move', clipId: 'clp_a', position: { domain: 'audio', value: '14000' } },
      { op: 'clip.move', clipId: 'clp_b', position: { domain: 'audio', value: '54000' } },
    ],
  });
  const left = nudgeCommand(session(), ['clp_a', 'clp_b'], -4000n, 'position');
  assert.deepEqual(left!.commands.map((c) => (c.position as { value: string }).value), ['6000', '46000']);
});

test('position: the whole selection stops at the timeline\'s start', () => {
  // clp_a can go 10000 left; the selection goes no further, clp_b keeps the distance.
  const left = nudgeCommand(session(), ['clp_a', 'clp_b'], -24000n, 'position');
  assert.deepEqual(left!.commands.map((c) => (c.position as { value: string }).value), ['0', '40000']);
  const atZero = snapshotOf(['trk_a'], [track('trk_a')], [media('med_long', '100000')], [clip('clp_z', 'trk_a', 'med_long', '0', '0', '1000')]);
  assert.equal(nudgeCommand(atZero, ['clp_z'], -24000n, 'position'), null, 'nothing moves: nothing is sent');
});

test('start left and right: clip.trim and clip.move together, the audio staying where it is', () => {
  const snapshot = session();
  const left = nudgeCommand(snapshot, ['clp_a'], 4000n, 'startLeft');
  assert.deepEqual(left!.commands, [
    { op: 'clip.trim', clipId: 'clp_a', sourceStart: '1000', length: '24000' },
    { op: 'clip.move', clipId: 'clp_a', position: { domain: 'audio', value: '6000' } },
  ]);
  const right = nudgeCommand(snapshot, ['clp_a'], 4000n, 'startRight');
  const moved = applyClipCommands(snapshot, right!.commands).get('clp_a')!;
  assert.deepEqual([pos(moved), moved.sourceStart, moved.length], ['14000', '9000', '16000']);
  // The end of the clip on the timeline stays put either way: the audio does not move.
  const after = applyClipCommands(snapshot, left!.commands).get('clp_a')!;
  assert.equal(BigInt(pos(after)) - BigInt(after.sourceStart), 10000n - 5000n);
});

test('start nudges are clamped at sourceStart 0, at the timeline\'s start and at one frame of length', () => {
  const snapshot = session();
  // clp_a's source starts 5000 in: Alt+Left by 8000 goes only 5000.
  const left = applyClipCommands(snapshot, nudgeCommand(snapshot, ['clp_a'], 8000n, 'startLeft')!.commands).get('clp_a')!;
  assert.deepEqual([pos(left), left.sourceStart, left.length], ['5000', '0', '25000']);
  // clp_b's source is at 0: nothing to do.
  assert.equal(nudgeCommand(snapshot, ['clp_b'], 8000n, 'startLeft'), null);
  // Right by more than the length leaves one frame.
  const right = applyClipCommands(snapshot, nudgeCommand(snapshot, ['clp_a'], 50000n, 'startRight')!.commands).get('clp_a')!;
  assert.deepEqual([pos(right), right.length], ['29999', '1']);
});

test('end left and right: clip.trim, clamped to the media\'s length and one frame', () => {
  const snapshot = session();
  assert.deepEqual(nudgeCommand(snapshot, ['clp_a'], 4000n, 'endRight')!.commands, [{ op: 'clip.trim', clipId: 'clp_a', sourceStart: '5000', length: '24000' }]);
  assert.deepEqual(nudgeCommand(snapshot, ['clp_a'], 4000n, 'endLeft')!.commands, [{ op: 'clip.trim', clipId: 'clp_a', sourceStart: '5000', length: '16000' }]);
  // clp_end ends at the media's end: Alt+Right does nothing.
  assert.equal(nudgeCommand(snapshot, ['clp_end'], 4000n, 'endRight'), null);
  // Further than the media allows: up to its end.
  assert.deepEqual(nudgeCommand(snapshot, ['clp_b'], 90000n, 'endRight')!.commands, [{ op: 'clip.trim', clipId: 'clp_b', sourceStart: '0', length: '100000' }]);
  assert.deepEqual(nudgeCommand(snapshot, ['clp_a'], 90000n, 'endLeft')!.commands, [{ op: 'clip.trim', clipId: 'clp_a', sourceStart: '5000', length: '1' }]);
});

test('one list for the selection, the step\'s sign taken from the direction for the edges', () => {
  const both = nudgeCommand(session(), ['clp_a', 'clp_b', 'clp_end'], 2000n, 'endRight');
  assert.ok(both);
  assert.deepEqual(both.commands.map((c) => c.clipId), ['clp_a', 'clp_b'], 'clp_end cannot grow');
  // A negative step for an edge nudge means the same as its magnitude.
  assert.deepEqual(nudgeCommand(session(), ['clp_a'], -2000n, 'endRight'), nudgeCommand(session(), ['clp_a'], 2000n, 'endRight'));
  assert.equal(nudgeCommand(session(), [], 2000n, 'position'), null);
  assert.equal(nudgeCommand(session(), ['clp_a'], 0n, 'position'), null);
  assert.equal(nudgeCommand(session(), ['clp_gone'], 2000n, 'endLeft'), null);
});
