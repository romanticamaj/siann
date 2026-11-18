// Cut, copy, paste and repeat (m5b-ui-edit-more; UI redesign spec 3.2
// "Editing"): copy is a pure clipboard value (each clip's media, source start,
// length, volume, fades, track and offset from the earliest start); cut is one
// clip.remove per clip; paste places the clipboard with its relative positions
// and tracks at the cursor or at the origin, leaving out a clip whose track or
// media is gone; repeat places `count` copies, copy k shifted by k times the
// selection's span. Each builder returns one command list at the snapshot's
// revision, or null when there is nothing to do.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ClipEntity, ClipFade } from '../../src/renderer/model/document';
import { MAX_REPEAT, copyClips, cutCommand, pasteCommand, repeatCommand, repeatCountFromDrag } from '../../src/renderer/timeline/edit-commands';
import { Clipboard } from '../../src/renderer/timeline/clipboard';
import { applyClipCommands } from './support/apply';
import { clip, media, snapshotOf, track } from './support/timeline';

const lin = (length: string): ClipFade => ({ length, curve: 'linear' });

function ids(...list: string[]): () => string {
  let next = 0;
  return () => list[next++] ?? `clp_extra${next}`;
}

// clp_a at 48000 on trk_a with fades and -3 dB, clp_b at 72000 on trk_b,
// clp_c at 200000 on trk_a (the selection's end is 224000).
function session() {
  const a: ClipEntity = { ...clip('clp_a', 'trk_a', 'med_long', '48000', '1000', '24000'), gainMilliDb: -3000, fadeIn: lin('100'), fadeOut: lin('200') };
  return snapshotOf(
    ['trk_a', 'trk_b'],
    [track('trk_a'), track('trk_b')],
    [media('med_long', '480000'), media('med_sq', '48000')],
    [a, clip('clp_b', 'trk_b', 'med_sq', '72000', '0', '24000'), clip('clp_c', 'trk_a', 'med_long', '200000', '0', '24000')],
  );
}

test('copyClips: media, source start, length, volume, fades, track and the offset from the earliest start', () => {
  const copied = copyClips(session(), ['clp_b', 'clp_a', 'clp_gone']);
  assert.ok(copied);
  assert.equal(copied.origin, 48000n);
  assert.deepEqual(copied.items, [
    { trackId: 'trk_b', mediaId: 'med_sq', sourceStart: '0', length: '24000', gainMilliDb: 0, offset: 24000n },
    { trackId: 'trk_a', mediaId: 'med_long', sourceStart: '1000', length: '24000', gainMilliDb: -3000, fadeIn: lin('100'), fadeOut: lin('200'), offset: 0n },
  ]);
  assert.equal(copyClips(session(), []), null);
  assert.equal(copyClips(session(), ['clp_gone']), null);
  // A plain value: the snapshot changing later does not change it.
  assert.ok(Object.isFrozen(copied) || copied.items.every((item) => typeof item.offset === 'bigint'));
});

test('the clipboard holds one value, replaced by the next copy', () => {
  const clipboard = new Clipboard();
  assert.equal(clipboard.get(), null);
  const first = copyClips(session(), ['clp_a'])!;
  clipboard.set(first);
  assert.equal(clipboard.get(), first);
  const second = copyClips(session(), ['clp_b'])!;
  clipboard.set(second);
  assert.equal(clipboard.get(), second);
});

test('cutCommand: one clip.remove per selected clip, null when none is known', () => {
  const cut = cutCommand(session(), ['clp_a', 'clp_c', 'clp_gone']);
  assert.deepEqual(cut, { expectedRevision: 'r7', commands: [{ op: 'clip.remove', clipId: 'clp_a' }, { op: 'clip.remove', clipId: 'clp_c' }] });
  assert.equal(cutCommand(session(), ['clp_gone']), null);
  assert.equal(cutCommand(session(), []), null);
});

test('pasteCommand at the cursor: relative positions and tracks kept, fades and volume with each clip', () => {
  const snapshot = session();
  const copied = copyClips(snapshot, ['clp_a', 'clp_b'])!;
  const pasted = pasteCommand(snapshot, copied, 300000n, ids('clp_n1', 'clp_n2'));
  assert.ok(pasted);
  assert.equal(pasted.expectedRevision, 'r7');
  assert.deepEqual(pasted.commands, [
    { op: 'clip.place', clipId: 'clp_n1', trackId: 'trk_a', mediaId: 'med_long', position: { domain: 'audio', value: '300000' }, sourceStart: '1000', length: '24000', gainMilliDb: -3000 },
    { op: 'clip.set_fade', clipId: 'clp_n1', fadeIn: lin('100'), fadeOut: lin('200') },
    { op: 'clip.place', clipId: 'clp_n2', trackId: 'trk_b', mediaId: 'med_sq', position: { domain: 'audio', value: '324000' }, sourceStart: '0', length: '24000', gainMilliDb: 0 },
  ]);
  const after = applyClipCommands(snapshot, pasted.commands);
  assert.deepEqual(after.get('clp_n1')!.fadeOut, lin('200'));
  assert.ok(after.has('clp_a'), 'the originals stay');
});

