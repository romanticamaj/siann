// A record host for the port tests (m5b-ui-recording): the real
// RecordController and RecordStore over a client that answers nothing, on a
// snapshot, the capabilities given and the fake device's input (two
// channels), with the record state given (nothing armed when absent).

import { capabilitySelector, type Capabilities } from '../../../src/renderer/model/capabilities';
import { parseEngineStatus, type EngineStatus } from '../../../src/renderer/model/engine-status';
import type { Snapshot } from '../../../src/renderer/model/read-model';
import { RecordController, RecordStore, type RecordState } from '../../../src/renderer/model/record';
import type { ClientState, EventMessage } from '../../../src/renderer/model/session-client';
import type { RecordHost } from '../../../src/renderer/shell/record-context';

export const DEVICE_WITH_INPUT = { id: 'fake', sampleRate: 48000, bufferFrames: 256, inputLatencyFrames: 256, outputLatencyFrames: 256, input: { id: 'fake', channels: 2, latencyFrames: 256 } };

export function recordHost(snapshot: Snapshot | null, caps: Capabilities | null, state: RecordState | null = { recording: false, armed: [], takes: [] }, status: EngineStatus | null = parseEngineStatus({ device: DEVICE_WITH_INPUT, xruns: '0' })): RecordHost {
  const clientState = { status: 'connected', capabilities: caps, connections: 1, syncCount: 1, pendingTakes: [] } as unknown as ClientState;
  const client = {
    request: async () => ({}),
    execute: async () => ({}),
    getState: () => clientState,
    subscribe: () => () => undefined,
    onEvent: (_type: string, _fn: (event: EventMessage) => void) => () => undefined,
  };
  const store = new RecordStore(client);
  if (state) store.apply(state);
  const source = { getSnapshot: () => status, subscribe: () => () => undefined };
  const controller = new RecordController({
    client,
    model: { getSnapshot: () => snapshot },
    store,
    status: source,
    capabilities: () => capabilitySelector(caps),
    toasts: { push: () => 0 },
    locale: () => 'en',
  });
  return { controller, status: source };
}
