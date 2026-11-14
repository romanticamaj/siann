// Cubase's editing as command lists (m5-ui-edit-basics; UI redesign spec 3.2,
// 3.3 and P1-8): split, split at the cursor, duplicate, copy, a selection
// move with the constrained axis, clip gain from the volume control, and M,
// S and Shift+Delete over the selected tracks. Each builder is a pure
// function of a Snapshot and returns one TimelineCommand (one
// command.execute, one revision) carrying the snapshot's revision, or null
// when there is nothing to do or an entity is unknown. The engine has no
// overlap rule, so these are compositions of clip.place, clip.trim,
// clip.move, clip.set_gain, track.set_mute/solo and track.remove.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GAIN_MAX_MILLI_DB,
  GAIN_MIN_MILLI_DB,
  clipGainCommand,
  constrainAxis,
  copyCommand,
  duplicateCommand,
  gainFromDrag,
  moveSelectionCommand,
  removeTracksCommand,
  splitAtCursor,
  splitCommand,
  trackMuteCommand,
  trackSoloCommand,
} from '../../src/renderer/timeline/edit-commands';
import { ticksToFrames } from '../../src/renderer/timeline/musical-time';
import type { ClipEntity } from '../../src/renderer/model/document';
import { clip, media, snapshotOf, track } from './support/timeline';

// Fresh ids in order, so the expected lists can name them.
function ids(...list: string[]): () => string {
  let next = 0;
  return () => list[next++] ?? `clp_extra${next}`;
}

// 120 BPM at 48 kHz: a bar is 96000 frames, bar 3 starts at frame 192000.
// clp_long starts at bar 2 with a source offset of half a second.
function editSnapshot() {
  const long = { ...clip('clp_long', 'trk_a', 'med_long', '96000', '24000', '192000'), gainMilliDb: -3000 };
  return snapshotOf(
    ['trk_a', 'trk_b', 'trk_c'],
    [track('trk_a'), { ...track('trk_b'), mute: true }, track('trk_c')],
    [media('med_long', '480000'), media('med_sq', '48000')],
    [
      long,
      clip('clp_b1', 'trk_b', 'med_sq', '144000', '0', '48000'),
      clip('clp_c1', 'trk_c', 'med_sq', '0', '0', '48000'),
      clip('clp_c2', 'trk_c', 'med_sq', '240000', '0', '24000'),
    ],
  );
}

const BAR_3 = BigInt(ticksToFrames(2 * 7680, [], 48000));

test('bar 3 at 120 BPM and 48 kHz is frame 192000', () => {
  assert.equal(BAR_3, 192000n);
});

test('a split at bar 3 of a clip with a source offset keeps its audio continuous', () => {
  const snapshot = editSnapshot();
  const command = splitCommand(snapshot, ['clp_long'], BAR_3, ids('clp_right'));
  assert.deepEqual(command, {
    expectedRevision: 'r7',
    commands: [
      { op: 'clip.trim', clipId: 'clp_long', sourceStart: '24000', length: '96000' },
      {
        op: 'clip.place',
        clipId: 'clp_right',
        trackId: 'trk_a',
        mediaId: 'med_long',
        position: { domain: 'audio', value: '192000' },
        sourceStart: '120000',
        length: '96000',
        gainMilliDb: -3000,
      },
    ],
  });
  const left = command!.commands[0] as { sourceStart: string; length: string };
  const right = command!.commands[1] as { sourceStart: string; length: string };
  // The right piece starts in the media where the left one ends.
  assert.equal(BigInt(right.sourceStart), BigInt(left.sourceStart) + BigInt(left.length));
  assert.equal(BigInt(left.length) + BigInt(right.length), 192000n);
});

test('a split frame at or outside a clip\'s edges splits nothing there; no clip hit is null', () => {
  const snapshot = editSnapshot();
  assert.equal(splitCommand(snapshot, ['clp_long'], 96000n), null, 'at the start');
  assert.equal(splitCommand(snapshot, ['clp_long'], 288000n), null, 'at the end');
  assert.equal(splitCommand(snapshot, ['clp_long'], 10n), null, 'before it');
  assert.equal(splitCommand(snapshot, ['clp_gone'], 100000n), null, 'unknown');
  // Two clips named, only one under the frame: one pair of commands.
  const command = splitCommand(snapshot, ['clp_long', 'clp_c1'], 100000n, ids('clp_r'));
  assert.deepEqual(command!.commands.map((c) => [c.op, c.clipId]), [
    ['clip.trim', 'clp_long'],
    ['clip.place', 'clp_r'],
  ]);
});

test('a music-domain clip is not split', () => {
  const base = editSnapshot();
  const music: ClipEntity = { ...clip('clp_m', 'trk_a', 'med_sq', '0', '0', '48000'), position: { domain: 'music', value: '0' } };
  const snapshot = snapshotOf(base.trackOrder, base.tracks, base.media, [...base.clips, music]);
  assert.equal(splitCommand(snapshot, ['clp_m'], 10n), null);
});

