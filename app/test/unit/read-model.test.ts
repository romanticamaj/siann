// The renderer's read model (spec, "Frontend": a read model keyed by revision
// that never owns session truth; "Gestures": a recompile never snaps a held
// fader back). Replays fixtures/protocol/read-model-sequence.json, whose hashes
// come from the bridge's src/hash, not from the code under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ClipEntity, FetchedEntity, MediaEntity, SessionChanged, SyncChunk, TrackEntity } from '../../src/renderer/model/document';
import { parseRef } from '../../src/renderer/model/document';
import { ReadModel, ReadModelError, type Snapshot } from '../../src/renderer/model/read-model';
import { readFixture } from './support/fixtures';
import { sequence } from './support/sequence';

const seq = sequence();
const chunks = seq.sync as unknown as SyncChunk[];
const step = (i: number) => ({
  event: seq.steps[i]!.event as unknown as SessionChanged,
  fetched: seq.steps[i]!.fetch.result.entities as unknown as FetchedEntity[],
  documentHash: seq.steps[i]!.documentHash,
  document: seq.steps[i]!.document,
});

function ids(rows: ReadonlyArray<{ id: string }>): string[] {
  return rows.map((r) => r.id);
}

function track(snapshot: Snapshot, id: string): TrackEntity {
  const entity = snapshot.entities[`track:${id}`];
  assert.ok(entity, `track:${id} is in the snapshot`);
  return entity as TrackEntity;
}

test('(a) fromSync builds one snapshot at the pinned revision with ordered tables', async () => {
  const model = new ReadModel();
  assert.equal(model.getSnapshot(), null);
  const snapshot = await model.fromSync(chunks);
  assert.equal(snapshot.revision, seq.base.revision);
  assert.equal(snapshot.seq, seq.base.seq);
  assert.equal(snapshot.documentHash, seq.base.documentHash);
  const doc = seq.base.document;
  assert.deepEqual(snapshot.root, doc.root);
  assert.deepEqual(ids(snapshot.media), ids(doc.media));
  assert.deepEqual(ids(snapshot.tracks), ['trk_1', 'trk_2']);
  assert.deepEqual(ids(snapshot.clips), ['clp_1', 'clp_2']);
  assert.deepEqual(ids(snapshot.pluginSlots), ['slt_1']);
  assert.deepEqual(snapshot.trackOrder, ['trk_2', 'trk_1']);
  assert.deepEqual(Object.keys(snapshot.entities).sort(), [
    'clip:clp_1', 'clip:clp_2', 'media:med_1', 'plugin_slot:slt_1', 'root:root', 'track:trk_1', 'track:trk_2',
  ]);
  assert.deepEqual(snapshot.entities['plugin_slot:slt_1'], doc.pluginSlots[0]);
});

test('(a) getSnapshot keeps its identity until the next apply, then changes it (useSyncExternalStore)', async () => {
  const model = new ReadModel();
  const notified: number[] = [];
  const unsubscribe = model.subscribe(() => notified.push(1));
  const first = await model.fromSync(chunks);
  assert.equal(model.getSnapshot(), first);
  assert.equal(model.getSnapshot(), model.getSnapshot());
  assert.equal(notified.length, 1);
  const s = step(0);
  const second = await model.applyChanged(s.event, s.fetched);
  assert.notEqual(second, first);
  assert.equal(model.getSnapshot(), second);
  assert.equal(notified.length, 2);
  // The old snapshot is untouched: snapshots are keyed by revision.
  assert.equal(first.revision, seq.base.revision);
  assert.equal(first.entities['track:trk_3'], undefined);
  unsubscribe();
  await model.applyChanged(step(1).event, step(1).fetched);
  assert.equal(notified.length, 2, 'an unsubscribed listener is not called');
});

test('(a) a sync whose chunks do not hash to its documentHash is rejected and replaces nothing', async () => {
  const model = new ReadModel();
  const forged = structuredClone(chunks);
  (forged[1]!.chunk.tracks![0] as { name: string }).name = 'Forged';
  await assert.rejects(model.fromSync(forged), (e: unknown) => e instanceof ReadModelError && e.code === 'hash_mismatch');
  assert.equal(model.getSnapshot(), null);
  // Chunks of different revisions are not one sync.
  const mixed = structuredClone(chunks);
  (mixed[2] as { revision: string }).revision = 'r99';
  await assert.rejects(model.fromSync(mixed), (e: unknown) => e instanceof ReadModelError && e.code === 'sync_inconsistent');
});

