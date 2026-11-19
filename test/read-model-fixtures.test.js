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
  if (document.master) entities.push({ type: 'master', id: 'master', entityHash: sha256Jcs(document.master) });
  for (const entity of document.buses || []) entities.push({ type: 'bus', id: entity.id, entityHash: sha256Jcs(entity) });
  for (const entity of document.sends || []) entities.push({ type: 'send', id: entity.id, entityHash: sha256Jcs(entity) });
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

// m5b-engine-master: the master part continues the locators steps.
test('the master steps add, modify and remove master:master and hash with src/hash', () => {
  const { steps, sync, both } = fixture.master;
  assert.deepEqual(steps.map((s) => s.event.changedIds), [
    [{ ref: 'master:master', change: 'added' }],
    [{ ref: 'master:master', change: 'modified' }],
    [{ ref: 'master:master', change: 'removed' }],
  ]);
  assert.deepEqual(steps.map((s) => s.document.master?.gainMilliDb ?? null), [-6000, -3000, null]);
  let seq = Number(fixture.locators.steps[fixture.locators.steps.length - 1].event.seq);
  for (const step of steps) {
    seq += 1;
    assert.equal(step.event.seq, String(seq));
    assert.equal(hashDocument(step.document), step.documentHash);
    assert.equal(step.event.documentHash, step.documentHash);
    for (const answer of step.fetch.result.entities) assert.deepEqual(answer.entity, step.document.master);
  }
  // Set back to 0 dB, the document hashes as before the first set.
  assert.equal(steps[2].documentHash, fixture.locators.steps[fixture.locators.steps.length - 1].documentHash);
  assert.deepEqual(steps[0].document.master, { schema: 'siann.entity.master.v1', id: 'master', gainMilliDb: -6000 });
  // The sync: the master once, as an object in the last chunk.
  const holding = sync.filter((chunk) => 'master' in chunk.chunk);
  assert.equal(holding.length, 1);
  assert.equal(holding[0], sync[sync.length - 1]);
  assert.deepEqual(holding[0].chunk.master, steps[0].document.master);
  assert.equal(sync[0].documentHash, steps[0].documentHash);
  // Both singletons: the master after the locators, in a chunk of its own here.
  assert.equal(hashDocument(both.document), both.documentHash);
  const last = both.sync[both.sync.length - 1];
  assert.deepEqual(Object.keys(last.chunk).filter((k) => k === 'locators' || k === 'master'), ['master']);
  assert.ok('locators' in both.sync[both.sync.length - 2].chunk);
  for (const chunk of both.sync) assert.equal(chunk.documentHash, both.documentHash);
});

// m5b-engine-clip-fades: the fade part continues the master steps; removing the
// fades returns the clip and the document to their earlier hashes.
test('the fade steps set and remove the fades of clp_1 and hash with src/hash', () => {
  const { steps, before } = fixture.fades;
  const masterEnd = fixture.master.steps[fixture.master.steps.length - 1];
  assert.equal(before.documentHash, masterEnd.documentHash);
  assert.deepEqual(steps.map((s) => s.event.changedIds), [
    [{ ref: 'clip:clp_1', change: 'modified' }],
    [{ ref: 'clip:clp_1', change: 'modified' }],
  ]);
  const clp1 = (step) => step.document.clips.find((c) => c.id === 'clp_1');
  assert.deepEqual(clp1(steps[0]).fadeIn, { length: '480', curve: 'linear' });
  assert.deepEqual(clp1(steps[0]).fadeOut, { length: '960', curve: 'equal_power' });
  assert.equal('fadeIn' in clp1(steps[1]) || 'fadeOut' in clp1(steps[1]), false);
  let seq = Number(masterEnd.event.seq);
  for (const step of steps) {
    seq += 1;
    assert.equal(step.event.seq, String(seq));
    assert.equal(hashDocument(step.document), step.documentHash);
    assert.equal(step.event.documentHash, step.documentHash);
    assert.deepEqual(step.fetch.result.entities, [{ ref: 'clip:clp_1', entity: clp1(step) }]);
  }
  assert.notEqual(steps[0].documentHash, before.documentHash);
  assert.equal(steps[1].documentHash, before.documentHash);
  assert.equal(sha256Jcs(clp1(steps[1])), sha256Jcs(masterEnd.document.clips.find((c) => c.id === 'clp_1')));
});

