// Track colours (m5-ui-arrange; UI redesign spec 1.2 and 3.3, "Colour:
// assigned"): until E-2 lets the user choose one, a track's colour is one of
// the 12 palette entries picked by a stable hash of its id, so the same track
// has the same colour in every window and after every restart. The hash is
// 32-bit FNV-1a over the id's UTF-8 bytes; the vectors below were computed
// outside the code under test (offset basis 0x811c9dc5, prime 0x01000193). A
// clip is drawn in three tones of its track's colour: a title strip at 88 %
// over the lane background, a body at 26 %, and a waveform lightened 25 %.
// The canvas takes every colour from tokens.css: no hex literal in its source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TRACK_PALETTE_SIZE, clipTones, fnv1a32, trackColourIndex } from '../../src/renderer/timeline/track-colour';

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

test('three clip tones from the track colour over the lane background', () => {
  // #F0675B over --bg-0 #090A0D: title 0.88, body 0.26, waveform 25 % towards white.
  assert.deepEqual(clipTones('#F0675B', '#090A0D'), { title: '#d45c52', body: '#452221', wave: '#f48d84' });
  // Short hex and rgb() are read too (tokens may use either).
  assert.deepEqual(clipTones('#fff', 'rgb(0, 0, 0)'), { title: '#e0e0e0', body: '#424242', wave: '#ffffff' });
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
