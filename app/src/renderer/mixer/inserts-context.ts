// What the insert racks of the strips and the Inspector share
// (m5b-ui-inserts-master): the plugin actions (bypass, Remove, the editor),
// the picker an empty slot opens, and engine.status for each slot's state.
// index.tsx makes one of each and App provides them; without a provider (the
// unit tests' renders) the racks draw from the read model and their buttons
// do nothing.

import { createContext, useContext, useSyncExternalStore } from 'react';

import type { EngineStatus, EngineStatusSource } from '../model/engine-status';
import type { PluginActions } from '../model/plugin-actions';
import type { PickerController } from './picker';

export interface InsertsHost {
  readonly actions: PluginActions;
  readonly picker: PickerController;
  readonly status: EngineStatusSource;
}

export const InsertsContext = createContext<InsertsHost | null>(null);

export function useInsertsHost(): InsertsHost | null {
  return useContext(InsertsContext);
}

const NO_STATUS = { subscribe: () => () => undefined, getSnapshot: () => null };
const NO_EDITORS = { subscribe: () => () => undefined, getVersion: () => 0 };

// engine.status as the slots read it (null without a host).
export function useEngineStatus(host: InsertsHost | null): EngineStatus | null {
  const source = host?.status ?? NO_STATUS;
  return useSyncExternalStore(
    (l) => source.subscribe(l),
    () => source.getSnapshot(),
    () => source.getSnapshot(),
  );
}

// Re-renders when an editor opens or closes.
export function useEditorVersion(host: InsertsHost | null): number {
  const actions = host?.actions ?? NO_EDITORS;
  return useSyncExternalStore(actions.subscribe, actions.getVersion, actions.getVersion);
}
