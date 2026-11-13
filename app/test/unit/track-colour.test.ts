// Track colours (UI redesign spec 1.2 and 3.0): assigned in the renderer from
// a stable hash of the track id until the document carries a colour (E-2).
// The palette is the spec's twelve colours, which tokens.css holds as
// --track-1..--track-12; violet (--ai) is never one of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { TRACK_PALETTE, trackColour } from '../../src/renderer/track-colour';

// dist/test/unit -> app/renderer/tokens.css
const TOKENS = path.resolve(__dirname, '..', '..', '..', 'renderer', 'tokens.css');

const SPEC_PALETTE = ['#F0675B', '#F2994A', '#E6C547', '#A8D05A', '#57C98A', '#3FC4A8', '#3FC4DD', '#5B8FF5', '#7C7CF0', '#B57BEA', '#EC6BB0', '#9AA3B2'];

test('the palette is the spec\'s twelve colours and the tokens hold them', () => {
  assert.deepEqual([...TRACK_PALETTE].map((c) => c.toUpperCase()), SPEC_PALETTE);
  const css = fs.readFileSync(TOKENS, 'utf8');
  SPEC_PALETTE.forEach((colour, i) => {
    assert.match(css, new RegExp(`--track-${i + 1}:\\s*${colour};`, 'i'), `--track-${i + 1}`);
  });
  assert.ok(!SPEC_PALETTE.includes('#A78BFF'), 'violet is the agent\'s');
});

test('stable for an id and taken from the palette', () => {
  for (const id of ['trk_a', 'trk_bass', 'trk_mix', 'x']) {
    assert.equal(trackColour(id), trackColour(id));
    assert.ok(SPEC_PALETTE.includes(trackColour(id).toUpperCase()), id);
  }
});

test('different ids spread over the palette', () => {
  const ids = ['trk_drums', 'trk_bass', 'trk_keys', 'trk_vox', 'trk_fx', 'trk_pad', 'trk_gtr', 'trk_mix', 'trk_a', 'trk_b', 'trk_c', 'trk_d'];
  const colours = new Set(ids.map(trackColour));
  assert.ok(colours.size >= 6, `${colours.size} colours for ${ids.length} ids`);
});