test('(b) applyChanged adds, modifies and removes, and takes revision, seq and documentHash from the event', async () => {
  const model = new ReadModel();
  await model.fromSync(chunks);
  for (let i = 0; i < seq.steps.length; i += 1) {
    const s = step(i);
    const snapshot = await model.applyChanged(s.event, s.fetched);
    assert.equal(snapshot.revision, s.event.revision, `step ${i}`);
    assert.equal(snapshot.seq, s.event.seq, `step ${i}`);
    assert.equal(snapshot.documentHash, s.documentHash, `step ${i}`);
    assert.deepEqual(ids(snapshot.tracks), ids(s.document.tracks), `step ${i}`);
    assert.deepEqual(snapshot.trackOrder, s.document.root.trackOrder, `step ${i}`);
    assert.deepEqual(snapshot.root, s.document.root, `step ${i}`);
    assert.deepEqual(snapshot.clips, s.document.clips, `step ${i}`);
  }
  const last = model.getSnapshot()!;
  assert.equal(last.entities['track:trk_3'], undefined, 'the removed track is dropped');
  assert.equal((last.entities['clip:clp_1'] as ClipEntity).gainMilliDb, -6000);
});

test('(b) an entity fetched missing: true is dropped; a delta that does not match the event hash is refused', async () => {
  const model = new ReadModel();
  const base = await model.fromSync(chunks);
  const s = step(0);
  // The fetch says the added track no longer exists at that revision: dropped,
  // so the recomputed hash no longer matches the event and nothing applies.
  const missing = s.fetched.map((f) => (f.ref === 'track:trk_3' ? { ref: f.ref, missing: true as const } : f));
  await assert.rejects(model.applyChanged(s.event, missing), (e: unknown) => e instanceof ReadModelError && e.code === 'hash_mismatch');
  assert.equal(model.getSnapshot(), base);
  // A missing entity whose absence is the truth: an event that names a track
  // the fetch reports missing, with the hash of the document without it.
  const dropEvent: SessionChanged = {
    ...step(1).event,
    seq: s.event.seq,
    revision: 'r4',
    documentHash: seq.base.documentHash,
    changedIds: [{ ref: 'track:trk_9', change: 'modified' }],
  };
  const dropped = await model.applyChanged(dropEvent, [{ ref: 'track:trk_9', missing: true }]);
  assert.equal(dropped.entities['track:trk_9'], undefined);
  assert.equal(dropped.revision, 'r4');
  // A fetch that leaves out a changed ref is refused.
  const other = new ReadModel();
  const otherBase = await other.fromSync(chunks);
  await assert.rejects(other.applyChanged(s.event, s.fetched.slice(0, 1)), (e: unknown) => e instanceof ReadModelError && e.code === 'incomplete_fetch');
  assert.equal(other.getSnapshot(), otherBase);
  // Without a snapshot there is nothing to apply a delta to.
  await assert.rejects(new ReadModel().applyChanged(s.event, s.fetched), (e: unknown) => e instanceof ReadModelError && e.code === 'no_snapshot');
});

test('(c) a gesture overlay changes the derived view only, never the committed snapshot', async () => {
  const model = new ReadModel();
  const committed = await model.fromSync(chunks);
  const viewBefore = model.getView();
  model.beginGesture('track:trk_1', 'gainMilliDb');
  model.setGesture(-12000);
  assert.equal((model.select('track:trk_1') as TrackEntity).gainMilliDb, -12000);
  assert.notEqual(model.getView(), viewBefore, 'the view changes with the overlay');
  assert.equal(model.getView(), model.getView());
  assert.equal(model.getSnapshot(), committed);
  assert.equal(track(committed, 'trk_1').gainMilliDb, 0);
  assert.equal(committed.documentHash, seq.base.documentHash);
  // Other entities and fields read through unchanged.
  assert.equal((model.select('track:trk_2') as TrackEntity).gainMilliDb, -3000);
  assert.equal((model.select('track:trk_1') as TrackEntity).pan, 0);
});

