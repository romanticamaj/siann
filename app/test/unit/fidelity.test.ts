// The mockup fidelity gate's pure half (test/e2e/support/fidelity-core.ts):
// who owns a part, the geometry and computed-style comparison, the PNG
// reader and writer, the masked pixel comparison and what fails the gate.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareParts,
  crop,
  decodePng,
  diffRegion,
  encodePng,
  failures,
  globToRegExp,
  markdownReport,
  ownerOf,
  styleDiff,
  type GateReport,
  type Image,
  type Manifest,
  type Part,
} from '../e2e/support/fidelity-core';

const MANIFEST: Manifest = {
  schemaVersion: 'siann.fidelity.v1',
  mockup: 'mockup.html',
  viewport: { width: 100, height: 50, deviceScaleFactor: 1 },
  locales: { en: { query: '', languages: ['en-US'] } },
  regions: ['top-bar'],
  geometry: { tolerancePx: 1 },
  styles: ['color', 'border-top-width', 'border-top-color', 'border-top-style'],
  pixels: { channelTolerance: 16, maxMismatch: 0.005, dynamic: ['display-*'] },
  gates: { 'm5-align': 'report', 'm5b-ghosts': 'pending', 'm5b-done': 'enforce' },
  rules: [
    { match: ['*ghost*'], feature: 'm5b-ghosts', gate: 'm5b-ghosts' },
    { match: ['dsp-load'], feature: null, gate: null, unowned: 'needs E-13' },
    { match: ['fader-*'], feature: 'm5b-done', gate: 'm5b-done' },
    { match: ['top-bar', 'strip-*'], feature: 'm5-ui-mixer', gate: 'm5-align' },
  ],
};

const part = (id: string, x: number, y: number, w: number, h: number, styles?: Record<string, string>): Part => ({ id, x, y, w, h, styles });
const STYLE = { color: 'rgb(1, 2, 3)', 'border-top-width': '0px', 'border-top-color': 'rgb(0, 0, 0)', 'border-top-style': 'none' };

test('a glob matches whole ids, and * any run of characters', () => {
  assert.ok(globToRegExp('strip-*-mute').test('strip-3-mute'));
  assert.ok(!globToRegExp('strip-*-mute').test('strip-3-mute-x'));
  assert.ok(globToRegExp('*ghost*').test('strip-6-cap-ghost'));
  assert.ok(!globToRegExp('tool-1').test('tool-10'));
});

test('the first matching rule owns a part; its gate gives the mode', () => {
  assert.deepEqual(ownerOf(MANIFEST, 'strip-ghost-name'), { feature: 'm5b-ghosts', gate: 'm5b-ghosts', mode: 'pending' });
  assert.deepEqual(ownerOf(MANIFEST, 'strip-2'), { feature: 'm5-ui-mixer', gate: 'm5-align', mode: 'report' });
  assert.deepEqual(ownerOf(MANIFEST, 'dsp-load'), { feature: null, gate: null, mode: 'unowned', unowned: 'needs E-13' });
  assert.equal(ownerOf(MANIFEST, 'nobody'), null);
});

test('a border\'s colour and style are not compared while its width is zero on both sides', () => {
  const properties = MANIFEST.styles;
  assert.deepEqual(styleDiff(STYLE, { ...STYLE, 'border-top-color': 'rgb(9, 9, 9)', 'border-top-style': 'solid' }, properties), {});
  assert.deepEqual(styleDiff({ ...STYLE, 'border-top-width': '1px' }, { ...STYLE, 'border-top-color': 'rgb(9, 9, 9)' }, properties), {
    'border-top-width': ['1px', '0px'],
    'border-top-color': ['rgb(0, 0, 0)', 'rgb(9, 9, 9)'],
  });
  assert.deepEqual(styleDiff(STYLE, { ...STYLE, color: 'rgb(1, 2, 4)' }, properties), { color: ['rgb(1, 2, 3)', 'rgb(1, 2, 4)'] });
});

