// The info line's editing (m5b-ui-edit-more; UI redesign spec 3.2, "Info
// line"): a typed start or end position (bar.beat.sixteenth.tick, trailing
// parts optional), a length or offset (bars.beats.sixteenths.ticks from zero)
// and a volume (dB, the unit optional) parse back to what the formatters
// write, and garbage parses to nothing. infoLineEditCommand turns a typed
// value into one command list over the selection: relative (the primary
// clip's change applied to every selected clip) or absolute (every clip set
// to the value); start is clip.move, length and offset clip.trim, volume
// clip.set_gain, each clamped; null when nothing changes.
//
// At 120 BPM and 48 kHz a tick is 12.5 frames: a sixteenth 6000 frames, a
// beat 24000 and a bar 96000.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatDb2 } from '../../src/renderer/format';
import { infoLineEditCommand, parseDb, parseLength, parsePosition } from '../../src/renderer/timeline/info-line';
import { formatLength, formatPosition } from '../../src/renderer/timeline/musical-time';
import { applyClipCommands } from './support/apply';
import { clip, media, snapshotOf, track } from './support/timeline';

test('parsePosition reads bar.beat.sixteenth.tick, trailing parts optional, and round-trips formatPosition', () => {
  assert.equal(parsePosition('1.1.1.0'), 0);
  assert.equal(parsePosition('9.1.1.0'), 8 * 7680);
  assert.equal(parsePosition('2.3.4.5'), 7680 + 2 * 1920 + 3 * 480 + 5);
  assert.equal(parsePosition('9'), 8 * 7680);
  assert.equal(parsePosition('9.2'), 8 * 7680 + 1920);
  assert.equal(parsePosition(' 3.1.2 '), 2 * 7680 + 480);
  for (const ticks of [0, 1, 479, 480, 1920, 7679, 7680, 123457]) assert.equal(parsePosition(formatPosition(ticks)), ticks, String(ticks));
  for (const bad of ['', ' ', 'abc', '0.1.1.0', '1.0.1.0', '1.1.0.0', '1.1.1.-1', '1.1.1.0.0', '1..1', '1.1.1.0x', '1,5', '-2']) assert.equal(parsePosition(bad), null, bad);
});

test('parseLength reads bars.beats.sixteenths.ticks from zero and round-trips formatLength', () => {
  assert.equal(parseLength('0.0.0.0'), 0);
  assert.equal(parseLength('3.3.0.0'), 3 * 7680 + 3 * 1920);
  assert.equal(parseLength('1'), 7680);
  assert.equal(parseLength('0.0.1'), 480);
  for (const ticks of [0, 1, 479, 480, 1920, 7679, 7680, 98765]) assert.equal(parseLength(formatLength(ticks)), ticks, String(ticks));
  for (const bad of ['', 'x', '-1', '1.-1', '1.1.1.1.1', '1.5.0.0a', '1.2.3.4.']) assert.equal(parseLength(bad), null, bad);
});

test('parseDb reads a volume with or without dB, and -inf; round-trips formatDb2', () => {
  assert.equal(parseDb('0.00 dB'), 0);
  assert.equal(parseDb('-3.5'), -3500);
  assert.equal(parseDb('+1.25dB'), 1250);
  assert.equal(parseDb(' -12 db '), -12000);
  assert.equal(parseDb('-inf'), -2147483648);
  assert.equal(parseDb('-inf dB'), -2147483648);
  for (const milli of [0, -3000, 1500, -59990, 6000, -120]) assert.equal(parseDb(formatDb2(milli)), milli, String(milli));
  for (const bad of ['', 'loud', '3 dB dB', '--3', '1.2.3', 'dB']) assert.equal(parseDb(bad), null, bad);
});

// clp_p (the primary) at bar 2 for one bar, 6000 into its media, -3 dB;
// clp_o at bar 5 for half a bar, 0 into its media, 0 dB. med_long is 20 bars.
function session() {
  return snapshotOf(
    ['trk_a', 'trk_b'],
    [track('trk_a'), track('trk_b')],
    [media('med_long', String(20 * 96000))],
    [
      { ...clip('clp_p', 'trk_a', 'med_long', '96000', '6000', '96000'), gainMilliDb: -3000 },
      clip('clp_o', 'trk_b', 'med_long', '384000', '0', '48000'),
    ],
  );
}
const IDS = ['clp_p', 'clp_o'];

function after(field: Parameters<typeof infoLineEditCommand>[3], typed: string, absolute: boolean, ids = IDS) {
  const snapshot = session();
  const command = infoLineEditCommand(snapshot, ids, 'clp_p', field, typed, absolute);
  assert.ok(command, `${field} ${typed}`);
  assert.equal(command.expectedRevision, 'r7');
  return { command, clips: applyClipCommands(snapshot, command.commands) };
}

