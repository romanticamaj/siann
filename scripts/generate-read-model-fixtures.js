#!/usr/bin/env node
// Regenerates fixtures/protocol/read-model-sequence.json.
//
// A session as a client of protocol events v1 sees it
// (docs/schemas/protocol-events-v1.md, "Client read model"): a base document
// served by session.sync in chunks of 2 entities at one pinned revision, then
// three session.changed events with the session.fetch answers at each event's
// revision and the document and documentHash after each step. A second part
// (m5-ui-engine-loop-click) continues the session with the singleton locators
// entity: deltas that add, modify and remove locators:locators, and a sync of a
// document that holds it (a single object after pluginSlots). A third part
// (m5b-engine-master) does the same for the singleton master entity, and syncs a
// document holding both singletons (master after locators). A fourth part
// (m5b-engine-plan-metadata) is two events the read model does not model, right
// after the base sync: a plan.changed with the plan metadata and an
// agent.changed; a client advances lastSeq past them and changes nothing else.
// A fifth part (m5b-engine-buses-sends) adds a bus and a send, changes the bus and removes it
// with its send, and syncs a document holding them (buses and sends after the
// master, each table only in a chunk that holds rows). A sixth part
// (m5b-engine-clip-fades), also after the master steps and independent of the
// fifth, sets both fades on clp_1 and then removes them (clip.set_fade with
// length "0"), so its hash and the document hash return to the values before
// the first step. Hashes come from the bridge's fixture-verified src/hash (RFC 8785 and RFC 6962), independent
// of the renderer code the fixture tests.
const fs = require('node:fs');
const path = require('node:path');

const { sha256Jcs } = require('../src/hash/jcs');
const { documentHash } = require('../src/hash/merkle');

const SESSION_ID = 'ses_00c0ffee00c0ffee';
const CHUNK_ENTITIES = 2;
const TABLES = [
  ['media', 'media'],
  ['tracks', 'track'],
  ['clips', 'clip'],
  ['pluginSlots', 'plugin_slot'],
];

const hashOf = (text) => sha256Jcs({ text });

function track(id, name, overrides = {}) {
  return {
    schema: 'siann.entity.track.v1',
    id,
    name,
    kind: 'audio',
    channels: 2,
    gainMilliDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    ...overrides,
  };
}

function clip(id, trackId, mediaId, overrides = {}) {
  return {
    schema: 'siann.entity.clip.v1',
    id,
    trackId,
    mediaId,
    position: { domain: 'audio', value: '0' },
    sourceStart: '0',
    length: '48000',
    gainMilliDb: 0,
    ...overrides,
  };
}

function root(trackOrder) {
  return {
    schema: 'siann.entity.root.v1',
    id: 'root',
    name: 'Read Model Song',
    sampleRate: 48000,
    tempo: [{ ticks: '0', milliBpm: 120000 }],
    trackOrder,
  };
}

const BASE = {
  schemaVersion: 'siann.session_document.v1',
  root: root(['trk_2', 'trk_1']),
  media: [
    {
      schema: 'siann.entity.media.v1',
      id: 'med_1',
      contentHash: hashOf('loop.wav'),
      format: 'wav',
      channels: 2,
      sampleRate: 48000,
      frames: '96000',
    },
  ],
  tracks: [track('trk_1', 'Drums'), track('trk_2', 'Bass', { gainMilliDb: -3000, inserts: ['slt_1'] })],
  clips: [
    clip('clp_1', 'trk_1', 'med_1'),
    clip('clp_2', 'trk_2', 'med_1', { position: { domain: 'music', value: '3840' }, sourceStart: '24000', length: '24000' }),
  ],
  pluginSlots: [
    {
      schema: 'siann.entity.plugin_slot.v1',
      id: 'slt_1',
      trackId: 'trk_2',
      format: 'clap',
      uid: 'com.siann.test-plugin',
      name: 'SIANN Test Plugin',
      path: '/plugins/siann_test_plugin.clap',
      bypass: false,
    },
  ],
};

