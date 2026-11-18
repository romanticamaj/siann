// The time signature display's metre (m5b-ui-signature; UI redesign UR-15,
// 3.1, 2.4): the top bar's Sig cell reads the one constant the bar maths
// reads (timeline/musical-time.ts), so the cell cannot disagree with the
// ruler, the grid, snap, the position display or the locator display. 4/4
// until the meter map arrives (E-10). The rendered cell is in top-bar.test.tsx.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { barBeat } from '../../src/renderer/timeline/locators';
import {
  BEAT_UNIT,
  BEATS_PER_BAR,
  TICKS_PER_BAR,
  TICKS_PER_QUARTER,
  TIME_SIGNATURE,
  formatSignature,
  ticksToFrames,
} from '../../src/renderer/timeline/musical-time';
import { barOf, chooseRulerStep } from '../../src/renderer/timeline/ruler';
import { ADAPT_STEPS_TICKS, gridStepTicks } from '../../src/renderer/timeline/snap';
import { formatPosition, parsePosition } from '../../src/renderer/timeline/transport-time';

const RATE = 48000;
// dist/test/unit -> app/src/renderer
const RENDERER = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer');

test('musical-time holds the metre: TIME_SIGNATURE is 4/4, a beat is a quarter, and formatSignature writes it', () => {
  assert.deepEqual(TIME_SIGNATURE, { beats: 4, unit: 4 });
  assert.equal(TIME_SIGNATURE.beats, BEATS_PER_BAR);
  assert.equal(TIME_SIGNATURE.unit, BEAT_UNIT);
  assert.ok(Object.isFrozen(TIME_SIGNATURE));
  assert.equal(TICKS_PER_BAR, TICKS_PER_QUARTER * TIME_SIGNATURE.beats);
  assert.equal(formatSignature(), `${TIME_SIGNATURE.beats}/${TIME_SIGNATURE.unit}`);
  assert.equal(formatSignature(), '4/4');
});

test('the bar maths agrees with the signature: ruler, snap, the position display and the locator display', () => {
  const barTicks = TIME_SIGNATURE.beats * TICKS_PER_QUARTER;
  // The ruler: bar 2 starts after `beats` beats.
  assert.equal(barOf({ ticks: barTicks - 1 }), 1);
  assert.equal(barOf({ ticks: barTicks }), 2);
  assert.equal(chooseRulerStep(40 / barTicks).ticks, barTicks);
  // Snap's Bar grid and Adapt to Zoom's coarsest step.
  assert.equal(gridStepTicks('bar'), barTicks);
  assert.equal(ADAPT_STEPS_TICKS[ADAPT_STEPS_TICKS.length - 1], barTicks);
  // The position display: beat `beats` is a beat of bar 1, beat `beats + 1` is not.
  assert.notEqual(parsePosition(`1.${TIME_SIGNATURE.beats}`, [], RATE, 'bars'), null);
  assert.equal(parsePosition(`1.${TIME_SIGNATURE.beats + 1}`, [], RATE, 'bars'), null);
  assert.equal(parsePosition('2', [], RATE, 'bars'), String(ticksToFrames(barTicks, [], RATE)));
  assert.equal(formatPosition(String(ticksToFrames(barTicks, [], RATE)), [], RATE, 'bars'), '2.1.000');
  // The locator display rolls to bar 2 at the same tick.
  assert.equal(barBeat(BigInt(ticksToFrames(barTicks - TICKS_PER_QUARTER, [], RATE)), [], RATE), `1.${TIME_SIGNATURE.beats}`);
  assert.equal(barBeat(BigInt(ticksToFrames(barTicks, [], RATE)), [], RATE), '2.1');
});

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

// The code of a source, its comments removed (line and block comments).
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

test('the Sig cell and the bar maths import the metre from timeline/musical-time; no other source declares one', () => {
  const importsMetre = (rel: string, names: RegExp) => {
    const text = code(path.join(RENDERER, rel));
    const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)].filter(([, , from]) => /(^|\/)(timeline\/)?musical-time$/.test(from!));
    assert.ok(imports.length > 0, `${rel} imports from musical-time`);
    assert.match(imports.map(([, list]) => list).join(','), names, rel);
  };
  importsMetre(path.join('shell', 'Transport.tsx'), /\bformatSignature\b/);
  importsMetre(path.join('timeline', 'ruler.ts'), /\bTICKS_PER_BAR\b/);
  importsMetre(path.join('timeline', 'snap.ts'), /\bTICKS_PER_BAR\b/);
  importsMetre(path.join('timeline', 'transport-time.ts'), /\bBEATS_PER_BAR\b/);
  importsMetre(path.join('timeline', 'locators.ts'), /\bTICKS_PER_BAR\b/);

  const files = sources(RENDERER);
  assert.ok(files.some((f) => f.endsWith(path.join('timeline', 'musical-time.ts'))), `no sources found under ${RENDERER}`);
  const found: string[] = [];
  for (const file of files) {
    const rel = path.relative(RENDERER, file);
    if (rel === path.join('timeline', 'musical-time.ts')) continue;
    const text = code(file);
    if (/\b(const|let|var)\s+(BEATS_PER_BAR|TICKS_PER_BAR|BEAT_UNIT|TIME_SIGNATURE)\b/.test(text)) found.push(`${rel}: declares a metre`);
    if (rel.startsWith(`i18n${path.sep}`)) continue;
    if (/\b4\s*\/\s*4\b/.test(text)) found.push(`${rel}: a 4/4 literal`);
  }
  assert.deepEqual(found, []);
});