test('(c) a held fader survives a recompile; an ended gesture stays until its entity changes', async () => {
  const model = new ReadModel();
  await model.fromSync(chunks);
  model.beginGesture('track:trk_1', 'gainMilliDb');
  model.setGesture(-9000);
  // A commit that modifies the gestured track while the fader is held: the
  // overlay stays (spec, "Gestures": a recompile never snaps a held fader back).
  const held: SessionChanged = {
    ...step(1).event,
    seq: '8',
    revision: 'r4',
    changedIds: [{ ref: 'track:trk_1', change: 'modified' }],
  };
  const renamed = { ...(seq.base.document.tracks[0] as object), name: 'Drums 2' };
  const renamedHash = await hashWith(model.getSnapshot()!, 'track:trk_1', renamed);
  await model.applyChanged({ ...held, documentHash: renamedHash }, [{ ref: 'track:trk_1', entity: renamed }]);
  assert.equal((model.select('track:trk_1') as TrackEntity).gainMilliDb, -9000);
  assert.equal((model.select('track:trk_1') as TrackEntity).name, 'Drums 2');

  assert.equal(model.endGesture(), -9000);
  assert.throws(() => model.setGesture(-1), (e: unknown) => e instanceof ReadModelError && e.code === 'no_gesture');
  // A session.changed that does not touch the track keeps the ended overlay.
  const s = step(1);
  const clipEvent: SessionChanged = { ...s.event, seq: '9', revision: 'r5' };
  const clipEntity = { ...(seq.base.document.clips[0] as object), gainMilliDb: -6000 };
  await model.applyChanged(
    { ...clipEvent, documentHash: await hashWith(model.getSnapshot()!, 'clip:clp_1', clipEntity) },
    [{ ref: 'clip:clp_1', entity: clipEntity }],
  );
  assert.equal((model.select('track:trk_1') as TrackEntity).gainMilliDb, -9000);
  // The commit of the gesture modifies the track: the overlay is dropped and
  // the committed value shows.
  const committedTrack = { ...renamed, gainMilliDb: -9000 };
  await model.applyChanged(
    {
      ...clipEvent,
      seq: '10',
      revision: 'r6',
      changedIds: [{ ref: 'track:trk_1', change: 'modified' }],
      documentHash: await hashWith(model.getSnapshot()!, 'track:trk_1', committedTrack),
    },
    [{ ref: 'track:trk_1', entity: committedTrack }],
  );
  assert.equal(model.getView().gesture, null);
  assert.equal(track(model.getSnapshot()!, 'trk_1').gainMilliDb, -9000);
});

test('(c) a session.sync drops an ended gesture; a held one stays only within the same session', async () => {
  const model = new ReadModel();
  await model.fromSync(chunks, 'ses_a');
  // An ended gesture whose commit was lost in a gap (or rejected): the sync's
  // snapshot is the engine's truth and already holds any commit, so the
  // overlay goes and the synced value shows.
  model.beginGesture('track:trk_1', 'gainMilliDb');
  model.setGesture(-9000);
  assert.equal(model.endGesture(), -9000);
  await model.fromSync(chunks, 'ses_a');
  assert.equal(model.getView().gesture, null);
  assert.equal(model.getView().overlaid, null);
  assert.equal((model.select('track:trk_1') as TrackEntity).gainMilliDb, 0);

  // A held fader survives a resync of the same session (the user still has it).
  model.beginGesture('track:trk_1', 'gainMilliDb');
  model.setGesture(-7000);
  await model.fromSync(chunks, 'ses_a');
  assert.equal((model.select('track:trk_1') as TrackEntity).gainMilliDb, -7000);
  assert.equal(model.getView().gesture?.ended, false);
  // Another session (session.opened, an engine restart): the held gesture
  // belongs to an engine that is gone, so it goes too.
  await model.fromSync(chunks, 'ses_b');
  assert.equal(model.getView().gesture, null);
  assert.equal((model.select('track:trk_1') as TrackEntity).gainMilliDb, 0);
  // A sync of an unnamed session is not known to be the same one.
  model.beginGesture('track:trk_2', 'pan');
  model.setGesture(4000);
  await model.fromSync(chunks);
  assert.equal(model.getView().gesture, null);
  assert.equal((model.select('track:trk_2') as TrackEntity).pan, 0);
});

