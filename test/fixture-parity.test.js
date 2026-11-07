// The shared fixtures must stay in sync with the Node reference code that
// produced them. The native engine is tested against the same files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { sha256Jcs } = require('../src/hash/jcs');
const { documentHash } = require('../src/hash/merkle');

const generators = {
  time: require('../scripts/generate-time-fixtures'),
  hash: require('../scripts/generate-hash-fixtures'),
  model: require('../scripts/generate-model-fixtures'),
  plan: require('../scripts/generate-plan-fixtures'),
};

for (const [name, generator] of Object.entries(generators)) {
  test(`fixtures for ${name} match their Node generator`, () => {
    const committed = JSON.parse(fs.readFileSync(generator.FIXTURE_FILE, 'utf8'));
    assert.deepEqual(committed, generator.buildFixture());
  });
}

test('model fixture hashes are reproduced by the Node hash code', () => {
  const fixture = JSON.parse(fs.readFileSync(generators.model.FIXTURE_FILE, 'utf8'));
  const { document } = fixture;
  const entities = [
    { type: 'root', entity: document.root },
    ...document.media.map((entity) => ({ type: 'media', entity })),
    ...document.tracks.map((entity) => ({ type: 'track', entity })),
    ...document.clips.map((entity) => ({ type: 'clip', entity })),
    ...document.pluginSlots.map((entity) => ({ type: 'plugin_slot', entity })),
  ];
  for (const { type, entity } of entities) {
    const expected = fixture.entityHashes.find((leaf) => leaf.type === type && leaf.id === entity.id);
    assert.ok(expected, `${type}:${entity.id} is listed`);
    assert.equal(sha256Jcs(entity), expected.entityHash, `${type}:${entity.id}`);
  }
  assert.equal(documentHash(fixture.entityHashes), fixture.documentHash);
});

// Hashes from the M1 fixture, before plugin slots: a track without inserts omits
// the field, so every M1 to M3 document keeps its hashes.
test('tracks without inserts keep their M1 entity hashes', () => {
  const fixture = JSON.parse(fs.readFileSync(generators.model.FIXTURE_FILE, 'utf8'));
  const m1 = {
    'trk-vox': 'sha256:9ce55936e8015ecb36ee95f7fd2ac4e615e609185b4f085ff279c227b14dbec1',
    trk_drums: 'sha256:6dd8852b81ea711a6e90c8ab1528024d52c6543eef3357e4bc36947b758ef426',
  };
  for (const [id, hash] of Object.entries(m1)) {
    const track = fixture.document.tracks.find((entity) => entity.id === id);
    assert.equal(track.inserts, undefined, id);
    assert.equal(fixture.entityHashes.find((leaf) => leaf.type === 'track' && leaf.id === id).entityHash, hash, id);
  }
  const bass = fixture.document.tracks.find((entity) => entity.id === 'trk_bass');
  assert.deepEqual(bass.inserts, ['slt_eq']);
  assert.equal(fixture.document.pluginSlots[0].schema, 'siann.entity.plugin_slot.v1');
});

test('time conversions agree with hand-checked values', () => {
  const { segmentsOf, toAudio, toMusic, superclocksPerQuarter } = generators.time;
  assert.equal(superclocksPerQuarter(120000), 141120000n);
  assert.equal(superclocksPerQuarter(65536), 258398438n);  // .5 rounds to even
  const constant = segmentsOf([[0, 120000]]);
  assert.equal(toAudio(constant, 1, 48000), 12n);   // 12.5 -> 12
  assert.equal(toAudio(constant, 3, 48000), 38n);   // 37.5 -> 38
  assert.equal(toAudio(constant, -1, 48000), -12n);
  assert.equal(toMusic(constant, 24000, 48000), 1920n);
  const steps = segmentsOf([[0, 120000], [3840, 60000]]);
  assert.equal(toAudio(steps, 5760, 48000), 96000n);
  assert.equal(toMusic(steps, 72000, 48000), 4800n);
});
