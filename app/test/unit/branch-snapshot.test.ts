// The branch snapshot (m5b-ui-audition; UI redesign 4.3, P2-3): what the
// window knows of an auditioned proposal's entities. It is built only from
// proposal.changed (the branch revision and the refs that revision changed)
// and session.fetch {refs, revision} at that revision, never from
// session.inspect (which names no branch head); a second proposal.changed (a
// gesture committed onto the branch) refetches every ref the branch has
// changed at the new revision; a late answer of an older request is dropped.
// It is dropped on proposal.closed of its branch, on any status but
// connected, and on every syncCount change (a reconnect, a reload, a resync),
// and is held again only from the next proposal.changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BranchSnapshotStore } from '../../src/renderer/model/branch-snapshot';
import { settle, until } from './support/fakes';
import { FakeAttachClient } from './support/plan-client';

const trackKeys = (gainMilliDb: number) => ({ schema: 'siann.entity.track.v1', id: 'trk_keys', name: 'Keys', kind: 'audio', channels: 2, gainMilliDb, pan: 0, mute: false, solo: false });
const trackPad = { schema: 'siann.entity.track.v1', id: 'trk_pad', name: 'Pad', kind: 'audio', channels: 2, gainMilliDb: 0, pan: 0, mute: false, solo: false };

function fetched(params: Record<string, unknown>, keysGain = -3000) {
  const refs = params.refs as string[];
  return {
    revision: params.revision,
    documentHash: 'sha256:x',
    entities: refs.map((ref) =>
      ref === 'track:trk_keys' ? { ref, entity: trackKeys(keysGain) } : ref === 'track:trk_pad' ? { ref, entity: trackPad } : { ref, missing: true },
    ),
  };
}

async function connectedStore() {
  const client = new FakeAttachClient();
  const store = new BranchSnapshotStore();
  store.attach(client);
  client.setState({ status: 'connected', sessionId: 'ses_1', syncCount: 1 });
  await settle();
  return { client, store };
}

const changed = (revision: string, changedIds: Array<{ ref: string; change: string }>, branch = 'p1') => ({ type: 'proposal.changed', branch, revision, changedIds });

test('proposal.changed fetches the refs it names at the branch revision, once, and holds the answer', async () => {
  const { client, store } = await connectedStore();
  client.answers.set('session.fetch', (params) => fetched(params));
  assert.equal(store.get('p1'), null, 'nothing before an event');
  client.emit(changed('r7', [{ ref: 'track:trk_keys', change: 'modified' }, { ref: 'track:trk_pad', change: 'added' }]));
  await until(() => store.get('p1') !== null, 'the snapshot');
  assert.deepEqual(client.sent('session.fetch'), [{ refs: ['track:trk_keys', 'track:trk_pad'], revision: 'r7' }]);
  const held = store.get('p1')!;
  assert.equal(held.branch, 'p1');
  assert.equal(held.revision, 'r7');
  assert.equal((held.entities.get('track:trk_keys') as { gainMilliDb: number }).gainMilliDb, -3000);
  assert.ok(held.entities.has('track:trk_pad'));
  assert.equal(store.get('p2'), null, 'another branch holds nothing');
});

test('a second proposal.changed (a gesture onto the branch) refetches the union at the new revision', async () => {
  const { client, store } = await connectedStore();
  client.answers.set('session.fetch', (params) => fetched(params, params.revision === 'r8' ? -1500 : -3000));
  client.emit(changed('r7', [{ ref: 'track:trk_pad', change: 'added' }]));
  await until(() => store.get('p1') !== null, 'the first snapshot');
  client.emit(changed('r8', [{ ref: 'track:trk_keys', change: 'modified' }]));
  await until(() => store.get('p1')?.revision === 'r8', 'the second snapshot');
  assert.deepEqual(client.sent('session.fetch').at(-1), { refs: ['track:trk_pad', 'track:trk_keys'], revision: 'r8' });
  assert.equal((store.get('p1')!.entities.get('track:trk_keys') as { gainMilliDb: number }).gainMilliDb, -1500);
  assert.ok(store.get('p1')!.entities.has('track:trk_pad'), 'the earlier ref is still held');
});

