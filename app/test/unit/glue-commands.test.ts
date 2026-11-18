// Glue (m5b-ui-edit-more; UI redesign spec 3.2 "Tools" and "Editing"): a
// clip and the next clip of its track join when they are adjacent pieces of
// the same media with continuous source positions, in one command list of
// clip.remove of the next piece and clip.trim of the first to the sum of the
// lengths, plus one clip.set_fade on the first when the pieces carry fades
// (the first's fade in kept, the last's fade out taken, "0" when the last has
// none and the first had one). Anything else is a refusal naming why, never a
// command. Alt joins the whole following run; edit.glue joins each run of the
// selection. The expected entities come from support/apply.ts, the protocol's
// rules worked out on their own.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ClipEntity, ClipFade } from '../../src/renderer/model/document';
import { splitCommand } from '../../src/renderer/timeline/edit-commands';
import { glueCheck, glueCommand, glueSelectionCommand, isGlueRefused } from '../../src/renderer/timeline/edit-commands';
import { applied, applyClipCommands } from './support/apply';
import { clip, media, snapshotOf, track } from './support/timeline';

const lin = (length: string): ClipFade => ({ length, curve: 'linear' });
const eqp = (length: string): ClipFade => ({ length, curve: 'equal_power' });

// Three continuous pieces of med_long on trk_a (frames 96000 to 168000), a
// gap, another; a piece of other media right after on trk_b; a piece whose
// source does not continue.
function pieces(over: Record<string, Partial<ClipEntity>> = {}) {
  const at = (c: ClipEntity) => ({ ...c, gainMilliDb: -2000, ...(over[c.id] ?? {}) });
  return snapshotOf(
    ['trk_a', 'trk_b', 'trk_c'],
    [track('trk_a'), track('trk_b'), track('trk_c')],
    [media('med_long', '480000'), media('med_sq', '48000')],
    [
      at(clip('clp_p1', 'trk_a', 'med_long', '96000', '24000', '24000')),
      at(clip('clp_p2', 'trk_a', 'med_long', '120000', '48000', '24000')),
      at(clip('clp_p3', 'trk_a', 'med_long', '144000', '72000', '24000')),
      at(clip('clp_gap', 'trk_a', 'med_long', '200000', '128000', '24000')),
      at(clip('clp_b1', 'trk_b', 'med_long', '0', '0', '24000')),
      at(clip('clp_b2', 'trk_b', 'med_sq', '24000', '24000', '24000')),
      at(clip('clp_c1', 'trk_c', 'med_long', '0', '0', '24000')),
      at(clip('clp_c2', 'trk_c', 'med_long', '24000', '30000', '24000')),
    ],
  );
}

function command(result: ReturnType<typeof glueCommand>) {
  assert.ok(result && !isGlueRefused(result), `a command, not ${JSON.stringify(result)}`);
  return result;
}

test('two adjacent continuous pieces: clip.remove of the next and clip.trim of the first, at the snapshot\'s revision', () => {
  const snapshot = pieces();
  const glued = command(glueCommand(snapshot, 'clp_p1'));
  assert.equal(glued.expectedRevision, 'r7');
  assert.deepEqual(glued.commands, [
    { op: 'clip.remove', clipId: 'clp_p2' },
    { op: 'clip.trim', clipId: 'clp_p1', sourceStart: '24000', length: '48000' },
  ]);
  const after = applyClipCommands(snapshot, glued.commands);
  assert.equal(after.has('clp_p2'), false);
  const joined = after.get('clp_p1')!;
  assert.equal(joined.position.value, '96000');
  assert.equal(joined.gainMilliDb, -2000, 'the first piece\'s volume');
  // The second piece of the next pair glues the same way.
  assert.deepEqual(command(glueCommand(snapshot, 'clp_p2')).commands, [
    { op: 'clip.remove', clipId: 'clp_p3' },
    { op: 'clip.trim', clipId: 'clp_p2', sourceStart: '48000', length: '48000' },
  ]);
});

