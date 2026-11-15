// Display-safe names in the bridge (follow-up to #123; spec "siann-model",
// names): a name an agent or a user wrote into a manifest is refused when it
// holds a control character, a bidi formatting character or a line separator;
// a name derived from a file name is stripped of them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assertDisplaySafeName, nameFault, withoutUnsafeCharacters } = require('../src/workflows/display-name');
const { buildDawZipManifest } = require('../src/workflows/daw-zip-manifest');
const { validateManifest } = require('../src/workflows/import-pack');

const UNSAFE = [
  ['\u202e', 'display_unsafe'], // RLO
  ['\u202a', 'display_unsafe'], // LRE
  ['\u2066', 'display_unsafe'], // LRI
  ['\u2069', 'display_unsafe'], // PDI
  ['\u061c', 'display_unsafe'], // ALM
  ['\u200e', 'display_unsafe'], // LRM
  ['\u200f', 'display_unsafe'], // RLM
  ['\u2028', 'display_unsafe'], // line separator
  ['\u2029', 'display_unsafe'], // paragraph separator
  ['\n', 'control'],
  ['\t', 'control'],
  ['\u007f', 'control'],
  ['\u0085', 'control'], // C1
  ['\ud800', 'invalid_text'], // lone high surrogate
  ['\udc00', 'invalid_text'], // lone low surrogate
];

test('nameFault names the first fault, and text in any script is a name', () => {
  for (const [character, fault] of UNSAFE) {
    assert.equal(nameFault(`Vox ${character}Lead`), fault, JSON.stringify(character));
  }
  for (const name of ['Vox Lead', 'שירה', '主唱 Vox', 'Guitar 🎸', 'Drums "Main"', 'é́']) {
    assert.equal(nameFault(name), null, name);
  }
  assert.doesNotThrow(() => assertDisplaySafeName('Keys', 'track.name'));
  assert.throws(() => assertDisplaySafeName('Keys\u202e', 'track.name'), /track\.name must not contain/);
});

test('withoutUnsafeCharacters drops every unsafe character and keeps the rest', () => {
  for (const [character] of UNSAFE) {
    assert.equal(withoutUnsafeCharacters(`a${character}b`), 'ab', JSON.stringify(character));
  }
  assert.equal(withoutUnsafeCharacters('kick\u202evaw.exe'), 'kickvaw.exe');
  assert.equal(withoutUnsafeCharacters('Guitar 🎸 主唱'), 'Guitar 🎸 主唱');
});

function manifest(overrides = {}) {
  return {
    schemaVersion: 'siann.import_pack.v0',
    session: { dir: '/tmp/s', name: 'Song', ...overrides.session },
    tracks: [{ name: overrides.trackName ?? 'Vox' }],
    assets: [{
      id: 'a1',
      path: '/tmp/a.wav',
      trackName: overrides.trackName ?? 'Vox',
      regionName: overrides.regionName ?? 'Vox take',
      start: '0',
    }],
  };
}

test('an import-pack manifest refuses an unsafe session, track or region name', () => {
  assert.doesNotThrow(() => validateManifest(manifest()));
  assert.doesNotThrow(() => validateManifest(manifest({ trackName: 'שירה 主唱' })));
  for (const [character] of UNSAFE) {
    assert.throws(() => validateManifest(manifest({ session: { name: `Song${character}` } })), /session\.name must not contain/);
    assert.throws(() => validateManifest(manifest({ trackName: `Vox${character}` })), /track\.name must not contain/);
    assert.throws(() => validateManifest(manifest({ regionName: `Take${character}` })), /regionName must not contain/);
  }
});

test('names the DAW-pack intake derives from file names are stripped, not refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-display-name-'));
  try {
    fs.mkdirSync(path.join(root, '_DAW'), { recursive: true });
    fs.mkdirSync(path.join(root, '_SpliceSFX'), { recursive: true });
    fs.writeFileSync(path.join(root, '_DAW', '00m05s_BGM01_Dawn\u202eratiug_a.wav'), 'RIFF placeholder');
    fs.writeFileSync(path.join(root, '_SpliceSFX', 'SFX_C01_01m03s_wood\u2066box.wav'), 'RIFF placeholder');
    const built = buildDawZipManifest(root, { outRoot: path.join(root, 'out') });
    assert.deepEqual(built.tracks.map((track) => track.name), ['BGM01 Dawnratiug', 'SFX C01 woodbox']);
    assert.deepEqual(built.assets.map((asset) => asset.regionName), ['BGM01 Dawnratiug a', 'SFX C01 woodbox']);
    assert.doesNotThrow(() => validateManifest(built));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
