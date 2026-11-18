// The preload bridge (contextIsolation on, sandboxed): the renderer gets the
// engine's {port, token} and change notifications, the shell's project
// record and folder dialogs, and the application menu's two directions
// (m5b-ui-project), nothing else. The MCP token never leaves the main
// process.

import { contextBridge, ipcRenderer } from 'electron';

// The renderer arguments main.ts adds under SIANN_SHELL_TEST=1.
const TEST_HOOKS_ARG = '--siann-test-hooks';
const TEST_LANGS_ARG = '--siann-test-langs=';
const TEST_CAPABILITIES_ARG = '--siann-test-capabilities=';
const TEST_ENVIRONMENT_ARG = '--siann-test-environment=';

interface EngineEndpoint {
  port: number;
  token: string;
}

function endpoint(value: unknown): EngineEndpoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const { port, token } = value as Record<string, unknown>;
  return typeof port === 'number' && typeof token === 'string' ? { port, token } : null;
}

// Under SIANN_SHELL_TEST=1 the main process adds the argument, and the renderer
// exposes its test hooks (window.__siannTimeline, window.__siannLocale);
// window.siann stays as it is. SIANN_TEST_LANGS, when set, is the system
// language list the test pins (the renderer's locale detection reads it first);
// SIANN_TEST_CAPABILITIES, when set, is the engine.capabilities answer the
// session client uses instead of the engine's.
if (process.argv.includes(TEST_HOOKS_ARG)) {
  const langs = process.argv.find((arg) => arg.startsWith(TEST_LANGS_ARG));
  const languages = langs ? langs.slice(TEST_LANGS_ARG.length).split(',').filter(Boolean) : undefined;
  const caps = process.argv.find((arg) => arg.startsWith(TEST_CAPABILITIES_ARG));
  const capabilities: unknown = caps ? JSON.parse(decodeURIComponent(caps.slice(TEST_CAPABILITIES_ARG.length))) : undefined;
  // SIANN_FIDELITY_ENVIRONMENT, when set: the device and build the fidelity run shows.
  const env = process.argv.find((arg) => arg.startsWith(TEST_ENVIRONMENT_ARG));
  const environment: unknown = env ? JSON.parse(decodeURIComponent(env.slice(TEST_ENVIRONMENT_ARG.length))) : undefined;
  contextBridge.exposeInMainWorld('siannTest', {
    timelineHooks: true,
    ...(languages ? { languages } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(environment !== undefined ? { environment } : {}),
  });
}

// The shell's record of bundles (m5b-ui-project): {current, startView,
// recent: [{path, name}]}, checked field by field.
interface ProjectState {
  current: string | null;
  startView: boolean;
  recent: Array<{ path: string; name: string }>;
}

function projectState(value: unknown): ProjectState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { current, startView, recent } = value as Record<string, unknown>;
  if ((current !== null && typeof current !== 'string') || typeof startView !== 'boolean' || !Array.isArray(recent)) return null;
  const entries = recent.filter(
    (entry): entry is { path: string; name: string } =>
      typeof entry === 'object' && entry !== null && typeof (entry as { path?: unknown }).path === 'string' && typeof (entry as { name?: unknown }).name === 'string',
  );
  return { current, startView, recent: entries.map(({ path, name }) => ({ path, name })) };
}

const pathOrNull = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

contextBridge.exposeInMainWorld('siann', {
  engine: {
    current: async (): Promise<EngineEndpoint | null> => endpoint(await ipcRenderer.invoke('siann:engine:current')),
    onChange: (callback: (next: EngineEndpoint | null) => void): void => {
      ipcRenderer.on('siann:engine:changed', (_event, value: unknown) => callback(endpoint(value)));
    },
  },
  // Projects (m5b-ui-project): the record, the shell's folder dialogs, and
  // the report of a bundle the engine created or opened.
  project: {
    state: async (): Promise<ProjectState | null> => projectState(await ipcRenderer.invoke('siann:project:state')),
    chooseNew: async (): Promise<string | null> => pathOrNull(await ipcRenderer.invoke('siann:project:choose-new')),
    chooseOpen: async (): Promise<string | null> => pathOrNull(await ipcRenderer.invoke('siann:project:choose-open')),
    opened: (path: string): void => {
      if (typeof path === 'string') ipcRenderer.send('siann:project:opened', path);
    },
    onChange: (callback: (state: ProjectState) => void): void => {
      ipcRenderer.on('siann:project:changed', (_event, value: unknown) => {
        const state = projectState(value);
        if (state) callback(state);
      });
    },
  },
  // The application menu (m5b-ui-project): the renderer's model out, the
  // command id of a click in.
  menu: {
    set: (model: unknown): void => ipcRenderer.send('siann:menu:set', model),
    onCommand: (callback: (command: string) => void): void => {
      ipcRenderer.on('siann:menu:command', (_event, value: unknown) => {
        if (typeof value === 'string') callback(value);
      });
    },
  },
});
