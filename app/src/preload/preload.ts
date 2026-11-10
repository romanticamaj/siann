// The preload bridge (contextIsolation on, sandboxed): the renderer gets the
// engine's {port, token} and change notifications, nothing else. The MCP
// token never leaves the main process.

import { contextBridge, ipcRenderer } from 'electron';

// The renderer argument main.ts adds under SIANN_SHELL_TEST=1.
const TEST_HOOKS_ARG = '--siann-test-hooks';

interface EngineEndpoint {
  port: number;
  token: string;
}

function endpoint(value: unknown): EngineEndpoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const { port, token } = value as Record<string, unknown>;
  return typeof port === 'number' && typeof token === 'string' ? { port, token } : null;
}

contextBridge.exposeInMainWorld('siann', {
  // Under SIANN_SHELL_TEST=1 the main process adds this argument, and the
  // renderer exposes its test hooks (window.__siannTimeline).
  testHooks: process.argv.includes(TEST_HOOKS_ARG),
  engine: {
    current: async (): Promise<EngineEndpoint | null> => endpoint(await ipcRenderer.invoke('siann:engine:current')),
    onChange: (callback: (next: EngineEndpoint | null) => void): void => {
      ipcRenderer.on('siann:engine:changed', (_event, value: unknown) => callback(endpoint(value)));
    },
  },
});
