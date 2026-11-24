// The commands a fade handle sends (m5b-ui-fades; UI redesign 3.2, "Clip
// handles"; 10.11, 23), against the protocol's clip.set_fade (protocol-engine
// v0, "Clip fades": each side {length, curve}, lengths in media frames as
// decimal strings, "0" removing the side, an omitted side unchanged, the two
// together never longer than the clip):
//
// - a drag of a handle ends in one clip.set_fade naming only the dragged side,
//   its end where the snapper puts it (the grid; Ctrl gives an unsnapped
//   snapper), clamped to 0 up to the clip's length less the other side, and
//   nothing when it ends at the starting length;
// - a side that has no fade takes linear, a side that has one keeps its curve;
// - a double-click switches a side's curve with the same length, and sends
//   nothing on a side without a fade.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ClipEntity } from '../../src/renderer/model/document';
import { fadeCurveToggleCommand, fadeDragCommand } from '../../src/renderer/timeline/fades';
import { snapperFor } from '../../src/renderer/timeline/snap';
import { applyClipCommands } from './support/apply';
import { clip, media, snapshotOf, track } from './support/timeline';

// At 120 BPM and 48 kHz a beat is 24000 frames. The clip starts at bar 2 (96000) for 96000 frames.
const keys = (over: Partial<ClipEntity> = {}): ClipEntity => ({ ...clip('clp_k', 'trk_k', 'med_k', '96000', '0', '96000'), ...over });
const session = (c: ClipEntity = keys(), revision = 'r12') => snapshotOf(['trk_k'], [track('trk_k')], [media('med_k', '480000')], [c], revision);
// The grid at a beat (at 400 frames per pixel Adapt to Zoom gives a beat; any snapper the canvas builds will do).
const beat = (frame: bigint) => ((frame + 12000n) / 24000n) * 24000n;
const none = (frame: bigint) => frame;

test('a fade in drag: one clip.set_fade with only that side, its end on the grid, linear for a new fade', () => {
  const s = session();
  const command = fadeDragCommand(s, 'clp_k', 'fadeIn', 96000n + 23000n, beat);
  assert.deepEqual(command, { expectedRevision: 'r12', commands: [{ op: 'clip.set_fade', clipId: 'clp_k', fadeIn: { length: '24000', curve: 'linear' } }] });
  // Ctrl: the snapper ignores the grid, the end is where the pointer is.
  assert.deepEqual(fadeDragCommand(s, 'clp_k', 'fadeIn', 96000n + 23000n, none)!.commands, [{ op: 'clip.set_fade', clipId: 'clp_k', fadeIn: { length: '23000', curve: 'linear' } }]);
  // A real snapper of snap.ts gives the same command shape.
  const grid = snapperFor({ on: true, grid: 'adapt' }, 400, [], 48000);
  const snapped = fadeDragCommand(s, 'clp_k', 'fadeIn', 96000n + 23000n, grid)!;
  assert.equal(snapped.commands.length, 1);
  assert.equal((snapped.commands[0] as { fadeIn: { length: string } }).fadeIn.length, String(grid(119000n) - 96000n));
});

test('a fade out drag: its end measured from the clip\'s end; an existing side keeps its curve', () => {
  const s = session(keys({ fadeOut: { length: '6000', curve: 'equal_power' } }));
  // The fade out's end dragged to bar 2 beat 3 (144000): 48000 frames from the clip's end at 192000.
  const command = fadeDragCommand(s, 'clp_k', 'fadeOut', 143000n, beat)!;
  assert.deepEqual(command.commands, [{ op: 'clip.set_fade', clipId: 'clp_k', fadeOut: { length: '48000', curve: 'equal_power' } }]);
  // The fade in is not named: an omitted side is unchanged.
  assert.ok(!('fadeIn' in command.commands[0]!));
  assert.deepEqual(applyClipCommands(s, command.commands).get('clp_k')!.fadeOut, { length: '48000', curve: 'equal_power' });
});

test('clamped to the clip\'s length less the other side, and to 0', () => {
  const s = session(keys({ fadeOut: { length: '30000', curve: 'linear' } }));
  // Past the fade out's start (192000 - 30000 = 162000) and past the clip's end.
  for (const end of [170000n, 192000n, 900000n]) {
    assert.deepEqual(fadeDragCommand(s, 'clp_k', 'fadeIn', end, none)!.commands, [{ op: 'clip.set_fade', clipId: 'clp_k', fadeIn: { length: '66000', curve: 'linear' } }], String(end));
  }
  // The fade out dragged before the clip's start: the whole clip less the fade in (none here).
  assert.deepEqual(fadeDragCommand(s, 'clp_k', 'fadeOut', 0n, none)!.commands, [{ op: 'clip.set_fade', clipId: 'clp_k', fadeOut: { length: '96000', curve: 'linear' } }]);
  const both = session(keys({ fadeIn: { length: '20000', curve: 'equal_power' }, fadeOut: { length: '30000', curve: 'linear' } }));
  assert.deepEqual(fadeDragCommand(both, 'clp_k', 'fadeOut', 50000n, none)!.commands, [{ op: 'clip.set_fade', clipId: 'clp_k', fadeOut: { length: '76000', curve: 'linear' } }]);
  // A fade in dragged before the clip's start: length 0 removes it, the curve still given.
  assert.deepEqual(fadeDragCommand(both, 'clp_k', 'fadeIn', 1000n, none)!.commands, [{ op: 'clip.set_fade', clipId: 'clp_k', fadeIn: { length: '0', curve: 'equal_power' } }]);
  assert.equal(applyClipCommands(both, fadeDragCommand(both, 'clp_k', 'fadeIn', 1000n, none)!.commands).get('clp_k')!.fadeIn, undefined);
});

test('a release at the starting length sends nothing; an unknown clip sends nothing', () => {
  const s = session(keys({ fadeIn: { length: '24000', curve: 'linear' } }));
  assert.equal(fadeDragCommand(s, 'clp_k', 'fadeIn', 96000n + 24000n, none), null);
  assert.equal(fadeDragCommand(s, 'clp_k', 'fadeIn', 96000n + 23000n, beat), null, 'snapped back to where it was');
  // No fade out, dragged to 0: nothing to remove.
  assert.equal(fadeDragCommand(s, 'clp_k', 'fadeOut', 192000n, none), null);
  assert.equal(fadeDragCommand(s, 'clp_k', 'fadeOut', 500000n, none), null);
  assert.equal(fadeDragCommand(s, 'clp_gone', 'fadeIn', 100000n, none), null);
});

test('the curve toggle: linear <-> equal power with the same length; nothing on a side without a fade', () => {
  const s = session(keys({ fadeIn: { length: '480', curve: 'linear' }, fadeOut: { length: '960', curve: 'equal_power' } }), 'r40');
  assert.deepEqual(fadeCurveToggleCommand(s, 'clp_k', 'fadeIn'), { expectedRevision: 'r40', commands: [{ op: 'clip.set_fade', clipId: 'clp_k', fadeIn: { length: '480', curve: 'equal_power' } }] });
  assert.deepEqual(fadeCurveToggleCommand(s, 'clp_k', 'fadeOut')!.commands, [{ op: 'clip.set_fade', clipId: 'clp_k', fadeOut: { length: '960', curve: 'linear' } }]);
  const bare = session();
  assert.equal(fadeCurveToggleCommand(bare, 'clp_k', 'fadeIn'), null);
  assert.equal(fadeCurveToggleCommand(bare, 'clp_k', 'fadeOut'), null);
  assert.equal(fadeCurveToggleCommand(s, 'clp_gone', 'fadeIn'), null);
});
