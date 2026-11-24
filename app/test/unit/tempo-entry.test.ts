// The tempo field (m5b-ui-keymap; UI redesign 3.1, 3.6; research/cubase.md
// 7.1, Enter Tempo on Shift+T): what Shift+T's field reads and sends. The
// typed tempo is BPM with up to two decimals, 1.00 to 999.99 (the engine's
// range, kMinMilliBpm and kMaxMilliBpm of siann-time); Enter sends one
// command.execute with one session.set_tempo carrying the whole map in which
// only the point in force at the cursor has the typed tempo, so it is one
// revision and one undo. Nothing for a tempo that changes nothing; nothing
// on an engine that does not list session.set_tempo (3.0). The tempo stays
// enabled while a proposal is heard, as 4.5 C5 keeps it; the engine's
// invalid_tempo is a refusal line worded from the catalogs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { KNOWN_ERROR_CODES, refusalLine } from '../../src/renderer/i18n/errors';
import { translator } from '../../src/renderer/i18n/t';
import { capabilitySelector, type Capabilities } from '../../src/renderer/model/capabilities';
import type { RootEntity, TempoPoint } from '../../src/renderer/model/document';
import { isStructural } from '../../src/renderer/model/edit-guard';
import type { Snapshot } from '../../src/renderer/model/read-model';
import { formatTempo } from '../../src/renderer/timeline/transport-time';
import { parseTempo, replaceTempoAt, tempoCommand, tempoEntryAllowed } from '../../src/renderer/timeline/tempo-edit';
import { sampleSnapshot } from './support/timeline';

// A catalog key this feature adds, read without the typed signature.
const say = (t: unknown, key: string): string => (t as (k: string) => string)(key);

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test', 'unit', 'fixtures');
const FULL = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'capabilities-full.json'), 'utf8')) as Capabilities;
const RATE = 48000;
const MAP: TempoPoint[] = [
  { ticks: '0', milliBpm: 120_000 },
  { ticks: '7680', milliBpm: 60_000 },
];

function withTempo(tempo: TempoPoint[]): Snapshot {
  const snapshot = sampleSnapshot();
  const root: RootEntity = { ...snapshot.root!, tempo };
  return { ...snapshot, root, entities: { ...snapshot.entities, 'root:root': root } };
}

test('a typed tempo: BPM with up to two decimals, 1.00 to 999.99', () => {
  const good: Array<[string, number]> = [
    ['120', 120_000],
    ['120.5', 120_500],
    ['98.25', 98_250],
    [' 140.00 ', 140_000],
    ['1', 1_000],
    ['999.99', 999_990],
    ['0060', 60_000],
  ];
  for (const [text, milliBpm] of good) assert.equal(parseTempo(text), milliBpm, text);
  for (const text of ['', ' ', '0.99', '0', '1000', '120.555', '-5', 'abc', '12O', '120,5', '1e2', '.5', '120.', 'Infinity']) assert.equal(parseTempo(text), null, text);
});

test('the field starts with the display\'s text, and what it shows reads back to the same tempo', () => {
  for (const milliBpm of [120_000, 98_250, 1_000, 999_990]) assert.equal(parseTempo(formatTempo(milliBpm)), milliBpm, String(milliBpm));
});

test('only the point in force at the cursor takes the typed tempo; the rest of the map stays', () => {
  // Bar 1 is at 120 BPM, bar 2 on at 60 BPM (it starts at 96,000 frames).
  assert.deepEqual(replaceTempoAt(MAP, RATE, 10_000n, 100_000), [
    { ticks: '0', milliBpm: 100_000 },
    { ticks: '7680', milliBpm: 60_000 },
  ]);
  assert.deepEqual(replaceTempoAt(MAP, RATE, 96_000n, 90_000), [
    { ticks: '0', milliBpm: 120_000 },
    { ticks: '7680', milliBpm: 90_000 },
  ]);
  assert.deepEqual(replaceTempoAt(MAP, RATE, 500_000n, 90_000), [
    { ticks: '0', milliBpm: 120_000 },
    { ticks: '7680', milliBpm: 90_000 },
  ]);
  // An empty map (a new session's 120 BPM) gets its one point at the start.
  assert.deepEqual(replaceTempoAt([], RATE, 30_000n, 128_000), [{ ticks: '0', milliBpm: 128_000 }]);
  // The same tempo changes nothing.
  assert.equal(replaceTempoAt(MAP, RATE, 10_000n, 120_000), null);
  assert.equal(replaceTempoAt([], RATE, 0n, 120_000), null);
});

test('Enter sends one command.execute with one session.set_tempo of the whole map, at the snapshot\'s revision', () => {
  const snapshot = withTempo(MAP);
  assert.deepEqual(tempoCommand(snapshot, 96_000n, 75_500), {
    expectedRevision: snapshot.revision,
    commands: [
      {
        op: 'session.set_tempo',
        tempo: [
          { ticks: '0', milliBpm: 120_000 },
          { ticks: '7680', milliBpm: 75_500 },
        ],
      },
    ],
  });
  assert.equal(tempoCommand(snapshot, 96_000n, 60_000), null, 'no change, no command');
});

test('Shift+T stays while a proposal is heard and is absent without session.set_tempo', () => {
  const can = capabilitySelector(FULL);
  assert.equal(tempoEntryAllowed(can), true);
  assert.ok(!isStructural('session.set_tempo'), 'the edit guard keeps the tempo (4.5 C5)');
  const without = capabilitySelector({ ...FULL, commands: (FULL.commands ?? []).filter((c) => c !== 'session.set_tempo') });
  assert.equal(tempoEntryAllowed(without), false);
});

test('the engine\'s invalid_tempo is worded from the catalogs, the code in front', () => {
  assert.ok(KNOWN_ERROR_CODES.includes('invalid_tempo'));
  for (const locale of ['zh-Hant', 'zh-Hans'] as const) {
    const line = refusalLine('invalid_tempo', 'tempo 0 milli-BPM is out of range', locale);
    assert.ok(line.startsWith('invalid_tempo: ') && /\p{Script=Han}/u.test(line), line);
  }
  assert.equal(refusalLine('invalid_tempo', '', 'en'), `invalid_tempo: ${say(translator('en'), 'error.invalid_tempo')}`);
});