test('Alt (all) joins every following piece of the run in one list', () => {
  const glued = command(glueCommand(pieces(), 'clp_p1', { all: true }));
  assert.deepEqual(glued.commands, [
    { op: 'clip.remove', clipId: 'clp_p2' },
    { op: 'clip.remove', clipId: 'clp_p3' },
    { op: 'clip.trim', clipId: 'clp_p1', sourceStart: '24000', length: '72000' },
  ]);
  // The run ends at the gap: clp_gap is not taken.
  assert.ok(applyClipCommands(pieces(), glued.commands).has('clp_gap'));
  // From the last piece of a run, Alt has nothing to join.
  assert.deepEqual(glueCommand(pieces(), 'clp_p3', { all: true }), { refused: 'gap' });
});

test('the refusals: no next clip, a gap, other media, a source that does not continue, another track', () => {
  const snapshot = pieces();
  assert.deepEqual(glueCommand(snapshot, 'clp_gap'), { refused: 'no_next' });
  assert.deepEqual(glueCommand(snapshot, 'clp_p3'), { refused: 'gap' });
  assert.deepEqual(glueCommand(snapshot, 'clp_b1'), { refused: 'other_media' });
  assert.deepEqual(glueCommand(snapshot, 'clp_c1'), { refused: 'source_not_continuous' });
  // An overlap is not adjacent either.
  const overlap = pieces({ clp_p2: { position: { domain: 'audio', value: '110000' } } });
  assert.deepEqual(glueCommand(overlap, 'clp_p1'), { refused: 'gap' });
  // The pair check names another track first.
  const [a1, b1] = [snapshot.entities['clip:clp_p1'], snapshot.entities['clip:clp_b1']] as ClipEntity[];
  assert.equal(glueCheck(a1!, b1!), 'other_track');
  assert.equal(glueCheck(a1!, snapshot.entities['clip:clp_p2'] as ClipEntity), null);
  for (const id of ['clp_gap', 'clp_p3', 'clp_b1', 'clp_c1']) assert.ok(isGlueRefused(glueCommand(snapshot, id)), id);
  // An unknown clip is nothing to do.
  assert.equal(glueCommand(snapshot, 'clp_gone'), null);
});

test('fades: the first piece\'s fade in is kept, the last one\'s fade out taken, in one clip.set_fade on the first', () => {
  const withOut = pieces({ clp_p1: { fadeIn: lin('1000') }, clp_p2: { fadeOut: eqp('3000') } });
  const glued = command(glueCommand(withOut, 'clp_p1'));
  assert.deepEqual(glued.commands, [
    { op: 'clip.remove', clipId: 'clp_p2' },
    { op: 'clip.trim', clipId: 'clp_p1', sourceStart: '24000', length: '48000' },
    { op: 'clip.set_fade', clipId: 'clp_p1', fadeOut: eqp('3000') },
  ]);
  const joined = applyClipCommands(withOut, glued.commands).get('clp_p1')!;
  assert.deepEqual(joined.fadeIn, lin('1000'));
  assert.deepEqual(joined.fadeOut, eqp('3000'));
  // The first piece had a fade out and the last has none: it is removed ("0").
  const inner = pieces({ clp_p1: { fadeOut: lin('2000') } });
  const removed = command(glueCommand(inner, 'clp_p1'));
  assert.deepEqual(removed.commands.at(-1), { op: 'clip.set_fade', clipId: 'clp_p1', fadeOut: lin('0') });
  assert.equal(applyClipCommands(inner, removed.commands).get('clp_p1')!.fadeOut, undefined);
  // A fade in alone needs no set_fade: the trim keeps it.
  assert.equal(command(glueCommand(pieces({ clp_p1: { fadeIn: lin('500') } }), 'clp_p1')).commands.length, 2);
  // Alt: the last piece of the run gives the fade out.
  const run = command(glueCommand(pieces({ clp_p2: { fadeOut: lin('100') }, clp_p3: { fadeOut: lin('900') } }), 'clp_p1', { all: true }));
  assert.deepEqual(run.commands.filter((c) => c.op === 'clip.set_fade'), [{ op: 'clip.set_fade', clipId: 'clp_p1', fadeOut: lin('900') }]);
});

