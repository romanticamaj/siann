// The preload bridge (contextIsolation on, sandboxed): the renderer gets the
// engine's {port, token} and change notifications, nothing else. The MCP
// token never leaves the main process.

import { contextBridge, ipcRenderer } from 'electron';

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
  engine: {
    current: async (): Promise<EngineEndpoint | null> => endpoint(await ipcRenderer.invoke('siann:engine:current')),
    onChange: (callback: (next: EngineEndpoint | null) => void): void => {
      ipcRenderer.on('siann:engine:changed', (_event, value: unknown) => callback(endpoint(value)));
    },
  },
});
