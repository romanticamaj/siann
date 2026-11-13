// Fixtures for the Plans tab's component tests (m5-ui-plan-panel): a session
// with named tracks and a clip, plan objects as plan.list answers them, and a
// session client stand-in whose read model holds that session. Entity ids and
// branch ids are distinctive so a test can assert none of them is shown.

import type { SessionClient } from '../../../src/renderer/model/session-client';
import type { Snapshot } from '../../../src/renderer/model/read-model';
import { planEntry, type PlanEntry } from '../../../src/renderer/model/plan-store';
import { clip, media, snapshotOf, track } from './timeline';

export const KEYS = 'trk_keys';
export const VOX = 'trk_vox';
export const PAD = 'trk_pad';
export const CLIP = 'clp_keys1';
export const BRANCH = 'p7';
export const ENTITY_IDS = [KEYS, VOX, PAD, CLIP, 'med_keys'] as const;

export const hashOf = (digit: string) => 'sha256:' + digit.repeat(64);

export function planSnapshot(): Snapshot {
  return snapshotOf(
    [KEYS, VOX],
    [
      { ...track(KEYS), name: 'Keys' },
      { ...track(VOX), name: 'Vox Lead', gainMilliDb: 500 },
    ],
    [media('med_keys', '480000')],
    [clip(CLIP, KEYS, 'med_keys', '72000', '0', '96000')],
  );
}

export function planObject(hash: string, state: string, steps: ReadonlyArray<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { schema: 'siann.plan.v1', hash, state, baseRevision: 'r3', steps, readSet: [], writeSet: [], stale: [], ...extra };
}

export const MIX_STEPS: ReadonlyArray<Record<string, unknown>> = [
  { op: 'track.set_gain', trackId: KEYS, gainMilliDb: -3000 },
  { op: 'track.set_pan', trackId: KEYS, pan: -2000 },
  { op: 'track.add', trackId: PAD, name: 'Pad', channels: 2 },
];

export function entry(hash: string, state: string, steps = MIX_STEPS, extra: Record<string, unknown> = {}): PlanEntry {
  return planEntry(planObject(hash, state, steps, extra))!;
}

// What App passes as the session client: the read model's snapshot and a
// request() that records and answers nothing.
export function fakePlanClient(snapshot: Snapshot = planSnapshot()) {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const model = {
    getSnapshot: () => snapshot,
    select: (ref: string) => snapshot.entities[ref],
    subscribe: () => () => undefined,
  };
  const client = {
    model,
    request: (method: string, params: Record<string, unknown>) => {
      sent.push({ method, params });
      return new Promise<unknown>(() => undefined);
    },
  } as unknown as SessionClient;
  return { client, sent };
}