test('split at the cursor: the selected clips, or every audio clip under the cursor when nothing is selected, in one list', () => {
  const snapshot = editSnapshot();
  // clp_long (96000-288000) and clp_b1 (144000-192000) are under 150000.
  const selected = splitAtCursor(snapshot, ['clp_b1'], 150000n, ids('clp_x'));
  assert.deepEqual(selected!.commands.map((c) => [c.op, c.clipId]), [
    ['clip.trim', 'clp_b1'],
    ['clip.place', 'clp_x'],
  ]);
  const all = splitAtCursor(snapshot, [], 150000n, ids('clp_x', 'clp_y'));
  assert.equal(all!.expectedRevision, 'r7');
  assert.deepEqual(all!.commands.map((c) => [c.op, c.clipId]), [
    ['clip.trim', 'clp_long'],
    ['clip.place', 'clp_x'],
    ['clip.trim', 'clp_b1'],
    ['clip.place', 'clp_y'],
  ]);
  // A selection the cursor does not cross: nothing, even though other clips are there.
  assert.equal(splitAtCursor(snapshot, ['clp_c1'], 150000n), null);
  assert.equal(splitAtCursor(snapshot, [], 50_000_000n), null);
});

test('duplicate places one copy per clip right after the selection, keeping their offsets, in one list', () => {
  const snapshot = editSnapshot();
  // clp_b1 144000-192000 on trk_b and clp_c2 240000-264000 on trk_c: span 120000.
  const command = duplicateCommand(snapshot, ['clp_b1', 'clp_c2'], ids('clp_d1', 'clp_d2'));
  assert.deepEqual(command, {
    expectedRevision: 'r7',
    commands: [
      {
        op: 'clip.place',
        clipId: 'clp_d1',
        trackId: 'trk_b',
        mediaId: 'med_sq',
        position: { domain: 'audio', value: '264000' },
        sourceStart: '0',
        length: '48000',
        gainMilliDb: 0,
      },
      {
        op: 'clip.place',
        clipId: 'clp_d2',
        trackId: 'trk_c',
        mediaId: 'med_sq',
        position: { domain: 'audio', value: '360000' },
        sourceStart: '0',
        length: '24000',
        gainMilliDb: 0,
      },
    ],
  });
  // One clip: directly after itself, with its source offset and gain.
  const one = duplicateCommand(snapshot, ['clp_long'], ids('clp_d'));
  assert.deepEqual(one!.commands[0], {
    op: 'clip.place',
    clipId: 'clp_d',
    trackId: 'trk_a',
    mediaId: 'med_long',
    position: { domain: 'audio', value: '288000' },
    sourceStart: '24000',
    length: '192000',
    gainMilliDb: -3000,
  });
  assert.equal(duplicateCommand(snapshot, []), null);
  assert.equal(duplicateCommand(snapshot, ['clp_gone']), null);
});

test('copy places each clip by the delta (and lanes), leaving the originals', () => {
  const snapshot = editSnapshot();
  const command = copyCommand(snapshot, ['clp_b1', 'clp_c1'], 24000n, 0, ids('clp_k1', 'clp_k2'));
  assert.deepEqual(command!.commands.map((c) => [c.op, c.clipId, c.trackId, (c.position as { value: string }).value]), [
    ['clip.place', 'clp_k1', 'trk_b', '168000'],
    ['clip.place', 'clp_k2', 'trk_c', '24000'],
  ]);
  assert.ok(command!.commands.every((c) => c.op === 'clip.place'), 'no move, no remove');
  // One lane up: trk_b -> trk_a, trk_c -> trk_b.
  const up = copyCommand(snapshot, ['clp_b1', 'clp_c1'], 0n, -1, ids('clp_k1', 'clp_k2'));
  assert.deepEqual(up!.commands.map((c) => c.trackId), ['trk_a', 'trk_b']);
  // A zero delta is still a copy: whether the pointer moved is the canvas's decision.
  const still = copyCommand(snapshot, ['clp_c1'], 0n, 0, ids('clp_k'));
  assert.equal((still!.commands[0]!.position as { value: string }).value, '0');
  // Never before the timeline's start: the selection keeps its offsets.
  const early = copyCommand(snapshot, ['clp_b1', 'clp_c1'], -50000n, 0, ids('clp_k1', 'clp_k2'));
  assert.deepEqual(early!.commands.map((c) => (c.position as { value: string }).value), ['144000', '0']);
  assert.equal(copyCommand(snapshot, ['clp_gone'], 10n, 0), null);
});

