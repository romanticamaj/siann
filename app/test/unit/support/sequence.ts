// The read-model sequence fixture (fixtures/protocol/read-model-sequence.json,
// written by scripts/generate-read-model-fixtures.js with the bridge's
// src/hash, independent of the renderer).

import { readFixture } from './fixtures';

export interface SequenceStep {
  event: {
    schema: string;
    seq: string;
    sessionId: string;
    revision: string;
    type: 'session.changed';
    parents: string[];
    cause: string;
    actor: string;
    time: string;
    documentHash: string;
    changedIds: Array<{ ref: string; change: 'added' | 'removed' | 'modified' }>;
  };
  fetch: {
    params: { refs: string[]; revision: string };
    result: { revision: string; documentHash: string; entities: Array<{ ref: string; entity?: unknown; missing?: true }> };
  };
  document: {
    root: { trackOrder: string[] } & Record<string, unknown>;
    media: Array<{ id: string } & Record<string, unknown>>;
    tracks: Array<{ id: string } & Record<string, unknown>>;
    clips: Array<{ id: string } & Record<string, unknown>>;
    pluginSlots: Array<{ id: string } & Record<string, unknown>>;
  };
  documentHash: string;
}

export interface Sequence {
  sessionId: string;
  chunkEntities: number;
  base: { revision: string; seq: string; documentHash: string; document: SequenceStep['document'] };
  sync: Array<{
    revision: string;
    seq: string;
    meters: unknown;
    documentHash: string;
    entities: number;
    chunk: Record<string, unknown>;
    next: string | null;
  }>;
  steps: SequenceStep[];
  // m5-ui-engine-loop-click: deltas on locators:locators and a sync that holds it.
  locators: {
    steps: SequenceStep[];
    sync: Sequence['sync'];
  };
  // m5b-engine-master: deltas on master:master, a sync that holds it, and a
  // document holding both singletons.
  master: {
    steps: SequenceStep[];
    sync: Sequence['sync'];
    both: { document: Record<string, unknown>; documentHash: string; sync: Sequence['sync'] };
  };
  // m5b-engine-plan-metadata: plan.changed with metadata and agent.changed after
  // the base sync, which the read model does not model.
  unmodelled: {
    events: Array<{ schema: string; seq: string; sessionId: string; revision: string; type: string } & Record<string, unknown>>;
  };
  // m5b-engine-buses-sends: deltas on a bus and a send, and a sync that holds them.
  buses: {
    steps: SequenceStep[];
    sync: Sequence['sync'];
  };
  // m5b-engine-clip-fades: after the master steps, set and remove clp_1's fades.
  fades: {
    before: { revision: string; documentHash: string };
    steps: SequenceStep[];
  };
  // m5b-engine-track-notes: after the master steps, set and remove trk_1's notes.
  notes: {
    before: { revision: string; documentHash: string };
    text: string;
    steps: SequenceStep[];
  };
}

export function sequence(): Sequence {
  return readFixture<Sequence>('protocol', 'read-model-sequence.json');
}