test('start: relative moves every clip by the primary\'s change, absolute puts each at the value; clip.move', () => {
  const relative = after('start', '3.1.1.0', false);
  assert.deepEqual(relative.command.commands.map((c) => c.op), ['clip.move', 'clip.move']);
  assert.equal(relative.clips.get('clp_p')!.position.value, String(2 * 96000));
  assert.equal(relative.clips.get('clp_o')!.position.value, String(384000 + 96000));
  const absolute = after('start', '3.1.1.0', true);
  assert.equal(absolute.clips.get('clp_p')!.position.value, String(2 * 96000));
  assert.equal(absolute.clips.get('clp_o')!.position.value, String(2 * 96000));
  // Earlier than the selection allows: the whole selection stops at 0.
  const early = infoLineEditCommand(snapshot(), IDS, 'clp_p', 'start', '1', false)!;
  assert.deepEqual(early.commands.map((c) => (c.position as { value: string }).value), ['0', String(384000 - 96000)]);
});

function snapshot() {
  return session();
}

test('length: clip.trim of the length, relative or absolute, between one frame and the media\'s end', () => {
  const relative = after('length', '2.0.0.0', false);
  assert.deepEqual(relative.command.commands, [
    { op: 'clip.trim', clipId: 'clp_p', sourceStart: '6000', length: String(2 * 96000) },
    { op: 'clip.trim', clipId: 'clp_o', sourceStart: '0', length: String(48000 + 96000) },
  ]);
  const absolute = after('length', '0.1.0.0', true);
  assert.equal(absolute.clips.get('clp_p')!.length, '24000');
  assert.equal(absolute.clips.get('clp_o')!.length, '24000');
  // Past the media's end: held there (20 bars less the source start).
  const long = after('length', '40', true);
  assert.equal(long.clips.get('clp_p')!.length, String(20 * 96000 - 6000));
  assert.equal(long.clips.get('clp_o')!.length, String(20 * 96000));
  // Zero: one frame.
  assert.equal(after('length', '0', true).clips.get('clp_o')!.length, '1');
  // The positions stay.
  assert.equal(long.clips.get('clp_p')!.position.value, '96000');
});

test('offset: clip.trim of the source start, the clip staying where it is, within the media', () => {
  // The primary's offset is one sixteenth (6000 frames, 0.0.1.0); 0.1.0.0 adds 18000.
  const relative = after('offset', '0.1.0.0', false);
  assert.deepEqual(relative.command.commands, [
    { op: 'clip.trim', clipId: 'clp_p', sourceStart: '24000', length: '96000' },
    { op: 'clip.trim', clipId: 'clp_o', sourceStart: '18000', length: '48000' },
  ]);
  assert.equal(relative.clips.get('clp_p')!.position.value, '96000');
  const absolute = after('offset', '0.0.2.0', true);
  assert.equal(absolute.clips.get('clp_p')!.sourceStart, '12000');
  assert.equal(absolute.clips.get('clp_o')!.sourceStart, '12000');
  // No further than the media allows for each clip's length.
  const far = after('offset', '30', true);
  assert.equal(far.clips.get('clp_p')!.sourceStart, String(20 * 96000 - 96000));
  assert.equal(far.clips.get('clp_o')!.sourceStart, String(20 * 96000 - 48000));
});

test('volume: clip.set_gain, relative or absolute, within -60 to +6 dB', () => {
  const relative = after('volume', '-1.5', false);
  assert.deepEqual(relative.command.commands, [
    { op: 'clip.set_gain', clipId: 'clp_p', gainMilliDb: -1500 },
    { op: 'clip.set_gain', clipId: 'clp_o', gainMilliDb: 1500 },
  ]);
  const absolute = after('volume', '-6 dB', true);
  assert.deepEqual([absolute.clips.get('clp_p')!.gainMilliDb, absolute.clips.get('clp_o')!.gainMilliDb], [-6000, -6000]);
  assert.deepEqual([after('volume', '+20', true).clips.get('clp_o')!.gainMilliDb, after('volume', '-90', true).clips.get('clp_o')!.gainMilliDb], [6000, -60000]);
  // Relative: +12 dB on the primary (-3 to +6, held) is +9 for every clip, held at +6.
  assert.deepEqual(after('volume', '9', false).clips.get('clp_o')!.gainMilliDb, 6000);
});

test('nothing changes, an unknown primary or a value that does not parse: nothing is sent', () => {
  const s = session();
  assert.equal(infoLineEditCommand(s, IDS, 'clp_p', 'start', '2.1.1.0', false), null, 'the same start');
  assert.equal(infoLineEditCommand(s, ['clp_p'], 'clp_p', 'volume', '-3.00 dB', true), null);
  assert.equal(infoLineEditCommand(s, IDS, 'clp_p', 'start', 'soon', false), null);
  assert.equal(infoLineEditCommand(s, IDS, 'clp_gone', 'start', '3', false), null);
  assert.equal(infoLineEditCommand(s, [], 'clp_p', 'start', '3', true), null);
  // Absolute where one clip is there already: only the other moves.
  assert.deepEqual(infoLineEditCommand(s, IDS, 'clp_p', 'start', '2', true)!.commands.map((c) => c.clipId), ['clp_o']);
});
