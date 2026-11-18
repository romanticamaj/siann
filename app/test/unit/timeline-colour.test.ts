// Track colours (m5-ui-arrange; UI redesign spec 1.2 and 3.3, "Colour:
// assigned"): until E-2 lets the user choose one, a track's colour is one of
// the 12 palette entries picked by a stable hash of its id, so the same track
// has the same colour in every window and after every restart. The hash is
// 32-bit FNV-1a over the id's UTF-8 bytes; the vectors below were computed
// outside the code under test (offset basis 0x811c9dc5, prime 0x01000193). A
// clip is drawn in draw()'s palette of its track's colour
// (m5-ui-port-arrange-canvas). The canvas takes every colour from tokens.css:
// no hex literal in its source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TRACK_PALETTE_SIZE, clipPalette, fnv1a32, mix, trackColourIndex } from '../../src/renderer/timeline/track-colour';
import { TOKENS } from '../../src/renderer/tokens';

test('the colour index is FNV-1a of the track id modulo the 12 palette entries', () => {
  assert.equal(TRACK_PALETTE_SIZE, 12);
  const vectors: Array<[string, number, number]> = [
    ['', 0x811c9dc5, 1],
    ['trk_a', 0xdf6bf08c, 8],
    ['trk_b', 0xe26bf545, 5],
    ['trk_bass', 0xcbe0125a, 10],
    ['trk_voxlead', 0xbb74d994, 8],
    ['trk_0123456789abcdef', 0xf8e2219d, 1],
  ];
  for (const [id, hash, index] of vectors) {
    assert.equal(fnv1a32(id), hash, id);
    assert.equal(trackColourIndex(id), index, id);
  }
  // Stable: the same id, the same colour.
  assert.equal(trackColourIndex('trk_a'), trackColourIndex('trk_a'));
});

// draw()'s clip(): mixHex(a, b, t) = a + (b - a) * t per channel, rounded.
// The body is the track's colour mixed 74 % into --bg-well (62 % when
// selected); the title strip 12 % into --bg-well (12 % into --select when
// selected) with its text in --bg-well; the waveform's outer layer 12 % into
// --select (28 % selected) at 50 % alpha and its inner layer 25 % into
// --select (45 % selected); the outline --black-a550 at 1 px, --select at
// 1.5 px when selected. The expected values were computed by hand from
// tokens.css: --track-6 #3FC4DD (63, 196, 221), --bg-well #0B0C10 (11, 12, 16),
// --select #FFFFFF.
test("mix is the mockup's mixHex", () => {
  assert.equal(mix('#000000', '#FFFFFF', 0.5), '#808080');
  assert.equal(mix('#3FC4DD', '#0B0C10', 0), '#3fc4dd');
  assert.equal(mix('#3FC4DD', '#0B0C10', 1), '#0b0c10');
  // Short hex and rgb() are read too.
  assert.equal(mix('#fff', 'rgb(0, 0, 0)', 0.25), '#bfbfbf');
});

test("a clip's palette is draw()'s, from the track colour and the tokens", () => {
  assert.equal(TOKENS['track-6'], '#3FC4DD');
  assert.equal(TOKENS['bg-well'], '#0B0C10');
  assert.equal(TOKENS.select, '#FFFFFF');
  const tokens = { bgWell: TOKENS['bg-well'], select: TOKENS.select, outline: TOKENS['black-a550'] };
  // body: 63 + (11 - 63) * .74 = 24.52, 196 - 184 * .74 = 59.84, 221 - 205 * .74 = 69.3
  // title: 63 - 52 * .12 = 56.76, 196 - 184 * .12 = 173.92, 221 - 205 * .12 = 196.4
  // outer: 63 + 192 * .12 = 86.04, 196 + 59 * .12 = 203.08, 221 + 34 * .12 = 225.08
  // inner: 63 + 192 * .25 = 111, 196 + 59 * .25 = 210.75, 221 + 34 * .25 = 229.5
  assert.deepEqual(clipPalette('#3FC4DD', tokens, false), {
    body: '#193c45',
    title: '#39aec4',
    titleText: '#0B0C10',
    waveOuter: '#56cbe1',
    waveOuterAlpha: 0.5,
    waveInner: '#6fd3e6',
    outline: TOKENS['black-a550'],
    outlineWidth: 1,
  });
  // selected body: 63 - 52 * .62 = 30.76, 196 - 184 * .62 = 81.92, 221 - 205 * .62 = 93.9
  // selected title = outer at 12 % into --select: 86.04, 203.08, 225.08
  // selected outer: 63 + 192 * .28 = 116.76, 196 + 59 * .28 = 212.52, 221 + 34 * .28 = 230.52
  // selected inner: 63 + 192 * .45 = 149.4, 196 + 59 * .45 = 222.55, 221 + 34 * .45 = 236.3
  assert.deepEqual(clipPalette('#3FC4DD', tokens, true), {
    body: '#1f525e',
    title: '#56cbe1',
    titleText: '#0B0C10',
    waveOuter: '#75d5e7',
    waveOuterAlpha: 0.5,
    waveInner: '#95dfec',
    outline: '#FFFFFF',
    outlineWidth: 1.5,
  });
});

test('the canvas sources hold no hex colour literal (colours come from tokens.css)', () => {
  // dist/test/unit -> app/src/renderer/timeline
  const dir = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer', 'timeline');
  for (const file of ['TimelineCanvas.ts', 'HeaderMeters.ts']) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const hex = text.match(/['"`]#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(hex, [], file);
  }
});