test('parts compare within one pixel and by identical styles; pending and unowned parts are skipped', () => {
  const mockup = [
    part('top-bar', 0, 0, 100, 10, STYLE),
    part('strip-1', 0, 10, 20, 40, STYLE),
    part('strip-2', 20, 10, 20, 40, STYLE),
    part('strip-3', 40, 10, 20, 40, STYLE),
    part('strip-ghost', 60, 10, 20, 40, STYLE),
    part('dsp-load', 90, 0, 10, 10, STYLE),
    part('nobody', 0, 0, 1, 1),
  ];
  const app = [
    part('top-bar', 0, 0, 100, 10.9, STYLE),
    part('strip-1', 0, 12, 20, 40, STYLE),
    part('strip-2', 20, 10, 20, 40, { ...STYLE, color: 'rgb(9, 9, 9)' }),
  ];
  const result = compareParts(MANIFEST, mockup, app);
  assert.equal(result.compared, 4);
  assert.equal(result.matched, 1, 'the top bar: 0.9 px is within tolerance');
  assert.deepEqual(result.unruled, ['nobody']);
  assert.deepEqual(result.skipped.map((s) => [s.id, s.mode]), [['strip-ghost', 'pending'], ['dsp-load', 'unowned']]);
  const byId = new Map(result.findings.map((f) => [f.id, f]));
  assert.equal(byId.get('strip-1')!.kind, 'geometry');
  assert.deepEqual(byId.get('strip-1')!.delta, { x: 0, y: 2, w: 0, h: 0 });
  assert.equal(byId.get('strip-2')!.kind, 'style');
  assert.deepEqual(byId.get('strip-2')!.styles, { color: ['rgb(1, 2, 3)', 'rgb(9, 9, 9)'] });
  assert.equal(byId.get('strip-3')!.kind, 'missing');
  // Ranked by impact: the missing strip (its whole area) first.
  assert.equal(result.findings[0]!.id, 'strip-3');
});

function solid(width: number, height: number, rgb: readonly [number, number, number]): Image {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  return { width, height, data };
}

function paint(image: Image, x0: number, y0: number, w: number, h: number, rgb: readonly [number, number, number]): void {
  for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) image.data.set([rgb[0], rgb[1], rgb[2], 255], (y * image.width + x) * 4);
}

test('a PNG survives the writer and the reader, and crop takes a rectangle', () => {
  const image = solid(7, 5, [10, 20, 30]);
  paint(image, 2, 1, 3, 2, [200, 100, 50]);
  const back = decodePng(encodePng(image));
  assert.equal(back.width, 7);
  assert.equal(back.height, 5);
  assert.deepEqual(Array.from(back.data), Array.from(image.data));
  const piece = crop(back, { x: 2, y: 1, w: 3, h: 2 });
  assert.deepEqual([piece.width, piece.height], [3, 2]);
  assert.deepEqual(Array.from(piece.data.subarray(0, 4)), [200, 100, 50, 255]);
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3])), /not a PNG/);
});

test('a region\'s pixels differ beyond the channel tolerance, outside the masks only', () => {
  const mockup = solid(20, 10, [100, 100, 100]);
  const app = solid(20, 10, [100, 100, 100]);
  paint(app, 0, 0, 4, 10, [110, 100, 100]); // within tolerance
  paint(app, 10, 0, 2, 10, [200, 100, 100]); // 20 px differ
  paint(app, 16, 0, 4, 10, [0, 0, 0]); // masked
  const whole = { x: 0, y: 0, w: 20, h: 10 };
  const result = diffRegion('r', mockup, app, whole, [{ x: 16, y: 0, w: 4, h: 10 }], 16);
  assert.deepEqual([result.compared, result.masked, result.mismatched], [160, 40, 20]);
  assert.equal(result.ratio, 20 / 160);
  assert.deepEqual([result.diff.width, result.diff.height], [20, 10]);
  // Without the mask the black block counts.
  assert.equal(diffRegion('r', mockup, app, whole, [], 16).mismatched, 60);
  // A sub-rectangle compares only itself.
  assert.equal(diffRegion('r', mockup, app, { x: 0, y: 0, w: 10, h: 10 }, [], 16).mismatched, 0);
  assert.throws(() => diffRegion('r', mockup, solid(10, 10, [0, 0, 0]), whole, [], 16), /differ in size/);
});

test('only enforced mismatches and unruled parts fail the gate; the report lists the rest', () => {
  const mockup = [part('strip-1', 0, 10, 20, 40, STYLE), part('fader-1', 0, 0, 5, 5, STYLE)];
  const comparison = compareParts(MANIFEST, mockup, []);
  const region = { region: 'top-bar', feature: 'm5-ui-mixer', gate: 'm5-align', mode: 'report' as const, compared: 100, masked: 0, mismatched: 50, ratio: 0.5, over: true, files: { mockup: 'm.png', app: 'a.png', diff: 'd.png' } };
  const report: GateReport = { generated: 't', commit: 'abc', platform: 'p', locales: [{ locale: 'en', comparison, regions: [region], extra: [], notes: [] }] };
  assert.deepEqual(failures(report), ['[en] fader-1: missing (m5b-done)'], 'the report-mode strip and region do not fail');
  const enforced: GateReport = { ...report, locales: [{ ...report.locales[0]!, regions: [{ ...region, mode: 'enforce' }], comparison: { ...comparison, unruled: ['nobody'] } }] };
  assert.equal(failures(enforced).length, 3);
  const text = markdownReport(report, MANIFEST);
  assert.match(text, /# Mockup fidelity report/);
  assert.match(text, /\| top-bar \| 50\.00 % \|/);
  assert.match(text, /`strip-1` \| missing \| m5-ui-mixer/);
  assert.match(text, /1 enforced mismatches/);
});
