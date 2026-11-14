// The read-model sequence fixture (fixtures/protocol/read-model-sequence.json)
// that the renderer's unit tests replay must stay honest: it matches its
// generator, its sync chunks concatenate to the base document, its fetch
// answers are the documents' entities, and every documentHash is what the
// fixture-verified src/hash computes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { sha256Jcs } = require('../src/hash/jcs');
const { documentHash } = require('../src/hash/merkle');
const generator = require('../scripts/generate-read-model-fixtures');

const fixture = JSON.parse(fs.readFileSync(generator.FIXTURE_FILE, 'utf8'));

const TABLES = [['media', 'media'], ['tracks', 'track'], ['clips', 'clip'], ['pluginSlots', 'plugin_slot']];

// Independent of the generator: hash a document's entities by hand.
function hashDocument(document) {
  const entities = [{ type: 'root', id: 'root', entityHash: sha256Jcs(document.root) }];
  for (const [table, type] of TABLES) {
    for (const entity of document[table] || []) entities.push({ type, id: entity.id, entityHash: sha256Jcs(entity) });
  }
  if (document.locators) entities.push({ type: 'locators', id: 'locators', entityHash: sha256Jcs(document.locators) });
  return documentHash(entities);
}

test('the read-model fixture matches its generator', () => {
  assert.deepEqual(fixture, generator.buildFixture());
});

test('the sync chunks concatenate to the base document at one revision', () => {
  assert.equal(fixture.chunkEntities, 2);
  const joined = { schemaVersion: 'siann.session_document.v1', root: null, media: [], tracks: [], clips: [], pluginSlots: [] };
  fixture.sync.forEach((chunk, i) => {
    assert.equal(chunk.revision, fixture.base.revision);
    assert.equal(chunk.seq, fixture.base.seq);
    assert.equal(chunk.documentHash, fixture.base.documentHash);
    const count = (chunk.chunk.root ? 1 : 0) + TABLES.reduce((n, [t]) => n + (chunk.chunk[t] || []).length, 0);
    assert.ok(count <= 2 && count > 0);
    assert.equal(chunk.next, i + 1 < fixture.sync.length ? `sync_1:${2 * (i + 1)}` : null);
    if ('pluginSlots' in chunk.chunk) assert.ok(chunk.chunk.pluginSlots.length > 0, 'pluginSlots only when present');
    if (chunk.chunk.root) joined.root = chunk.chunk.root;
    for (const [t] of TABLES) joined[t].push(...(chunk.chunk[t] || []));
  });
  assert.deepEqual(joined, fixture.base.document);
  assert.equal(hashDocument(fixture.base.document), fixture.base.documentHash);
});

test('each step hashes to its event and fetch documentHash with src/hash', () => {
  assert.equal(fixture.steps.length, 3);
  let seq = Number(fixture.base.seq);
  for (const step of fixture.steps) {
    seq += 1;
    assert.equal(step.event.seq, String(seq));
    assert.equal(step.event.type, 'session.changed');
    assert.equal(hashDocument(step.document), step.documentHash);
    assert.equal(step.event.documentHash, step.documentHash);
    assert.equal(step.fetch.result.documentHash, step.documentHash);
    assert.equal(step.fetch.params.revision, step.event.revision);
    const expectedRefs = step.event.changedIds.filter((c) => c.change !== 'removed').map((c) => c.ref);
    assert.deepEqual(step.fetch.params.refs, expectedRefs);
    for (const answer of step.fetch.result.entities) {
      const [type, id] = answer.ref.split(':');
      const table = type === 'root' ? null : TABLES.find(([, t]) => t === type)[0];
      const entity = table ? step.document[table].find((e) => e.id === id) : step.document.root;
      assert.deepEqual(answer.entity, entity, answer.ref);
    }
  }
  // The steps add a track with a root change, modify a clip, and remove the track.
  assert.deepEqual(fixture.steps.map((s) => s.event.changedIds.map((c) => c.change)), [
    ['modified', 'added'],
    ['modified'],
    ['modified', 'removed'],
  ]);
  assert.notEqual(fixture.steps[0].documentHash, fixture.base.documentHash);
  assert.equal(fixture.steps[2].document.tracks.length, fixture.base.document.tracks.length);
});

// m5-ui-engine-loop-click: the locators part continues the base steps.
test('the locators steps add, modify and remove locators:locators and hash with src/hash', () => {
  const { steps, sync } = fixture.locators;
  assert.deepEqual(steps.map((s) => s.event.changedIds), [
    [{ ref: 'locators:locators', change: 'added' }],
    [{ ref: 'locators:locators', change: 'modified' }],
    [{ ref: 'locators:locators', change: 'removed' }],
  ]);
  let seq = Number(fixture.steps[fixture.steps.length - 1].event.seq);
  for (const step of steps) {
    seq += 1;
    assert.equal(step.event.seq, String(seq));
    assert.equal(step.document.schemaVersion, 'siann.session_document.v2');
    assert.equal(hashDocument(step.document), step.documentHash);
    assert.equal(step.event.documentHash, step.documentHash);
    for (const answer of step.fetch.result.entities) assert.deepEqual(answer.entity, step.document.locators);
  }
  assert.equal(steps[2].documentHash, fixture.steps[fixture.steps.length - 1].documentHash);
  // The sync: locators once, as an object in the last chunk.
  const holding = sync.filter((chunk) => 'locators' in chunk.chunk);
  assert.equal(holding.length, 1);
  assert.equal(holding[0], sync[sync.length - 1]);
  assert.deepEqual(holding[0].chunk.locators, steps[0].document.locators);
  assert.equal(sync[0].documentHash, steps[0].documentHash);
});