test('a late answer of an older request is dropped', async () => {
  const { client, store } = await connectedStore();
  client.hold.add('session.fetch');
  client.emit(changed('r7', [{ ref: 'track:trk_keys', change: 'modified' }]));
  client.emit(changed('r8', [{ ref: 'track:trk_keys', change: 'modified' }]));
  assert.equal(client.held.length, 2);
  const [older, newer] = client.held;
  newer!.resolve(fetched(newer!.params, -1500));
  await until(() => store.get('p1')?.revision === 'r8', 'the newer answer');
  older!.resolve(fetched(older!.params, -3000));
  await settle();
  assert.equal(store.get('p1')!.revision, 'r8', 'the older answer did not replace it');
  assert.equal((store.get('p1')!.entities.get('track:trk_keys') as { gainMilliDb: number }).gainMilliDb, -1500);
});

test('proposal.closed of the branch drops it; another branch\'s close does not', async () => {
  const { client, store } = await connectedStore();
  client.answers.set('session.fetch', (params) => fetched(params));
  client.emit(changed('r7', [{ ref: 'track:trk_keys', change: 'modified' }]));
  await until(() => store.get('p1') !== null, 'the snapshot');
  client.emit({ type: 'proposal.closed', branch: 'p9', merged: false });
  assert.ok(store.get('p1'), 'kept');
  client.emit({ type: 'proposal.closed', branch: 'p1', merged: true, revision: 'r9' });
  assert.equal(store.get('p1'), null);
  // An answer still on its way after the close is dropped too.
  client.hold.add('session.fetch');
  client.emit(changed('r10', [{ ref: 'track:trk_keys', change: 'modified' }], 'p2'));
  client.emit({ type: 'proposal.closed', branch: 'p2', merged: false });
  client.held[0]!.resolve(fetched(client.held[0]!.params));
  await settle();
  assert.equal(store.get('p2'), null);
});

test('a status other than connected and every syncCount change drop every snapshot; the next proposal.changed holds one again', async () => {
  const { client, store } = await connectedStore();
  client.answers.set('session.fetch', (params) => fetched(params));
  client.emit(changed('r7', [{ ref: 'track:trk_keys', change: 'modified' }]));
  await until(() => store.get('p1') !== null, 'the snapshot');

  client.setState({ status: 'disconnected' });
  assert.equal(store.get('p1'), null, 'dropped on disconnect');
  client.setState({ status: 'connected', syncCount: 2 });
  await settle();
  assert.equal(store.get('p1'), null, 'not back by itself after the reconnect');

  client.emit(changed('r8', [{ ref: 'track:trk_pad', change: 'added' }]));
  await until(() => store.get('p1') !== null, 'held again');
  assert.deepEqual(client.sent('session.fetch').at(-1), { refs: ['track:trk_pad'], revision: 'r8' }, 'only the refs since the drop');

  client.setState({ syncCount: 3 });
  assert.equal(store.get('p1'), null, 'dropped on a resync');
});

test('session.inspect alone never creates a snapshot', async () => {
  const { client, store } = await connectedStore();
  client.answers.set('session.inspect', () => ({ revision: 'r3', heard: 'p1' }));
  client.emit({ type: 'audition.changed', heard: 'p1' });
  client.setState({ syncCount: 2 });
  await settle();
  assert.equal(store.get('p1'), null);
  assert.equal(client.count('session.fetch'), 0);
});

test('a refused fetch holds nothing and the next proposal.changed tries again', async () => {
  const { client, store } = await connectedStore();
  client.emit(changed('r7', [{ ref: 'track:trk_keys', change: 'modified' }]));
  await settle();
  assert.equal(store.get('p1'), null);
  client.answers.set('session.fetch', (params) => fetched(params));
  client.emit(changed('r8', [{ ref: 'track:trk_keys', change: 'modified' }]));
  await until(() => store.get('p1')?.revision === 'r8', 'the retry');
});