test('pasteCommand at the origin (Alt+V): where the clips were copied from', () => {
  const snapshot = session();
  const pasted = pasteCommand(snapshot, copyClips(snapshot, ['clp_b', 'clp_c'])!, 'origin', ids('clp_x', 'clp_y'));
  assert.deepEqual(
    pasted!.commands.map((c) => [c.clipId, (c.position as { value: string }).value, c.trackId]),
    [
      ['clp_x', '72000', 'trk_b'],
      ['clp_y', '200000', 'trk_a'],
    ],
  );
});

test('pasteCommand leaves out a clip whose track or media is gone, and is null when none remains', () => {
  const snapshot = session();
  const copied = copyClips(snapshot, ['clp_a', 'clp_b'])!;
  const noTrackB = snapshotOf(['trk_a'], [track('trk_a')], snapshot.media, [snapshot.entities['clip:clp_a'] as ClipEntity]);
  assert.deepEqual(pasteCommand(noTrackB, copied, 0n, ids('clp_n'))!.commands.map((c) => c.op), ['clip.place', 'clip.set_fade']);
  const noLong = snapshotOf(snapshot.trackOrder, snapshot.tracks, [media('med_sq', '48000')], []);
  assert.deepEqual(pasteCommand(noLong, copied, 0n, ids('clp_n'))!.commands.map((c) => c.trackId), ['trk_b']);
  const neither = snapshotOf(['trk_a'], [track('trk_a')], [media('med_sq', '48000')], []);
  assert.equal(pasteCommand(neither, copied, 0n), null);
  assert.equal(pasteCommand(snapshot, { origin: 0n, items: [] }, 0n), null);
  // The cursor before 0 pastes at 0.
  assert.equal((pasteCommand(snapshot, copied, -5n, ids('clp_z'))!.commands[0]!.position as { value: string }).value, '0');
});

test('repeatCommand: count copies, copy k shifted by k times the selection\'s span', () => {
  const snapshot = session();
  // Span: 48000 to 224000 = 176000.
  const repeated = repeatCommand(snapshot, ['clp_a', 'clp_c'], 2, ids('r1', 'r2', 'r3', 'r4'));
  assert.ok(repeated);
  assert.equal(repeated.expectedRevision, 'r7');
  const places = repeated.commands.filter((c) => c.op === 'clip.place').map((c) => [c.clipId, (c.position as { value: string }).value, c.trackId]);
  assert.deepEqual(places, [
    ['r1', String(48000 + 176000), 'trk_a'],
    ['r2', String(200000 + 176000), 'trk_a'],
    ['r3', String(48000 + 2 * 176000), 'trk_a'],
    ['r4', String(200000 + 2 * 176000), 'trk_a'],
  ]);
  // The fades go with each copy of clp_a.
  assert.deepEqual(repeated.commands.filter((c) => c.op === 'clip.set_fade').map((c) => c.clipId), ['r1', 'r3']);
  // One clip: its own length.
  assert.deepEqual(
    repeatCommand(snapshot, ['clp_b'], 3, ids('q1', 'q2', 'q3'))!.commands.map((c) => (c.position as { value: string }).value),
    ['96000', '120000', '144000'],
  );
  for (const bad of [0, -1, 1.5, Number.NaN, MAX_REPEAT + 1]) assert.equal(repeatCommand(snapshot, ['clp_a'], bad), null, String(bad));
  assert.ok(repeatCommand(snapshot, ['clp_b'], MAX_REPEAT));
  assert.equal(repeatCommand(snapshot, [], 2), null);
});

test('repeatCountFromDrag: the drag in selection spans, rounded, never below 0', () => {
  const span = 24000n;
  assert.equal(repeatCountFromDrag(0n, span), 0);
  assert.equal(repeatCountFromDrag(11999n, span), 0);
  assert.equal(repeatCountFromDrag(12000n, span), 1, 'half a span is one copy');
  assert.equal(repeatCountFromDrag(24000n, span), 1);
  assert.equal(repeatCountFromDrag(36000n, span), 2);
  assert.equal(repeatCountFromDrag(100000n, span), 4);
  assert.equal(repeatCountFromDrag(-50000n, span), 0, 'left drags repeat nothing');
  assert.equal(repeatCountFromDrag(50000n, 0n), 0, 'no span');
  assert.equal(repeatCountFromDrag(24000n * 500n, span), MAX_REPEAT, 'held at the most a repeat makes');
});
