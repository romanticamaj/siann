// The renderer's hashes (spec, "Canonical JSON and hashes") against the shared
// fixtures the Node bridge and the C++ engine already pass: RFC 8785 cases,
// the RFC 6962 reference roots, the document-hash vectors, and a real session
// document with a track that has inserts and a plugin slot.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalize,
  documentHash,
  entityHash,
  entityRef,
  HashError,
  leafHash,
  sha256Jcs,
  treeHash,
} from '../../src/renderer/model/hash';
import { readFixture } from './support/fixtures';

interface JcsCases {
  valid: Array<{ name: string; input: string; canonical: string; sha256: string }>;
  invalid: Array<{ name: string; input: string; error: string }>;
}

interface HashedEntity {
  type: string;
  id: string;
  entityHash: string;
}

interface DocumentCases {
  valid: Array<{ name: string; entities: HashedEntity[]; documentHash: string }>;
  invalid: Array<{ name: string; entities: HashedEntity[]; error: string }>;
}

interface ModelFixture {
  document: {
    root: { id: string } & Record<string, unknown>;
    media: Array<{ id: string } & Record<string, unknown>>;
    tracks: Array<{ id: string } & Record<string, unknown>>;
    clips: Array<{ id: string } & Record<string, unknown>>;
    pluginSlots: Array<{ id: string } & Record<string, unknown>>;
  };
  entityHashes: HashedEntity[];
  documentHash: string;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

test('canonicalize and sha256Jcs match every valid RFC 8785 case', async () => {
  const cases = readFixture<JcsCases>('jcs', 'cases.json');
  assert.ok(cases.valid.length >= 5);
  for (const c of cases.valid) {
    const value: unknown = JSON.parse(c.input);
    assert.equal(canonicalize(value), c.canonical, c.name);
    assert.equal(await sha256Jcs(value), c.sha256, c.name);
  }
});

test('canonicalize rejects the invalid RFC 8785 cases with their codes', () => {
  const cases = readFixture<JcsCases>('jcs', 'cases.json');
  assert.ok(cases.invalid.length >= 2);
  for (const c of cases.invalid) {
    const value: unknown = JSON.parse(c.input);
    assert.throws(() => canonicalize(value), (error: unknown) => error instanceof HashError && error.code === c.error, c.name);
  }
});

test('canonicalize writes -0 as 0 and rejects NaN, Infinity and non-JSON values', () => {
  assert.equal(canonicalize({ b: -0, a: [1.5, -0] }), '{"a":[1.5,0],"b":0}');
  for (const bad of [NaN, Infinity, -Infinity, { x: NaN }, [Infinity], () => 1, 10n, new Date(0)]) {
    assert.throws(() => canonicalize(bad), (error: unknown) => error instanceof HashError);
  }
  // A property whose value is undefined is omitted, like a JSON round trip.
  assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
});

test('treeHash gives the RFC 6962 reference roots for 0 to 8 leaves', async () => {
  const fixture = readFixture<{ leafInputsHex: string[]; roots: string[] }>('hash', 'rfc6962.json');
  assert.equal(fixture.roots.length, 9);
  const leaves: Uint8Array[] = [];
  for (const input of fixture.leafInputsHex) leaves.push(await leafHash(Buffer.from(input, 'hex')));
  for (let n = 0; n <= leaves.length; n += 1) {
    assert.equal(hex(await treeHash(leaves.slice(0, n))), fixture.roots[n], `${n} leaves`);
  }
});

test('documentHash matches the document-hash vectors and rejects the invalid ones', async () => {
  const cases = readFixture<DocumentCases>('hash', 'document.json');
  assert.ok(cases.valid.length >= 4);
  for (const c of cases.valid) {
    assert.equal(await documentHash(c.entities), c.documentHash, c.name);
  }
  assert.ok(cases.invalid.length >= 3);
  for (const c of cases.invalid) {
    await assert.rejects(documentHash(c.entities), (error: unknown) => error instanceof HashError && error.code === c.error, c.name);
  }
});

test('entityHash and documentHash reproduce a real session document', async () => {
  const fixture = readFixture<ModelFixture>('model', 'session-document-v1.json');
  const doc = fixture.document;
  const entities: Array<[string, { id: string } & Record<string, unknown>]> = [
    ['root', doc.root],
    ...doc.media.map((e) => ['media', e] as [string, typeof e]),
    ...doc.tracks.map((e) => ['track', e] as [string, typeof e]),
    ...doc.clips.map((e) => ['clip', e] as [string, typeof e]),
    ...doc.pluginSlots.map((e) => ['plugin_slot', e] as [string, typeof e]),
  ];
  assert.ok(doc.tracks.some((t) => Array.isArray(t.inserts)), 'the fixture has a track with inserts');
  const computed: HashedEntity[] = [];
  for (const [type, entity] of entities) {
    computed.push({ type, id: entity.id, entityHash: await entityHash(entity) });
  }
  assert.deepEqual(
    [...computed].sort((a, b) => entityRef(a.type, a.id).localeCompare(entityRef(b.type, b.id))),
    [...fixture.entityHashes].sort((a, b) => entityRef(a.type, a.id).localeCompare(entityRef(b.type, b.id))),
  );
  assert.equal(await documentHash(computed), fixture.documentHash);
});

test('entityRef is "<type>:<id>"', () => {
  assert.equal(entityRef('root', 'root'), 'root:root');
  assert.equal(entityRef('plugin_slot', 'slt_eq'), 'plugin_slot:slt_eq');
});
