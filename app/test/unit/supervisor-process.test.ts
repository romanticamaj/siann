// EngineSupervisor against real processes that ignore SIGTERM and stdin EOF,
// the way a wedged siann-engine does. The fake children in supervisor.test.ts
// pin the signals; this shows the process really ends. On Windows every kill
// is TerminateProcess, so only POSIX exercises the SIGKILL. Waits are on the
// child's own ready and exit events.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { EngineSupervisor, READY_SCHEMA, type EngineExit, type EngineReady } from '../../src/main/supervisor';

const SETUP = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
const READY = `process.stdout.write(JSON.stringify({
  schema: '${READY_SCHEMA}', port: 40000, token: 'a'.repeat(64), mcpToken: 'b'.repeat(64),
  sessionId: 'ses_0001', pid: process.pid, about: {},
}) + '\\n');`;
const MALFORMED = "process.stdout.write('not json\\n');";

function wedged(script: string) {
  const pids: number[] = [];
  const supervisor = new EngineSupervisor({
    exe: process.execPath,
    args: ['-e', `${SETUP}${script}`],
    stopGraceMs: 20,
    killGraceMs: 1_000,
    backoff: { maxRestarts: 0 },
    spawn: (exe, args) => {
      const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      if (child.pid !== undefined) pids.push(child.pid);
      return child;
    },
    schedule: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  });
  return { supervisor, pids };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reap(pids: number[]): void {
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
}

test('stop() ends a process that ignores stdin EOF and SIGTERM', { timeout: 30_000 }, async () => {
  const { supervisor, pids } = wedged(READY);
  try {
    const ready = once(supervisor, 'ready');
    supervisor.start();
    const [line] = (await ready) as [EngineReady];
    await supervisor.stop();
    assert.equal(isAlive(line.pid), false);
  } finally {
    reap(pids);
  }
});

test('a failed launch that ignores SIGTERM is ended', { timeout: 30_000 }, async () => {
  const { supervisor, pids } = wedged(MALFORMED);
  try {
    const exited = once(supervisor, 'exit');
    supervisor.start();
    const [exit] = (await exited) as [EngineExit];
    assert.equal(exit.restartInMs, null);
    assert.equal(pids.length, 1);
    assert.equal(isAlive(pids[0]!), false);
  } finally {
    reap(pids);
  }
});