// m5b-engine-track-notes: the notes part continues the master steps; notes ""
// removes the field and returns the track and the document to their hashes.
test('the notes steps set and remove the notes of trk_1 and hash with src/hash', () => {
  const { steps, before, text } = fixture.notes;
  const masterEnd = fixture.master.steps[fixture.master.steps.length - 1];
  assert.equal(before.documentHash, masterEnd.documentHash);
  assert.deepEqual(steps.map((s) => s.event.changedIds), [
    [{ ref: 'track:trk_1', change: 'modified' }],
    [{ ref: 'track:trk_1', change: 'modified' }],
  ]);
  const trk1 = (step) => step.document.tracks.find((t) => t.id === 'trk_1');
  assert.match(text, /\n/);
  assert.equal(trk1(steps[0]).notes, text);
  assert.equal('notes' in trk1(steps[1]), false);
  let seq = Number(masterEnd.event.seq);
  for (const step of steps) {
    seq += 1;
    assert.equal(step.event.seq, String(seq));
    assert.equal(hashDocument(step.document), step.documentHash);
    assert.equal(step.event.documentHash, step.documentHash);
    assert.deepEqual(step.fetch.result.entities, [{ ref: 'track:trk_1', entity: trk1(step) }]);
  }
  assert.notEqual(steps[0].documentHash, before.documentHash);
  assert.equal(steps[1].documentHash, before.documentHash);
  assert.equal(sha256Jcs(trk1(steps[1])), sha256Jcs(masterEnd.document.tracks.find((t) => t.id === 'trk_1')));
});

// m5b-engine-plan-metadata: a plan.changed with the plan metadata and the
// rejection note, and an agent.changed, right after the base sync. The read model
// does not model either: it advances lastSeq past them (app/test/unit/
// session-client.test.ts replays them) and nothing else changes.
test('the unmodelled events follow the base sync and carry the documented payloads', () => {
  const { events } = fixture.unmodelled;
  assert.deepEqual(events.map((e) => e.type), ['plan.changed', 'agent.changed']);
  events.forEach((event, i) => {
    assert.equal(event.schema, 'siann.event.v1');
    assert.equal(event.sessionId, fixture.sessionId);
    assert.equal(event.seq, String(Number(fixture.base.seq) + i + 1));
    assert.equal(event.revision, fixture.base.revision);
  });
  const [plan, agent] = events;
  assert.match(plan.plan, /^sha256:[0-9a-f]{64}$/);
  assert.equal(plan.title, 'Lower the drums');
  assert.ok(Buffer.byteLength(plan.title, 'utf8') <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(plan.title));
  assert.ok(Buffer.byteLength(plan.intent, 'utf8') <= 2000);
  assert.deepEqual(plan.actor, { kind: 'mcp', name: 'mix-assistant' });
  assert.equal(plan.rejectionNote, 'Too much; try -3 dB');
  assert.deepEqual(Object.keys(agent.agent).sort(),
    ['connected', 'id', 'lastAction', 'lastActionAt', 'name', 'transport']);
  assert.match(agent.agent.id, /^agt_[0-9a-f]+$/);
  assert.equal(agent.agent.transport, 'mcp');
  assert.equal(agent.agent.lastAction, 'submit_plan');
});

// m5b-engine-buses-sends: the buses part continues the master steps in format v3.
test('the bus steps add, modify and remove bus:b1 and send:s1 and hash with src/hash', () => {
  const { steps, sync } = fixture.buses;
  assert.deepEqual(steps.map((s) => s.event.changedIds.map((c) => `${c.ref}/${c.change}`)), [
    ['root:root/modified', 'track:trk_1/modified', 'bus:b1/added', 'send:s1/added'],
    ['bus:b1/modified'],
    ['root:root/modified', 'track:trk_1/modified', 'bus:b1/removed', 'send:s1/removed'],
  ]);
  for (const step of steps) {
    assert.equal(step.document.schemaVersion, 'siann.session_document.v3');
    assert.equal(hashDocument(step.document), step.documentHash);
  }
  // Removed again, the document hashes as before the bus.
  const master = fixture.master.steps;
  assert.equal(steps[2].documentHash, master[master.length - 1].documentHash);
  assert.equal(steps[1].document.buses[0].gainMilliDb, -6000);
  // The sync: each table once, buses before sends, after every other entity.
  const buses = sync.filter((chunk) => 'buses' in chunk.chunk);
  const sends = sync.filter((chunk) => 'sends' in chunk.chunk);
  assert.equal(buses.length, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0], sync[sync.length - 1]);
  assert.deepEqual(buses[0].chunk.buses, steps[0].document.buses);
  assert.deepEqual(sends[0].chunk.sends, steps[0].document.sends);
  for (const chunk of sync) assert.equal(chunk.documentHash, steps[0].documentHash);
});
