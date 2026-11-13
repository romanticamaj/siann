// The preload bridge (contextIsolation on, sandboxed): the renderer gets the
// engine's {port, token} and change notifications, nothing else. The MCP
// token never leaves the main process.

import { contextBridge, ipcRenderer } from 'electron';

// The renderer arguments main.ts adds under SIANN_SHELL_TEST=1.
const TEST_HOOKS_ARG = '--siann-test-hooks';
const TEST_LANGS_ARG = '--siann-test-langs=';

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
// language list the test pins (the renderer's locale detection reads it first).
if (process.argv.includes(TEST_HOOKS_ARG)) {
  const langs = process.argv.find((arg) => arg.startsWith(TEST_LANGS_ARG));
  const languages = langs ? langs.slice(TEST_LANGS_ARG.length).split(',').filter(Boolean) : undefined;
  contextBridge.exposeInMainWorld('siannTest', { timelineHooks: true, ...(languages ? { languages } : {}) });
}

contextBridge.exposeInMainWorld('siann', {
  engine: {
    current: async (): Promise<EngineEndpoint | null> => endpoint(await ipcRenderer.invoke('siann:engine:current')),
    onChange: (callback: (next: EngineEndpoint | null) => void): void => {
      ipcRenderer.on('siann:engine:changed', (_event, value: unknown) => callback(endpoint(value)));
    },
  },
});