test('(c) cancelGesture drops the overlay at once', async () => {
  const model = new ReadModel();
  await model.fromSync(chunks);
  model.beginGesture('track:trk_2', 'pan');
  model.setGesture(5000);
  assert.equal((model.select('track:trk_2') as TrackEntity).pan, 5000);
  model.cancelGesture();
  assert.equal((model.select('track:trk_2') as TrackEntity).pan, 0);
  assert.equal(model.getView().gesture, null);
});

test('(d) structural changes are never optimistic: only protocol events change entities', async () => {
  const model = new ReadModel();
  const snapshot = await model.fromSync(chunks);
  // Snapshots and their entities are frozen.
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.entities));
  assert.ok(Object.isFrozen(snapshot.tracks));
  assert.ok(Object.isFrozen(snapshot.entities['track:trk_1']));
  assert.ok(Object.isFrozen(snapshot.root!.trackOrder));
  assert.throws(() => {
    (snapshot.entities as Record<string, unknown>)['track:trk_x'] = {};
  });
  assert.throws(() => {
    (snapshot.entities['track:trk_1'] as { name: string }).name = 'x';
  });
  // Only continuous parameters take an overlay: no structural or discrete field.
  for (const field of ['mute', 'solo', 'name', 'inserts', 'trackId', 'position']) {
    assert.throws(() => model.beginGesture('track:trk_1', field as 'pan'), (e: unknown) => e instanceof ReadModelError && e.code === 'not_continuous');
  }
  assert.throws(() => model.beginGesture('track:trk_nope', 'gainMilliDb'), (e: unknown) => e instanceof ReadModelError && e.code === 'not_found');
  assert.throws(() => model.beginGesture('root:root', 'gainMilliDb'), (e: unknown) => e instanceof ReadModelError && e.code === 'not_continuous');
  // Clip gain is structural (it changes the track's flattened clip list; the
  // engine's parameter channel holds only track gain, pan and mute).
  for (const field of ['gainMilliDb', 'pan']) {
    assert.throws(() => model.beginGesture('clip:clp_1', field as 'pan'), (e: unknown) => e instanceof ReadModelError && e.code === 'not_continuous');
  }
  assert.equal(model.getView().gesture, null);
  model.beginGesture('track:trk_2', 'gainMilliDb');
  assert.throws(() => model.beginGesture('track:trk_1', 'pan'), (e: unknown) => e instanceof ReadModelError && e.code === 'gesture_open');
  assert.throws(() => model.setGesture(Number.NaN), (e: unknown) => e instanceof ReadModelError && e.code === 'invalid_value');
  model.cancelGesture();
  // The public surface: entities change only through fromSync (a session.sync)
  // and applyChanged (a session.changed with its session.fetch answer).
  const methods = Object.getOwnPropertyNames(ReadModel.prototype).filter((n) => n !== 'constructor').sort();
  assert.deepEqual(methods, [
    'applyChanged', 'beginGesture', 'cancelGesture', 'endGesture', 'fromSync', 'getSnapshot', 'getView', 'select',
    'setGesture', 'subscribe',
  ]);
  assert.equal(model.getSnapshot(), snapshot);
});

test('parseRef reads "<type>:<id>" for every entity type and rejects anything else', () => {
  assert.deepEqual(parseRef('root:root'), { type: 'root', id: 'root' });
  assert.deepEqual(parseRef('plugin_slot:slt_1'), { type: 'plugin_slot', id: 'slt_1' });
  assert.deepEqual(parseRef('clip:clp-1'), { type: 'clip', id: 'clp-1' });
  for (const bad of ['track', 'track:', ':x', 'bus:b1', 'track:a b', 'Track:t1']) assert.equal(parseRef(bad), null, bad);
});

// The document hash of a snapshot with one entity replaced, through the
// fixture-verified hash module (hash.test.ts holds it to the shared vectors).
async function hashWith(snapshot: Snapshot, ref: string, entity: unknown): Promise<string> {
  const { documentHash, entityHash } = await import('../../src/renderer/model/hash');
  const leaves = [];
  for (const [key, value] of Object.entries(snapshot.entities)) {
    const parsed = parseRef(key)!;
    leaves.push({ type: parsed.type, id: parsed.id, entityHash: await entityHash(key === ref ? entity : value) });
  }
  return documentHash(leaves);
}