test('a selection move is one list of clip.move, trackId only where the lane changed', () => {
  const snapshot = editSnapshot();
  const command = moveSelectionCommand(snapshot, ['clp_b1', 'clp_c2'], 12000n, 0);
  assert.deepEqual(command, {
    expectedRevision: 'r7',
    commands: [
      { op: 'clip.move', clipId: 'clp_b1', position: { domain: 'audio', value: '156000' } },
      { op: 'clip.move', clipId: 'clp_c2', position: { domain: 'audio', value: '252000' } },
    ],
  });
  const down = moveSelectionCommand(snapshot, ['clp_long', 'clp_b1'], 0n, 1);
  assert.deepEqual(down!.commands, [
    { op: 'clip.move', clipId: 'clp_long', position: { domain: 'audio', value: '96000' }, trackId: 'trk_b' },
    { op: 'clip.move', clipId: 'clp_b1', position: { domain: 'audio', value: '144000' }, trackId: 'trk_c' },
  ]);
  // A lane change past the last lane is held at the edge for the whole selection.
  const far = moveSelectionCommand(snapshot, ['clp_long', 'clp_b1'], 0n, 5);
  assert.deepEqual(far!.commands.map((c) => c.trackId), ['trk_b', 'trk_c']);
  assert.equal(moveSelectionCommand(snapshot, ['clp_b1'], 0n, 0), null, 'nothing moved');
  assert.equal(moveSelectionCommand(snapshot, ['clp_gone'], 10n, 0), null);
});

test('the constrained axis is the dominant direction once the pointer is 4 px away; x keeps the lane, y the position', () => {
  assert.equal(constrainAxis(2, 3), null);
  assert.equal(constrainAxis(10, 3), 'x');
  assert.equal(constrainAxis(-10, 30), 'y');
  assert.equal(constrainAxis(0, -5), 'y');
  assert.equal(constrainAxis(4, 0), 'x');
});

test('clip gain: one clip.set_gain, nothing when unchanged; the drag is 100 mdB per px, 10 with Shift, within -60 to +6 dB', () => {
  const snapshot = editSnapshot();
  assert.deepEqual(clipGainCommand(snapshot, 'clp_long', -1500), {
    expectedRevision: 'r7',
    commands: [{ op: 'clip.set_gain', clipId: 'clp_long', gainMilliDb: -1500 }],
  });
  assert.equal(clipGainCommand(snapshot, 'clp_long', -3000), null);
  assert.equal(clipGainCommand(snapshot, 'clp_gone', 0), null);
  // Up (a negative dy) is louder.
  assert.equal(gainFromDrag(-3000, -15, false), -1500);
  assert.equal(gainFromDrag(-3000, 15, false), -4500);
  assert.equal(gainFromDrag(-3000, -15, true), -2850);
  assert.equal(gainFromDrag(0, -1000, false), GAIN_MAX_MILLI_DB);
  assert.equal(gainFromDrag(0, 10_000, false), GAIN_MIN_MILLI_DB);
  assert.equal(GAIN_MAX_MILLI_DB, 6000);
  assert.equal(GAIN_MIN_MILLI_DB, -60000);
});

test('M and S set every selected track to the opposite of the primary\'s state, in one list', () => {
  const snapshot = editSnapshot();
  assert.deepEqual(trackMuteCommand(snapshot, ['trk_a']), {
    expectedRevision: 'r7',
    commands: [{ op: 'track.set_mute', trackId: 'trk_a', mute: true }],
  });
  // trk_b is muted: unmuting it leaves the unmuted trk_c alone.
  assert.deepEqual(trackMuteCommand(snapshot, ['trk_b', 'trk_c'])!.commands, [{ op: 'track.set_mute', trackId: 'trk_b', mute: false }]);
  assert.deepEqual(trackMuteCommand(snapshot, ['trk_a', 'trk_b'])!.commands, [{ op: 'track.set_mute', trackId: 'trk_a', mute: true }]);
  assert.deepEqual(trackSoloCommand(snapshot, ['trk_a', 'trk_c'])!.commands, [
    { op: 'track.set_solo', trackId: 'trk_a', solo: true },
    { op: 'track.set_solo', trackId: 'trk_c', solo: true },
  ]);
  assert.equal(trackMuteCommand(snapshot, []), null);
  assert.equal(trackSoloCommand(snapshot, ['trk_gone']), null);
});

test('Shift+Delete removes the selected tracks in one list', () => {
  const snapshot = editSnapshot();
  assert.deepEqual(removeTracksCommand(snapshot, ['trk_b', 'trk_c']), {
    expectedRevision: 'r7',
    commands: [
      { op: 'track.remove', trackId: 'trk_b' },
      { op: 'track.remove', trackId: 'trk_c' },
    ],
  });
  assert.deepEqual(removeTracksCommand(snapshot, ['trk_b', 'trk_gone'])!.commands, [{ op: 'track.remove', trackId: 'trk_b' }]);
  assert.equal(removeTracksCommand(snapshot, []), null);
  assert.equal(removeTracksCommand(snapshot, ['trk_gone']), null);
});
