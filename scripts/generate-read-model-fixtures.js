#!/usr/bin/env node
// Regenerates fixtures/protocol/read-model-sequence.json.
//
// A session as a client of protocol events v1 sees it
// (docs/schemas/protocol-events-v1.md, "Client read model"): a base document
// served by session.sync in chunks of 2 entities at one pinned revision, then
// three session.changed events with the session.fetch answers at each event's
// revision and the document and documentHash after each step. Hashes come from
// the bridge's fixture-verified src/hash (RFC 8785 and RFC 6962), independent
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

// Every entity of a document in sync order: root, then each table in id order.
function entitiesOf(document) {
  const out = [{ type: 'root', entity: document.root }];
  for (const [table, type] of TABLES) {
    const rows = [...(document[table] || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const entity of rows) out.push({ type, entity });
  }
  return out;
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
  const steps = [];
  let document = clone(BASE);
  let seq = 7;
  let revision = 3;
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
  return steps;
}

function buildFixture() {
  const base = { revision: 'r3', seq: '7', document: BASE, documentHash: hashDocument(BASE) };
  return {
    schemaVersion: 'siann.protocol_fixtures.v1',
    description:
      'A client read model sequence (docs/schemas/protocol-events-v1.md, "Client read model"): session.sync chunks of 2 entities at one pinned revision, then session.changed events with the session.fetch answers at each event revision and the document and documentHash after each step. Generated by scripts/generate-read-model-fixtures.js with the bridge src/hash, independent of the renderer.',
    sessionId: SESSION_ID,
    chunkEntities: CHUNK_ENTITIES,
    base,
    sync: syncChunks(BASE, base.revision, base.seq),
    steps: buildSteps(),
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