test('a split followed by a glue gives back the original clip\'s entity fields', () => {
  const original: ClipEntity = { ...clip('clp_one', 'trk_a', 'med_long', '96000', '24000', '96000'), gainMilliDb: -4500, fadeIn: lin('4000'), fadeOut: eqp('12000') };
  const start = snapshotOf(['trk_a'], [track('trk_a')], [media('med_long', '480000')], [original]);
  const split = splitCommand(start, ['clp_one'], 150000n, () => 'clp_right');
  assert.ok(split);
  const halves = applied(start, split.commands);
  assert.ok(halves.entities['clip:clp_right'], 'two pieces');
  const glued = command(glueCommand(halves, 'clp_one'));
  assert.equal(glued.expectedRevision, 'r8');
  const back = applyClipCommands(halves, glued.commands);
  assert.deepEqual([...back.keys()], ['clp_one']);
  assert.deepEqual(back.get('clp_one'), original);
  // Without fades too.
  const plain = snapshotOf(['trk_a'], [track('trk_a')], [media('med_long', '480000')], [clip('clp_one', 'trk_a', 'med_long', '0', '0', '48000')]);
  const cut = applied(plain, splitCommand(plain, ['clp_one'], 20000n, () => 'clp_r')!.commands);
  assert.deepEqual(applyClipCommands(cut, command(glueCommand(cut, 'clp_one')).commands).get('clp_one'), plain.entities['clip:clp_one']);
});

test('edit.glue joins each run of the selection and leaves singletons alone, in one list', () => {
  const snapshot = pieces();
  const all = ['clp_p1', 'clp_p2', 'clp_p3', 'clp_gap', 'clp_b1', 'clp_b2', 'clp_c1', 'clp_c2'];
  const glued = glueSelectionCommand(snapshot, all);
  assert.ok(glued);
  assert.equal(glued.expectedRevision, 'r7');
  assert.deepEqual(glued.commands, [
    { op: 'clip.remove', clipId: 'clp_p2' },
    { op: 'clip.remove', clipId: 'clp_p3' },
    { op: 'clip.trim', clipId: 'clp_p1', sourceStart: '24000', length: '72000' },
  ]);
  // Only the selected pieces are joined: p1 and p2, not p3.
  assert.deepEqual(glueSelectionCommand(snapshot, ['clp_p2', 'clp_p1'])!.commands, [
    { op: 'clip.remove', clipId: 'clp_p2' },
    { op: 'clip.trim', clipId: 'clp_p1', sourceStart: '24000', length: '48000' },
  ]);
  // Two runs on two tracks.
  const two = snapshotOf(
    ['trk_a', 'trk_b'],
    [track('trk_a'), track('trk_b')],
    [media('med_long', '480000')],
    [
      clip('clp_a1', 'trk_a', 'med_long', '0', '0', '1000'),
      clip('clp_a2', 'trk_a', 'med_long', '1000', '1000', '1000'),
      clip('clp_b1', 'trk_b', 'med_long', '5000', '7000', '500'),
      clip('clp_b2', 'trk_b', 'med_long', '5500', '7500', '500'),
    ],
  );
  assert.deepEqual(glueSelectionCommand(two, ['clp_a1', 'clp_a2', 'clp_b1', 'clp_b2'])!.commands, [
    { op: 'clip.remove', clipId: 'clp_a2' },
    { op: 'clip.trim', clipId: 'clp_a1', sourceStart: '0', length: '2000' },
    { op: 'clip.remove', clipId: 'clp_b2' },
    { op: 'clip.trim', clipId: 'clp_b1', sourceStart: '7000', length: '1000' },
  ]);
  // Nothing to join: singletons only.
  assert.equal(glueSelectionCommand(snapshot, ['clp_gap', 'clp_b1', 'clp_c1']), null);
  assert.equal(glueSelectionCommand(snapshot, []), null);
});