// m5-ui-engine-loop-click: the singleton locators entity. Before this the
// model's parseRef refused locators:locators (invalid_ref), so the shell broke
// as soon as any client set the locators.
test('(e) locators:locators parses, syncs as one object and follows session.changed', async () => {
  assert.deepEqual(parseRef('locators:locators'), { type: 'locators', id: 'locators' });

  // The base session, its steps, then set, change and remove the locators.
  const model = new ReadModel();
  await model.fromSync(chunks);
  for (let i = 0; i < seq.steps.length; i += 1) await model.applyChanged(step(i).event, step(i).fetched);
  assert.equal(model.getSnapshot()!.locators, null);
  const expected = [
    { left: '96000', right: '480000' },
    { left: '48000', right: '480000' },
    null,
  ];
  seq.locators.steps.forEach((s, i) => assert.equal(s.event.changedIds[0]!.ref, 'locators:locators', `step ${i}`));
  for (let i = 0; i < seq.locators.steps.length; i += 1) {
    const s = seq.locators.steps[i]!;
    const snapshot = await model.applyChanged(
      s.event as unknown as SessionChanged,
      s.fetch.result.entities as unknown as FetchedEntity[],
    );
    assert.equal(snapshot.documentHash, s.documentHash, `step ${i}`);
    const want = expected[i];
    if (want) {
      assert.equal(snapshot.locators?.left, want.left, `step ${i}`);
      assert.equal(snapshot.locators?.right, want.right, `step ${i}`);
      assert.equal(snapshot.entities['locators:locators'], snapshot.locators);
    } else {
      assert.equal(snapshot.locators, null, `step ${i}`);
      assert.equal(snapshot.entities['locators:locators'], undefined);
    }
  }

  // A sync that holds the locators, as the last chunk's single object.
  const synced = await new ReadModel().fromSync(seq.locators.sync as unknown as SyncChunk[]);
  assert.equal(synced.documentHash, seq.locators.steps[0]!.documentHash);
  assert.deepEqual(synced.locators, { schema: 'siann.entity.locators.v1', id: 'locators', left: '96000', right: '480000' });
  assert.ok(Object.keys(synced.entities).includes('locators:locators'));
});

// m5b-engine-project-media: the media entity's optional name. A sync of the
// documents with and without it hashes to the generator's document hashes
// (scripts/generate-model-fixtures.js), and the name reaches the snapshot.
interface ModelFixture {
  readonly document: {
    readonly root: SyncChunk['chunk']['root'];
    readonly media: readonly MediaEntity[];
    readonly tracks: SyncChunk['chunk']['tracks'];
    readonly clips: SyncChunk['chunk']['clips'];
    readonly pluginSlots: SyncChunk['chunk']['pluginSlots'];
    readonly locators: SyncChunk['chunk']['locators'];
  };
  readonly entityHashes: readonly unknown[];
  readonly documentHash: string;
}

function syncOf(fixture: ModelFixture): SyncChunk[] {
  const { document } = fixture;
  return [{
    revision: 'r9',
    seq: '9',
    documentHash: fixture.documentHash,
    entities: fixture.entityHashes.length,
    meters: null,
    chunk: {
      root: document.root,
      media: document.media,
      tracks: document.tracks,
      clips: document.clips,
      pluginSlots: document.pluginSlots,
      locators: document.locators,
    },
    next: null,
  }];
}

test('a media entity with or without a name is accepted and hashes as the fixtures say', async () => {
  const named = readFixture<ModelFixture>('model', 'session-document-v2-media-name.json');
  const plain = readFixture<ModelFixture>('model', 'session-document-v2.json');
  const withName = await new ReadModel().fromSync(syncOf(named));
  assert.equal(withName.documentHash, named.documentHash);
  assert.deepEqual(withName.media.map((m) => m.name), ['kick.wav', 'Loop 聲 44k.flac']);
  const without = await new ReadModel().fromSync(syncOf(plain));
  assert.equal(without.documentHash, plain.documentHash);
  assert.deepEqual(without.media.map((m) => m.name), [undefined, undefined]);
  assert.ok(without.media.every((m) => !Object.prototype.hasOwnProperty.call(m, 'name')));
});
