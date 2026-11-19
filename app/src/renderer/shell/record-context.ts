// The recording controller for the zones (m5b-ui-recording): the track
// headers, the strips, the Inspector and the transport read the record state
// and send through it. Null where the app has none (a test that renders a
// zone alone): no recording control is rendered then and each box stays
// empty, as on an engine without features.recording (UI redesign 3.0).

import { createContext, useContext, useSyncExternalStore } from 'react';

import type { EngineStatusSource } from '../model/engine-status';
import type { RecordController } from '../model/record';

export interface RecordHost {
  readonly controller: RecordController;
  readonly status: EngineStatusSource;
}

export const RecordContext = createContext<RecordHost | null>(null);

export function useRecordHost(): RecordHost | null {
  return useContext(RecordContext);
}

const none = () => () => undefined;

// A value of the controller, re-read whenever the record state, engine.status
// or the connection changes; a primitive, so an unchanged value commits nothing.
export function useRecordValue<T extends string | number | boolean | null>(host: RecordHost | null, read: (controller: RecordController) => T, fallback: T): T {
  return useSyncExternalStore(
    host ? (listener) => host.controller.subscribe(listener) : none,
    () => (host ? read(host.controller) : fallback),
    () => (host ? read(host.controller) : fallback),
  );
}
