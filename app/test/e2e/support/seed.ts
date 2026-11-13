// Shared set-up of the i18n specs: a bundle prepared with siann-cli
// (SIANN_CLI_EXE), the app on the real siann-engine (SIANN_ENGINE_EXE) and the
// fake device, and an MCP agent that submits plans (the client of
// plan-review.spec.ts: JSON-RPC over POST /v0/mcp with the MCP token).

import { expect, type ElectronApplication } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { launchElectron } from './launch';

export const APP_DIR = path.resolve(__dirname, '..', '..', '..');
export const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');

export function exeFromEnv(name: string): string {
  const exe = process.env[name];
  if (!exe) throw new Error(`set ${name} to the built executable`);
  if (!fs.existsSync(exe)) throw new Error(`${name} points at a missing file: ${exe}`);
  return exe;
}

function cli(...args: string[]): void {
  const result = spawnSync(exeFromEnv('SIANN_CLI_EXE'), args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`siann-cli ${args.join(' ')}: ${result.stdout} ${result.stderr}`);
}

export interface SeedTrack {
  readonly id: string;
  readonly name: string;
  readonly gain?: number;
  readonly pan?: number;
  readonly mute?: boolean;
  readonly solo?: boolean;
}

// A bundle with tracks at <scratch>/sessions/Untitled.siann; returns its directory.
export function seedBundle(scratch: string, tracks: readonly SeedTrack[]): string {
  const bundle = path.join(scratch, 'sessions', 'Untitled.siann');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  cli('create', bundle, '--name', 'I18n', '--rate', '48000');
  const exec = (command: Record<string, unknown>) => cli('exec', bundle, JSON.stringify(command));
  for (const track of tracks) {
    exec({ op: 'track.add', trackId: track.id, name: track.name, channels: 2 });
    if (track.gain) exec({ op: 'track.set_gain', trackId: track.id, gainMilliDb: track.gain });
    if (track.pan) exec({ op: 'track.set_pan', trackId: track.id, pan: track.pan });
    if (track.mute) exec({ op: 'track.set_mute', trackId: track.id, mute: true });
    if (track.solo) exec({ op: 'track.set_solo', trackId: track.id, solo: true });
  }
  return path.dirname(bundle);
}

export function launchApp(options: { sessionDir: string; userData: string; languages: readonly string[] }): Promise<ElectronApplication> {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  return launchElectron({
    args: [MAIN],
    cwd: APP_DIR,
    languages: options.languages,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: exeFromEnv('SIANN_ENGINE_EXE'),
      SIANN_SESSION_DIR: options.sessionDir,
      SIANN_USER_DATA: options.userData,
      SIANN_SHELL_BACKOFF_MS: '50',
      SIANN_SHELL_TEST: '1',
      SIANN_ENGINE_TEST_ARGS: '--device fake',
    },
  });
}

export class Agent {
  #session = '';
  #id = 0;
  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {}

  async rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${this.token}` };
    if (this.#session) headers['mcp-session-id'] = this.#session;
    const response = await fetch(`http://127.0.0.1:${this.port}/v0/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.#id, method, params }),
    });
    expect(response.status).toBe(200);
    const session = response.headers.get('mcp-session-id');
    if (session) this.#session = session;
    return (await response.json()) as Record<string, unknown>;
  }

  async tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await this.rpc('tools/call', { name, arguments: args });
    const result = reply.result as { isError: boolean; structuredContent: Record<string, unknown> };
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result)}`);
    return result.structuredContent;
  }
}

export async function agentFor(app: ElectronApplication): Promise<Agent> {
  const ready = await app.evaluate(() => {
    const shell = (globalThis as unknown as { __siannShell: { current(): { port: number; mcpToken: string } | null } }).__siannShell;
    return shell.current();
  });
  if (!ready) throw new Error('the shell has no engine');
  const client = new Agent(ready.port, ready.mcpToken);
  await client.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'i18n-e2e', version: '1' } });
  return client;
}

export function hash8(hash: string): string {
  return hash.slice('sha256:'.length, 'sha256:'.length + 8);
}