// Every entity of a document in sync order: root, each table in id order, then
// the locators when the document has them.
function entitiesOf(document) {
  const out = [{ type: 'root', entity: document.root }];
  for (const [table, type] of TABLES) {
    const rows = [...(document[table] || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const entity of rows) out.push({ type, entity });
  }
  if (document.locators) out.push({ type: 'locators', entity: document.locators });
  if (document.master) out.push({ type: 'master', entity: document.master });
  // Buses and sends after the master, each in id order (m5b-engine-buses-sends).
  for (const [table, type] of [['buses', 'bus'], ['sends', 'send']]) {
    const rows = [...(document[table] || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const entity of rows) out.push({ type, entity });
  }
  return out;
}

function bus(id, overrides = {}) {
  return { schema: 'siann.entity.bus.v1', id, name: `Bus ${id}`, channels: 2, gainMilliDb: 0, pan: 0, mute: false, solo: false, ...overrides };
}

function send(id, trackId, busId) {
  return { schema: 'siann.entity.send.v1', id, trackId, busId, levelMilliDb: 0, pre: false, enabled: true };
}

function locators(left, right) {
  return { schema: 'siann.entity.locators.v1', id: 'locators', left, right };
}

function master(gainMilliDb) {
  return { schema: 'siann.entity.master.v1', id: 'master', gainMilliDb };
}

function hashDocument(document) {
  return documentHash(entitiesOf(document).map(({ type, entity }) => ({ type, id: entity.id, entityHash: sha256Jcs(entity) })));
}

function findEntity(document, ref) {
  const [type, id] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
  return entitiesOf(document).find((e) => e.type === type && e.entity.id === id)?.entity;
}

function syncChunks(document, revision, seq) {
  const order = entitiesOf(document);
  const hash = hashDocument(document);
  const chunks = [];
  for (let offset = 0; offset < order.length; offset += CHUNK_ENTITIES) {
    const slice = order.slice(offset, offset + CHUNK_ENTITIES);
    const chunk = {};
    const rootEntry = slice.find((e) => e.type === 'root');
    if (rootEntry) chunk.root = rootEntry.entity;
    for (const [table, type] of TABLES) {
      const rows = slice.filter((e) => e.type === type).map((e) => e.entity);
      // pluginSlots only in a chunk that holds slots, as read_model.cpp emits it.
      if (table !== 'pluginSlots' || rows.length > 0) chunk[table] = rows;
    }
    // The locators as one object, only in the chunk that holds them.
    const locatorsEntry = slice.find((e) => e.type === 'locators');
    if (locatorsEntry) chunk.locators = locatorsEntry.entity;
    // The master likewise (m5b-engine-master), after the locators.
    const masterEntry = slice.find((e) => e.type === 'master');
    if (masterEntry) chunk.master = masterEntry.entity;
    // Buses and sends only in a chunk that holds rows (m5b-engine-buses-sends).
    for (const [table, type] of [['buses', 'bus'], ['sends', 'send']]) {
      const rows = slice.filter((e) => e.type === type).map((e) => e.entity);
      if (rows.length > 0) chunk[table] = rows;
    }
    const end = offset + slice.length;
    chunks.push({
      revision,
      seq,
      meters: null,
      documentHash: hash,
      entities: order.length,
      chunk,
      next: end < order.length ? `sync_1:${end}` : null,
    });
  }
  return chunks;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

// The steps: what each commit does to the document, and its changedIds.
function buildSteps() {
  return recordSteps(clone(BASE), 7, 3, (commit) => {
    commit(
      (d) => {
        d.tracks.push(track('trk_3', 'Vox', { channels: 1 }));
        d.root.trackOrder = [...d.root.trackOrder, 'trk_3'];
      },
      [
        { ref: 'root:root', change: 'modified' },
        { ref: 'track:trk_3', change: 'added' },
      ],
    );
    commit(
      (d) => {
        d.clips.find((c) => c.id === 'clp_1').gainMilliDb = -6000;
      },
      [{ ref: 'clip:clp_1', change: 'modified' }],
    );
    commit(
      (d) => {
        d.tracks = d.tracks.filter((t) => t.id !== 'trk_3');
        d.root.trackOrder = d.root.trackOrder.filter((id) => id !== 'trk_3');
      },
      [
        { ref: 'root:root', change: 'modified' },
        { ref: 'track:trk_3', change: 'removed' },
      ],
    );
  });
}

// After the base steps: session.set_locators twice, then an undo to none.
function buildLocatorSteps(after) {
  const start = clone(after.document);
  start.schemaVersion = 'siann.session_document.v2';
  return recordSteps(start, Number(after.event.seq), Number(after.event.revision.slice(1)), (commit) => {
    commit((d) => {
      d.locators = locators('96000', '480000');
    }, [{ ref: 'locators:locators', change: 'added' }]);
    commit((d) => {
      d.locators = locators('48000', '480000');
    }, [{ ref: 'locators:locators', change: 'modified' }]);
    commit((d) => {
      delete d.locators;
    }, [{ ref: 'locators:locators', change: 'removed' }]);
  });
}

// After the locators steps: master.set_gain -6000, then -3000, then 0, which
// removes the entity (m5b-engine-master).
function buildMasterSteps(after) {
  return recordSteps(clone(after.document), Number(after.event.seq), Number(after.event.revision.slice(1)), (commit) => {
    commit((d) => {
      d.master = master(-6000);
    }, [{ ref: 'master:master', change: 'added' }]);
    commit((d) => {
      d.master = master(-3000);
    }, [{ ref: 'master:master', change: 'modified' }]);
    commit((d) => {
      delete d.master;
    }, [{ ref: 'master:master', change: 'removed' }]);
  });
}

// After the master steps, in format v3: bus.add b1 with send.add s1 from trk_1,
// bus.set_gain b1 -6000, then bus.remove b1, which removes the send too
// (m5b-engine-buses-sends). changedIds come in the engine's diff order.
function buildBusSteps(after) {
  const start = clone(after.document);
  start.schemaVersion = 'siann.session_document.v3';
  const dropEmpty = (d) => {
    if (d.buses.length === 0) delete d.buses;
    if (d.sends.length === 0) delete d.sends;
    if (d.root.busOrder.length === 0) delete d.root.busOrder;
    const t = d.tracks.find((x) => x.id === 'trk_1');
    if (t.sends.length === 0) delete t.sends;
  };
  return recordSteps(start, Number(after.event.seq), Number(after.event.revision.slice(1)), (commit) => {
    commit((d) => {
      d.buses = [bus('b1')];
      d.sends = [send('s1', 'trk_1', 'b1')];
      d.root.busOrder = ['b1'];
      d.tracks.find((x) => x.id === 'trk_1').sends = ['s1'];
    }, [
      { ref: 'root:root', change: 'modified' },
      { ref: 'track:trk_1', change: 'modified' },
      { ref: 'bus:b1', change: 'added' },
      { ref: 'send:s1', change: 'added' },
    ]);
    commit((d) => {
      d.buses[0].gainMilliDb = -6000;
    }, [{ ref: 'bus:b1', change: 'modified' }]);
    commit((d) => {
      d.buses = [];
      d.sends = [];
      d.root.busOrder = [];
      d.tracks.find((x) => x.id === 'trk_1').sends = [];
      dropEmpty(d);
    }, [
      { ref: 'root:root', change: 'modified' },
      { ref: 'track:trk_1', change: 'modified' },
      { ref: 'bus:b1', change: 'removed' },
      { ref: 'send:s1', change: 'removed' },
    ]);
  });
}

// After the master steps: clip.set_fade on clp_1 (fadeIn linear 480, fadeOut
// equal_power 960), then both sides set to length "0", which removes the fields
// (m5b-engine-clip-fades).
function buildFadeSteps(after) {
  return recordSteps(clone(after.document), Number(after.event.seq), Number(after.event.revision.slice(1)), (commit) => {
    commit((d) => {
      const c = d.clips.find((x) => x.id === 'clp_1');
      c.fadeIn = { length: '480', curve: 'linear' };
      c.fadeOut = { length: '960', curve: 'equal_power' };
    }, [{ ref: 'clip:clp_1', change: 'modified' }]);
    commit((d) => {
      const c = d.clips.find((x) => x.id === 'clp_1');
      delete c.fadeIn;
      delete c.fadeOut;
    }, [{ ref: 'clip:clp_1', change: 'modified' }]);
  });
}

function recordSteps(initial, firstSeq, firstRevision, run) {
  const steps = [];
  let document = initial;
  let seq = firstSeq;
  let revision = firstRevision;
  const commit = (mutate, changedIds) => {
    const parent = `r${revision}`;
    revision += 1;
    seq += 1;
    document = clone(document);
    mutate(document);
    const id = `r${revision}`;
    const hash = hashDocument(document);
    const refs = changedIds.filter((c) => c.change !== 'removed').map((c) => c.ref);
    steps.push({
      event: {
        schema: 'siann.event.v1',
        seq: String(seq),
        sessionId: SESSION_ID,
        revision: id,
        type: 'session.changed',
        parents: [parent],
        cause: 'command',
        actor: 'protocol',
        time: `2026-11-09T00:00:0${revision}Z`,
        documentHash: hash,
        changedIds,
      },
      fetch: {
        params: { refs, revision: id },
        result: {
          revision: id,
          documentHash: hash,
          entities: refs.map((ref) => {
            const entity = findEntity(document, ref);
            return entity ? { ref, entity } : { ref, missing: true };
          }),
        },
      },
      document,
      documentHash: hash,
    });
  };

  run(commit);
  return steps;
}

// m5b-engine-plan-metadata (docs/schemas/protocol-events-v1.md, plan.changed and
// agent.changed): the events that follow the base sync, at the base revision.
function buildUnmodelled(base) {
  const envelope = (offset, type) => ({
    schema: 'siann.event.v1',
    seq: String(Number(base.seq) + offset),
    sessionId: SESSION_ID,
    revision: base.revision,
    type,
  });
  return {
    events: [
      {
        ...envelope(1, 'plan.changed'),
        plan: hashOf('a plan with metadata'),
        state: 'rejected',
        title: 'Lower the drums',
        intent: 'The drums mask the vocal.\nLower them by 6 dB.',
        actor: { kind: 'mcp', name: 'mix-assistant' },
        rejectionNote: 'Too much; try -3 dB',
      },
      {
        ...envelope(2, 'agent.changed'),
        agent: {
          id: 'agt_00c0ffee00c0ffee',
          name: 'mix-assistant',
          transport: 'mcp',
          connected: true,
          lastAction: 'submit_plan',
          lastActionAt: '2026-11-15T10:00:05Z',
        },
      },
    ],
  };
}

function buildFixture() {
  const base = { revision: 'r3', seq: '7', document: BASE, documentHash: hashDocument(BASE) };
  const steps = buildSteps();
  const locatorSteps = buildLocatorSteps(steps[steps.length - 1]);
  const withLocators = locatorSteps[0];
  const masterSteps = buildMasterSteps(locatorSteps[locatorSteps.length - 1]);
  const withMaster = masterSteps[0];
  const withBoth = { ...clone(withMaster.document), locators: locators('96000', '480000') };
  const masterEnd = masterSteps[masterSteps.length - 1];
  const busSteps = buildBusSteps(masterEnd);
  const withBus = busSteps[0];
  const fadeSteps = buildFadeSteps(masterEnd);
  return {
    schemaVersion: 'siann.protocol_fixtures.v1',
    description:
      'A client read model sequence (docs/schemas/protocol-events-v1.md, "Client read model"): session.sync chunks of 2 entities at one pinned revision, then session.changed events with the session.fetch answers at each event revision and the document and documentHash after each step. Generated by scripts/generate-read-model-fixtures.js with the bridge src/hash, independent of the renderer.',
    sessionId: SESSION_ID,
    chunkEntities: CHUNK_ENTITIES,
    base,
    sync: syncChunks(BASE, base.revision, base.seq),
    steps,
    locators: {
      steps: locatorSteps,
      // A sync pinned at the revision that added the locators.
      sync: syncChunks(withLocators.document, withLocators.event.revision, withLocators.event.seq),
    },
    master: {
      steps: masterSteps,
      // A sync pinned at the revision that added the master.
      sync: syncChunks(withMaster.document, withMaster.event.revision, withMaster.event.seq),
      // A document holding the locators and the master: the master is listed
      // after the locators, here across a chunk boundary.
      both: { document: withBoth, documentHash: hashDocument(withBoth), sync: syncChunks(withBoth, 'r20', '30') },
    },
    unmodelled: buildUnmodelled(base),
    buses: {
      steps: busSteps,
      // A sync pinned at the revision that added the bus and the send.
      sync: syncChunks(withBus.document, withBus.event.revision, withBus.event.seq),
    },
    fades: {
      // The document hash before the first fade step; the last step returns to it.
      before: { revision: masterEnd.event.revision, documentHash: masterEnd.documentHash },
      steps: fadeSteps,
    },
  };
}

const FIXTURE_FILE = path.join(__dirname, '..', 'fixtures', 'protocol', 'read-model-sequence.json');

module.exports = { FIXTURE_FILE, buildFixture, entitiesOf, hashDocument };

if (require.main === module) {
  const out = buildFixture();
  fs.mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
  fs.writeFileSync(FIXTURE_FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${FIXTURE_FILE}: ${out.sync.length} sync chunks, ${out.steps.length} steps`);
}
