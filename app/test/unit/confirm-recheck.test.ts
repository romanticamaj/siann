// A confirmation acts on what it showed (security review: bus.remove's
// confirmation). Confirm rechecks before it sends: the capability and the edit
// guard (a proposal heard holds structural edits), then the summary rebuilt
// from the snapshot of now against the one shown. A changed summary is asked
// again with the new one and sends nothing; an unchanged one sends the
// command built from the snapshot it was rebuilt from, so its revision is
// expectedRevision; no snapshot, a refusal or nothing left to remove closes
// the dialog. Bus removal (mixer.bus.remove) and track removal (Shift+Delete).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { busRemoval, recheckBusRemoval } from '../../src/renderer/mixer/bus-commands';
import { recheckTrackRemoval, trackRemoval } from '../../src/renderer/timeline/edit-commands';
import type { TrackEntity } from '../../src/renderer/model/document';
import { busSnapshot, bus, send } from './support/buses';
import { track } from './support/timeline';

const keys: TrackEntity = { ...track('trk_keys'), name: 'Keys' };
const pad: TrackEntity = { ...track('trk_pad'), name: 'Pad' };

test('a bus removal shows the bus name, the summary and the revision it was built from', () => {
  const snapshot = busSnapshot([bus('bus_a', 'Bus 1')], [send('snd_1', 'trk_keys', 'bus_a')], [keys, pad], 'r7');
  assert.deepEqual(busRemoval(snapshot, 'bus_a'), {
    busId: 'bus_a',
    name: 'Bus 1',
    summary: { sends: ['Keys'], tracks: [], buses: [] },
    revision: 'r7',
  });
  assert.equal(busRemoval(snapshot, 'bus_gone'), null);
});

test('confirm with the summary unchanged sends one bus.remove at the revision of the snapshot it was rebuilt from', () => {
  const opened = busSnapshot([bus('bus_a', 'Bus 1')], [send('snd_1', 'trk_keys', 'bus_a')], [keys, pad], 'r7');
  const shown = busRemoval(opened, 'bus_a')!;
  assert.deepEqual(recheckBusRemoval(shown, opened, true), {
    kind: 'send',
    command: { expectedRevision: 'r7', commands: [{ op: 'bus.remove', busId: 'bus_a' }] },
  });
  // An unrelated edit moved the revision; what the removal takes is the same.
  const later = busSnapshot([bus('bus_a', 'Bus 1'), bus('bus_b', 'Bus 2')], [send('snd_1', 'trk_keys', 'bus_a')], [keys, pad], 'r9');
  assert.deepEqual(recheckBusRemoval(shown, later, true), {
    kind: 'send',
    command: { expectedRevision: 'r9', commands: [{ op: 'bus.remove', busId: 'bus_a' }] },
  });
});

test('a track routed to the bus after the dialog opened: asked again with the new summary, nothing sent', () => {
  const opened = busSnapshot([bus('bus_a', 'Bus 1')], [send('snd_1', 'trk_keys', 'bus_a')], [keys, pad], 'r7');
  const shown = busRemoval(opened, 'bus_a')!;
  const routed = busSnapshot([bus('bus_a', 'Bus 1')], [send('snd_1', 'trk_keys', 'bus_a')], [keys, { ...pad, output: { busId: 'bus_a' } }], 'r8');
  assert.deepEqual(recheckBusRemoval(shown, routed, true), {
    kind: 'ask',
    pending: { busId: 'bus_a', name: 'Bus 1', summary: { sends: ['Keys'], tracks: ['Pad'], buses: [] }, revision: 'r8' },
  });
  // The send removed meanwhile, or the bus renamed: asked again too.
  const unsent = busSnapshot([bus('bus_a', 'Bus 1')], [], [keys, pad], 'r8');
  assert.equal(recheckBusRemoval(shown, unsent, true).kind, 'ask');
  const renamed = busSnapshot([bus('bus_a', 'Drums')], [send('snd_1', 'trk_keys', 'bus_a')], [keys, pad], 'r8');
  assert.equal(recheckBusRemoval(shown, renamed, true).kind, 'ask');
});

test('a bus removal not allowed any more (guard, capability), without a snapshot or with the bus gone closes the dialog', () => {
  const opened = busSnapshot([bus('bus_a', 'Bus 1')], [send('snd_1', 'trk_keys', 'bus_a')], [keys, pad], 'r7');
  const shown = busRemoval(opened, 'bus_a')!;
  assert.deepEqual(recheckBusRemoval(shown, opened, false), { kind: 'close' });
  assert.deepEqual(recheckBusRemoval(shown, null, true), { kind: 'close' });
  assert.deepEqual(recheckBusRemoval(shown, busSnapshot([], [], [keys, pad], 'r8'), true), { kind: 'close' });
});

test('a track removal keeps the tracks that exist, in order, with the revision; none is null', () => {
  const snapshot = busSnapshot([], [], [keys, pad], 'r7');
  assert.deepEqual(trackRemoval(snapshot, ['trk_pad', 'trk_gone', 'trk_keys']), { trackIds: ['trk_pad', 'trk_keys'], revision: 'r7' });
  assert.equal(trackRemoval(snapshot, ['trk_gone']), null);
});

test('confirming a track removal: unchanged sends at the current revision; a track gone asks again; refused or empty closes', () => {
  const opened = busSnapshot([], [], [keys, pad], 'r7');
  const shown = trackRemoval(opened, ['trk_keys', 'trk_pad'])!;
  assert.deepEqual(recheckTrackRemoval(shown, busSnapshot([], [], [keys, pad], 'r8'), true), {
    kind: 'send',
    command: { expectedRevision: 'r8', commands: [{ op: 'track.remove', trackId: 'trk_keys' }, { op: 'track.remove', trackId: 'trk_pad' }] },
  });
  assert.deepEqual(recheckTrackRemoval(shown, busSnapshot([], [], [pad], 'r8'), true), {
    kind: 'ask',
    pending: { trackIds: ['trk_pad'], revision: 'r8' },
  });
  assert.deepEqual(recheckTrackRemoval(shown, opened, false), { kind: 'close' });
  assert.deepEqual(recheckTrackRemoval(shown, null, true), { kind: 'close' });
  assert.deepEqual(recheckTrackRemoval(shown, busSnapshot([], [], [], 'r8'), true), { kind: 'close' });
});
