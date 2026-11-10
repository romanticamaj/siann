// EngineSupervisor (spec, "Process model": crash-loop backoff; Protocol v0
// item 17). Fake children and a fake scheduler: no processes, no timers, no
// wall clock. Each scheduled callback runs only when a test fires it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  DEFAULT_BACKOFF,
  EngineSupervisor,
  type Backoff,
  type EngineExit,
  type EngineGaveUp,
  type EngineReady,
  type SupervisorOptions,
} from '../../src/main/supervisor';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  stdinEnded = 0;
  // A kill that fails, per signal (a bare kill() is SIGTERM): 'false' as Node's
  // ChildProcess fails one, emitting 'error' inside kill() and returning false;
  // 'throw' as it rejects a signal, throwing out of kill().
  killMode: Partial<Record<'SIGTERM' | 'SIGKILL', 'false' | 'throw'>> = {};
  kills: Array<NodeJS.Signals | number | undefined> = [];
  // How many kills had been sent when stdin was first ended.
  killsBeforeStdinEnd: number | null = null;
  readonly stdin = {
    end: () => {
      this.stdinEnded += 1;
      if (this.killsBeforeStdinEnd === null) this.killsBeforeStdinEnd = this.kills.length;
    },
  };
  constructor(readonly pid: number) {
    super();
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    const mode = this.killMode[signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'];
    if (mode === 'false') {
      this.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' }));
      return false;
    }
    if (mode === 'throw') throw new Error('kill EINVAL');
    return true;
  }
  exit(code: number | null, signal: string | null = null): void {
    this.emit('exit', code, signal);
  }
}

interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

class FakeScheduler {
  readonly timers: Timer[] = [];
  readonly schedule = (fn: () => void, ms: number): (() => void) => {
    const timer: Timer = { fn, ms, cancelled: false, fired: false };
    this.timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  pending(): Timer[] {
    return this.timers.filter((t) => !t.cancelled && !t.fired);
  }
  // Fires the one pending timer with this delay.
  fire(ms: number): void {
    const matching = this.pending().filter((t) => t.ms === ms);
    assert.equal(matching.length, 1, `one pending ${ms} ms timer (pending: ${this.pending().map((t) => t.ms)})`);
    const timer = matching[0]!;
    timer.fired = true;
    timer.fn();
  }
}

const TOKEN = 'a'.repeat(64);
const MCP_TOKEN = 'b'.repeat(64);

function readyLine(pid: number, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    schema: 'siann.engine.ready.v0',
    port: 40_000 + pid,
    token: TOKEN,
    mcpToken: MCP_TOKEN,
    sessionId: `ses_${pid.toString(16).padStart(4, '0')}`,
    pid,
    about: { name: 'siann-engine', version: '0.1.0', license: 'GPL-2.0-or-later' },
    ...overrides,
  })}\n`;
}

// Lets PassThrough deliver what was written ('data' runs on a later tick).
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const BACKOFF = { initialMs: 250, maxMs: 1_000, resetAfterMs: 30_000, maxRestarts: 5 };
const GRACE = 4_321;
const KILL_GRACE = 1_234;
// Distinct from resetAfterMs, so FakeScheduler.fire names one timer.
const READY_TIMEOUT = 7_777;

function rig(backoff: Backoff = BACKOFF, overrides: Partial<SupervisorOptions> = {}) {
  const scheduler = new FakeScheduler();
  const children: FakeChild[] = [];
  const launches: Array<{ exe: string; args: readonly string[] }> = [];
  const supervisor = new EngineSupervisor({
    exe: '/path/to/siann-engine',
    args: ['--session', '/tmp/Song.siann'],
    backoff,
    stopGraceMs: GRACE,
    killGraceMs: KILL_GRACE,
    readyTimeoutMs: READY_TIMEOUT,
    schedule: scheduler.schedule,
    spawn: (exe, args) => {
      launches.push({ exe, args });
      const child = new FakeChild(1000 + children.length);
      children.push(child);
      return child;
    },
    ...overrides,
  });
  const ready: EngineReady[] = [];
  const exits: EngineExit[] = [];
  const gaveUp: EngineGaveUp[] = [];
  const protocolErrors: string[] = [];
  supervisor.on('ready', (r: EngineReady) => ready.push(r));
  supervisor.on('exit', (e: EngineExit) => exits.push(e));
  supervisor.on('gave-up', (g: EngineGaveUp) => gaveUp.push(g));
  supervisor.on('protocol-error', (reason: string) => protocolErrors.push(reason));
  return { supervisor, scheduler, children, launches, ready, exits, gaveUp, protocolErrors };
}

function last<T>(items: T[]): T {
  assert.ok(items.length > 0);
  return items[items.length - 1]!;
}

test('arguments given as a function are read again for every launch', () => {
  let window = 1;
  const r = rig(BACKOFF, { args: () => ['--owner-window', String(window)] });
  r.supervisor.start();
  window = 2;
  last(r.children).exit(1);
  r.scheduler.fire(250);
  assert.deepEqual(r.launches.map((launch) => launch.args), [['--owner-window', '1'], ['--owner-window', '2']]);
});

test('the ready line is parsed and emitted with port, token, mcpToken, sessionId and pid', async () => {
  const r = rig();
  r.supervisor.start();
  assert.equal(r.launches.length, 1);
  assert.deepEqual(r.launches[0], { exe: '/path/to/siann-engine', args: ['--session', '/tmp/Song.siann'] });
  assert.equal(r.supervisor.current(), null);
  // Split across chunks, as a pipe may deliver it.
  const line = readyLine(1000);
  r.children[0]!.stdout.write(line.slice(0, 20));
  await flush();
  assert.equal(r.ready.length, 0);
  r.children[0]!.stdout.write(line.slice(20));
  await flush();
  assert.equal(r.ready.length, 1);
  const ready = r.ready[0]!;
  assert.equal(ready.port, 41_000);
  assert.equal(ready.token, TOKEN);
  assert.equal(ready.mcpToken, MCP_TOKEN);
  assert.equal(ready.sessionId, 'ses_03e8');
  assert.equal(ready.pid, 1000);
  assert.deepEqual(r.supervisor.current(), ready);
  assert.equal(r.supervisor.pid(), 1000);
  assert.equal(r.children[0]!.kills.length, 0);
});

test('a child that exits before ready is restarted after initialMs', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.exit(1);
  assert.deepEqual(last(r.exits), { code: 1, signal: null, restartInMs: 250 });
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [250]);
  assert.equal(r.launches.length, 1, 'nothing is spawned before the delay');
  r.scheduler.fire(250);
  assert.equal(r.launches.length, 2);
});

test('consecutive exits double the delay up to maxMs', async () => {
  const r = rig();
  r.supervisor.start();
  const delays: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    last(r.children).exit(1);
    const delay = last(r.exits).restartInMs;
    assert.ok(delay !== null);
    delays.push(delay);
    r.scheduler.fire(delay);
  }
  assert.deepEqual(delays, [250, 500, 1_000, 1_000, 1_000]);
});

test('an engine that stays up resetAfterMs after ready resets the delay to initialMs', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.exit(1);
  r.scheduler.fire(250);
  r.children[1]!.exit(1);
  r.scheduler.fire(500);
  // The third launch comes up, but goes down before resetAfterMs: no reset.
  r.children[2]!.stdout.write(readyLine(1002));
  await flush();
  r.children[2]!.exit(1);
  assert.equal(last(r.exits).restartInMs, 1_000);
  r.scheduler.fire(1_000);
  // The fourth stays up resetAfterMs.
  r.children[3]!.stdout.write(readyLine(1003));
  await flush();
  r.scheduler.fire(30_000);
  r.children[3]!.exit(null, 'SIGKILL');
  assert.deepEqual(last(r.exits), { code: null, signal: 'SIGKILL', restartInMs: 250 });
});

test('the shell constants allow 5 restarts: the sixth consecutive exit gives up', async () => {
  const r = rig(DEFAULT_BACKOFF);
  r.supervisor.start();
  const delays: Array<number | null> = [];
  for (let i = 0; i < 6; i += 1) {
    assert.equal(r.gaveUp.length, 0);
    last(r.children).exit(1);
    const delay = last(r.exits).restartInMs;
    delays.push(delay);
    if (delay !== null) r.scheduler.fire(delay);
  }
  assert.deepEqual(delays, [250, 500, 1_000, 2_000, 4_000, null]);
  assert.equal(r.gaveUp.length, 1);
  assert.equal(r.launches.length, 6);
});

test('maxRestarts 0 never restarts', async () => {
  const r = rig({ ...BACKOFF, maxRestarts: 0 });
  r.supervisor.start();
  r.children[0]!.exit(1);
  assert.equal(r.gaveUp.length, 1);
  assert.deepEqual(r.scheduler.pending(), []);
});

test('the failure after maxRestarts restarts emits gave-up with the exit code and the last stderr lines', async () => {
  const r = rig({ ...BACKOFF, maxRestarts: 2 });
  r.supervisor.start();
  r.children[0]!.exit(1);
  r.scheduler.fire(250);
  r.children[1]!.exit(1);
  r.scheduler.fire(500);
  r.children[2]!.stderr.write('first line\r\n{"ok":false,"error":{"code":"invalid_session"}}\nno newline');
  await flush();
  r.children[2]!.exit(3);
  assert.equal(r.gaveUp.length, 1);
  assert.equal(r.gaveUp[0]!.code, 3);
  assert.deepEqual(r.gaveUp[0]!.stderr, ['first line', '{"ok":false,"error":{"code":"invalid_session"}}', 'no newline']);
  assert.deepEqual(last(r.exits), { code: 3, signal: null, restartInMs: null });
  assert.deepEqual(r.scheduler.pending(), [], 'nothing is scheduled');
  assert.equal(r.launches.length, 3);
});

test('stop() ends stdin, sends SIGKILL when the grace period expires, and an exit after stop() does not restart', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write(readyLine(1000));
  await flush();
  let stopped = false;
  const done = r.supervisor.stop().then(() => { stopped = true; });
  assert.equal(r.children[0]!.stdinEnded, 1);
  assert.equal(r.children[0]!.kills.length, 0);
  // The reset timer is gone; only the grace timer is left.
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [GRACE]);
  r.scheduler.fire(GRACE);
  // The engine catches SIGTERM, and stdin EOF already asked what SIGTERM asks.
  assert.deepEqual(r.children[0]!.kills, ['SIGKILL']);
  await flush();
  assert.equal(stopped, false, 'stop() waits for the exit');
  r.children[0]!.exit(null, 'SIGKILL');
  await done;
  assert.equal(stopped, true);
  assert.deepEqual(last(r.exits), { code: null, signal: 'SIGKILL', restartInMs: null });
  assert.deepEqual(r.scheduler.pending(), []);
  assert.equal(r.launches.length, 1);
  assert.equal(r.supervisor.current(), null);
});

test('stop() resolves even if the child never exits after SIGKILL', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write(readyLine(1000));
  await flush();
  const done = r.supervisor.stop();
  r.scheduler.fire(GRACE);
  r.scheduler.fire(KILL_GRACE);
  await done;
  assert.deepEqual(r.children[0]!.kills, ['SIGKILL']);
  assert.deepEqual(last(r.exits), { code: null, signal: 'SIGKILL', restartInMs: null });
  assert.equal(r.supervisor.current(), null);
  assert.deepEqual(r.scheduler.pending(), []);
  assert.equal(r.launches.length, 1);
  // A late real exit changes nothing.
  const exits = r.exits.length;
  r.children[0]!.exit(null, 'SIGKILL');
  assert.equal(r.exits.length, exits);
});

test('a second stop() while the kill is under way starts no second grace period', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write(readyLine(1000));
  await flush();
  const first = r.supervisor.stop();
  const second = r.supervisor.stop();
  r.scheduler.fire(GRACE);
  const third = r.supervisor.stop();
  assert.equal(r.children[0]!.stdinEnded, 1);
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [KILL_GRACE]);
  r.children[0]!.exit(null, 'SIGKILL');
  await Promise.all([first, second, third]);
  assert.deepEqual(r.scheduler.pending(), []);
});

test('an engine that exits on stdin EOF within the grace period is not killed', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write(readyLine(1000));
  await flush();
  const done = r.supervisor.stop();
  r.children[0]!.exit(0);
  await done;
  assert.equal(r.children[0]!.kills.length, 0);
  assert.deepEqual(r.scheduler.pending(), [], 'the grace timer is cancelled');
});

test('stop() during a restart delay cancels the restart', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.exit(1);
  await r.supervisor.stop();
  assert.deepEqual(r.scheduler.pending(), []);
  assert.equal(r.launches.length, 1);
});

test('a malformed first line is a failed launch: killed, restarted, never emitted', async () => {
  const bad = [
    'not json\n',
    readyLine(1000, { schema: 'siann.engine.ready.v1' }),
    readyLine(1000, { token: TOKEN.slice(0, 63) }),
    readyLine(1000, { token: 'A'.repeat(64) }),
    readyLine(1000, { mcpToken: TOKEN }),
    readyLine(1000, { port: 0 }),
    readyLine(1000, { sessionId: 'session' }),
    readyLine(1000, { pid: 'x' }),
  ];
  for (const line of bad) {
    const r = rig();
    r.supervisor.start();
    r.children[0]!.stdout.write(line);
    await flush();
    assert.equal(r.ready.length, 0, line);
    assert.equal(r.children[0]!.kills.length, 1, line);
    assert.equal(r.supervisor.current(), null);
    r.children[0]!.exit(null, 'SIGTERM');
    assert.equal(last(r.exits).restartInMs, 250);
    r.scheduler.fire(250);
    assert.equal(r.launches.length, 2);
  }
});

test('a failed launch that ignores SIGTERM gets SIGKILL, then is restarted', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write('not json\n');
  await flush();
  assert.deepEqual(r.children[0]!.kills, [undefined]);
  assert.equal(r.launches.length, 1);
  r.scheduler.fire(KILL_GRACE);
  assert.deepEqual(r.children[0]!.kills, [undefined, 'SIGKILL']);
  r.children[0]!.exit(null, 'SIGKILL');
  assert.deepEqual(last(r.exits), { code: null, signal: 'SIGKILL', restartInMs: 250 });
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [250]);
  r.scheduler.fire(250);
  assert.equal(r.launches.length, 2);
});

test('a failed launch that never exits, even after SIGKILL, is restarted', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write('not json\n');
  await flush();
  r.scheduler.fire(KILL_GRACE);
  r.scheduler.fire(KILL_GRACE);
  assert.deepEqual(last(r.exits), { code: null, signal: 'SIGKILL', restartInMs: 250 });
  r.scheduler.fire(250);
  assert.equal(r.launches.length, 2);
  assert.deepEqual(r.children[1]!.kills, []);
});

test('a failed launch that exits on SIGTERM cancels the SIGKILL', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write('not json\n');
  await flush();
  r.children[0]!.exit(null, 'SIGTERM');
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [250]);
  assert.deepEqual(r.children[0]!.kills, [undefined]);
});

test('stop() during a failed launch waits for the kill already under way', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write('not json\n');
  await flush();
  const done = r.supervisor.stop();
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [KILL_GRACE]);
  r.scheduler.fire(KILL_GRACE);
  r.scheduler.fire(KILL_GRACE);
  await done;
  assert.deepEqual(r.children[0]!.kills, [undefined, 'SIGKILL']);
  assert.deepEqual(r.scheduler.pending(), []);
  assert.equal(r.launches.length, 1);
});

test('a failed launch during stop() replaces the stop timer: one SIGKILL, and stop() stays bounded', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write(readyLine(1000));
  await flush();
  const done = r.supervisor.stop();
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [GRACE]);
  r.children[0]!.stdout.write('late output\n');
  await flush();
  assert.deepEqual(r.children[0]!.kills, [undefined]);
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [KILL_GRACE]);
  r.scheduler.fire(KILL_GRACE);
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [KILL_GRACE]);
  r.scheduler.fire(KILL_GRACE);
  await done;
  assert.deepEqual(r.children[0]!.kills, [undefined, 'SIGKILL']);
  assert.deepEqual(r.scheduler.pending(), []);
  assert.equal(r.launches.length, 1);
});

// After a kill that failed, the next launch must still stop normally: a timer
// left for the dead launch would make stop() skip stdin and the kill.
async function assertNextLaunchStops(r: ReturnType<typeof rig>): Promise<void> {
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [250]);
  r.scheduler.fire(250);
  const next = last(r.children);
  next.stdout.write(readyLine(next.pid));
  await flush();
  const done = r.supervisor.stop();
  assert.equal(next.stdinEnded, 1);
  r.scheduler.fire(GRACE);
  assert.deepEqual(next.kills, ['SIGKILL']);
  next.exit(null, 'SIGKILL');
  await done;
  assert.deepEqual(r.scheduler.pending(), []);
}

// A failed kill is no exit: the child may still run. It ends only on its exit
// event or once killGraceMs after SIGKILL have run out.
test('a SIGTERM that fails is not an exit: SIGKILL follows, and the next launch still stops', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.killMode.SIGTERM = 'false';
  r.children[0]!.stdout.write('not json\n');
  await flush();
  assert.deepEqual(r.children[0]!.kills, [undefined]);
  assert.equal(r.exits.length, 0, 'not exited at the failed kill');
  assert.equal(r.supervisor.current(), null);
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [KILL_GRACE]);
  r.scheduler.fire(KILL_GRACE);
  assert.deepEqual(r.children[0]!.kills, [undefined, 'SIGKILL']);
  assert.equal(r.exits.length, 0);
  r.children[0]!.exit(null, 'SIGKILL');
  assert.deepEqual(last(r.exits), { code: null, signal: 'SIGKILL', restartInMs: 250 });
  await assertNextLaunchStops(r);
});

test('a SIGKILL that fails is not an exit: the launch ends after killGraceMs, and the next launch still stops', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write('not json\n');
  await flush();
  r.children[0]!.killMode.SIGKILL = 'false';
  r.scheduler.fire(KILL_GRACE);
  assert.deepEqual(r.children[0]!.kills, [undefined, 'SIGKILL']);
  assert.equal(r.exits.length, 0, 'not exited at the failed kill');
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [KILL_GRACE]);
  r.scheduler.fire(KILL_GRACE);
  assert.deepEqual(last(r.exits), { code: null, signal: 'SIGKILL', restartInMs: 250 });
  await assertNextLaunchStops(r);
});

test('a kill that returns false or throws, on SIGTERM or SIGKILL, is in the stderr lines and never an exit', async () => {
  const cases: Array<{ signal: 'SIGTERM' | 'SIGKILL'; mode: 'false' | 'throw'; text: RegExp }> = [
    { signal: 'SIGTERM', mode: 'false', text: /SIGTERM.*kill EPERM/ },
    { signal: 'SIGTERM', mode: 'throw', text: /SIGTERM.*kill EINVAL/ },
    { signal: 'SIGKILL', mode: 'false', text: /SIGKILL.*kill EPERM/ },
    { signal: 'SIGKILL', mode: 'throw', text: /SIGKILL.*kill EINVAL/ },
  ];
  for (const { signal, mode, text } of cases) {
    for (const ending of ['exit event', 'kill grace'] as const) {
      const what = `${signal} ${mode}, ended by the ${ending}`;
      const r = rig({ ...BACKOFF, maxRestarts: 0 });
      r.supervisor.start();
      const child = r.children[0]!;
      child.killMode[signal] = mode;
      child.stdout.write('not json\n');
      await flush();
      assert.deepEqual(child.kills, [undefined], what);
      assert.equal(r.exits.length, 0, what);
      assert.equal(r.supervisor.current(), null, what);
      // SIGKILL follows killGraceMs after SIGTERM, whether SIGTERM failed or not.
      r.scheduler.fire(KILL_GRACE);
      assert.deepEqual(child.kills, [undefined, 'SIGKILL'], what);
      assert.equal(r.exits.length, 0, what);
      assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [KILL_GRACE], what);
      if (ending === 'exit event') child.exit(null, 'SIGKILL');
      else r.scheduler.fire(KILL_GRACE);
      assert.equal(r.exits.length, 1, what);
      assert.deepEqual(last(r.exits), { code: null, signal: 'SIGKILL', restartInMs: null }, what);
      assert.equal(r.gaveUp.length, 1, what);
      assert.match(r.gaveUp[0]!.stderr.join('\n'), text, what);
      assert.deepEqual(r.scheduler.pending(), [], what);
    }
  }
});

test('a SIGKILL that fails during stop() is not an exit: stop() resolves on the exit or after killGraceMs', async () => {
  for (const mode of ['false', 'throw'] as const) {
    for (const ending of ['exit event', 'kill grace'] as const) {
      const r = rig();
      r.supervisor.start();
      const child = r.children[0]!;
      child.stdout.write(readyLine(1000));
      await flush();
      child.killMode.SIGKILL = mode;
      let stopped = false;
      const done = r.supervisor.stop().then(() => { stopped = true; });
      r.scheduler.fire(GRACE);
      assert.deepEqual(child.kills, ['SIGKILL']);
      await flush();
      assert.equal(stopped, false, `${mode}: stop() waits on`);
      assert.equal(r.exits.length, 0);
      if (ending === 'exit event') child.exit(null, 'SIGKILL');
      else r.scheduler.fire(KILL_GRACE);
      await done;
      assert.deepEqual(last(r.exits), { code: null, signal: 'SIGKILL', restartInMs: null });
      assert.deepEqual(r.scheduler.pending(), []);
    }
  }
});

test('a failed launch ends stdin before SIGTERM', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write('not json\n');
  await flush();
  assert.equal(r.children[0]!.stdinEnded, 1);
  assert.equal(r.children[0]!.killsBeforeStdinEnd, 0, 'stdin ended before the first kill');
  assert.deepEqual(r.children[0]!.kills, [undefined]);
});

test('a launch with no ready line within readyTimeoutMs is a failed launch: SIGTERM, SIGKILL, restart', async () => {
  const r = rig();
  r.supervisor.start();
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [READY_TIMEOUT]);
  r.scheduler.fire(READY_TIMEOUT);
  assert.deepEqual(r.protocolErrors, ['no ready line within 7777 ms']);
  assert.equal(r.children[0]!.stdinEnded, 1);
  assert.deepEqual(r.children[0]!.kills, [undefined]);
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [KILL_GRACE]);
  r.scheduler.fire(KILL_GRACE);
  assert.deepEqual(r.children[0]!.kills, [undefined, 'SIGKILL']);
  r.children[0]!.exit(null, 'SIGKILL');
  assert.deepEqual(last(r.exits), { code: null, signal: 'SIGKILL', restartInMs: 250 });
  r.scheduler.fire(250);
  assert.equal(r.launches.length, 2);
  // The next launch has its own timeout.
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [READY_TIMEOUT]);
});

test('the ready timeout reason is in the gave-up stderr', async () => {
  const r = rig({ ...BACKOFF, maxRestarts: 0 });
  r.supervisor.start();
  r.scheduler.fire(READY_TIMEOUT);
  r.children[0]!.exit(null, 'SIGTERM');
  assert.equal(r.gaveUp.length, 1);
  assert.match(r.gaveUp[0]!.stderr.join('\n'), /no ready line within 7777 ms/);
});

test('the ready line cancels the ready timeout', async () => {
  const r = rig();
  r.supervisor.start();
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [READY_TIMEOUT]);
  r.children[0]!.stdout.write(readyLine(1000));
  await flush();
  assert.equal(r.ready.length, 1);
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [BACKOFF.resetAfterMs]);
});

test('an exit before the ready line cancels the ready timeout', async () => {
  const r = rig();
  r.supervisor.start();
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [READY_TIMEOUT]);
  r.children[0]!.exit(1);
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [250]);
});

test('stop() cancels the ready timeout', async () => {
  const r = rig();
  r.supervisor.start();
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [READY_TIMEOUT]);
  const done = r.supervisor.stop();
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [GRACE]);
  r.children[0]!.exit(0);
  await done;
  assert.deepEqual(r.scheduler.pending(), []);
  assert.deepEqual(r.protocolErrors, []);
});

test('a malformed ready line cancels the ready timeout', async () => {
  const r = rig();
  r.supervisor.start();
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [READY_TIMEOUT]);
  r.children[0]!.stdout.write('not json\n');
  await flush();
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [KILL_GRACE]);
  assert.deepEqual(r.protocolErrors, ['malformed ready line']);
});

test('the default ready timeout is the spec\'s 30 s', async () => {
  const r = rig(BACKOFF, { readyTimeoutMs: undefined });
  r.supervisor.start();
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [30_000]);
  r.scheduler.fire(30_000);
  assert.deepEqual(r.protocolErrors, ['no ready line within 30000 ms']);
  assert.deepEqual(r.children[0]!.kills, [undefined]);
});

test('a ready line arriving during stop() emits no ready, and stop() still ends the child', async () => {
  const r = rig();
  r.supervisor.start();
  let stopped = false;
  const done = r.supervisor.stop().then(() => { stopped = true; });
  assert.equal(r.children[0]!.stdinEnded, 1);
  r.children[0]!.stdout.write(readyLine(1000));
  await flush();
  assert.equal(r.ready.length, 0);
  assert.equal(stopped, false);
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [GRACE], 'no reset timer either');
  r.children[0]!.exit(0);
  await done;
  assert.equal(stopped, true);
  assert.deepEqual(last(r.exits), { code: 0, signal: null, restartInMs: null });
  assert.deepEqual(r.scheduler.pending(), []);
});

test('start() twice spawns once', async () => {
  const r = rig();
  r.supervisor.start();
  r.supervisor.start();
  assert.equal(r.launches.length, 1);
});

test('stderr is trimmed to stderrLines, a partial last line kept and pushed on exit', async () => {
  const r = rig({ ...BACKOFF, maxRestarts: 0 }, { stderrLines: 3 });
  r.supervisor.start();
  r.children[0]!.stderr.write('one\ntwo\nthree\r\nfour\nfi');
  await flush();
  r.children[0]!.stderr.write('ve');
  await flush();
  r.children[0]!.exit(1);
  assert.deepEqual(r.gaveUp[0]!.stderr, ['three', 'four', 'five']);
});

test('every field of the ready line is checked strictly', async () => {
  const omit = (key: string): string => {
    const value = JSON.parse(readyLine(1000)) as Record<string, unknown>;
    delete value[key];
    return `${JSON.stringify(value)}\n`;
  };
  const bad: Array<[string, string]> = [
    ['no schema', omit('schema')],
    ['schema v1', readyLine(1000, { schema: 'siann.engine.ready.v1' })],
    ['port 0', readyLine(1000, { port: 0 })],
    ['port 65536', readyLine(1000, { port: 65_536 })],
    ['port 1.5', readyLine(1000, { port: 1.5 })],
    ['port a string', readyLine(1000, { port: '40000' })],
    ['token 63 chars', readyLine(1000, { token: TOKEN.slice(0, 63) })],
    ['token uppercase', readyLine(1000, { token: 'A'.repeat(64) })],
    ['no token', omit('token')],
    ['mcpToken equal to token', readyLine(1000, { mcpToken: TOKEN })],
    ['mcpToken non-hex', readyLine(1000, { mcpToken: 'g'.repeat(64) })],
    ['mcpToken 65 chars', readyLine(1000, { mcpToken: 'b'.repeat(65) })],
    ['sessionId without ses_', readyLine(1000, { sessionId: 'session' })],
    ['sessionId ses_ alone', readyLine(1000, { sessionId: 'ses_' })],
    ['sessionId uppercase', readyLine(1000, { sessionId: 'ses_ABCD' })],
    ['pid 0', readyLine(1000, { pid: 0 })],
    ['pid a string', readyLine(1000, { pid: 'x' })],
    ['about null', readyLine(1000, { about: null })],
    ['about a string', readyLine(1000, { about: 'siann-engine' })],
    ['no about', omit('about')],
    ['an array', '[]\n'],
    ['null', 'null\n'],
  ];
  for (const [what, line] of bad) {
    const r = rig();
    r.supervisor.start();
    r.children[0]!.stdout.write(line);
    await flush();
    assert.equal(r.ready.length, 0, what);
    assert.deepEqual(r.protocolErrors, ['malformed ready line'], what);
    assert.deepEqual(r.children[0]!.kills, [undefined], what);
  }
  // The table's base line is good.
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write(readyLine(1000));
  await flush();
  assert.equal(r.ready.length, 1);
});

test('a ready line ending in CRLF is accepted', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.stdout.write(readyLine(1000).replace(/\n$/, '\r\n'));
  await flush();
  assert.equal(r.ready.length, 1);
  assert.equal(r.ready[0]!.pid, 1000);
  assert.deepEqual(r.children[0]!.kills, []);
});

test('a spawn error (ENOENT) is a failed launch: restarted, then gave-up with the error', async () => {
  const r = rig({ ...BACKOFF, maxRestarts: 1 });
  r.supervisor.start();
  r.children[0]!.emit('error', new Error('spawn siann-engine ENOENT'));
  assert.deepEqual(last(r.exits), { code: null, signal: null, restartInMs: 250 });
  r.scheduler.fire(250);
  assert.equal(r.launches.length, 2);
  r.children[1]!.emit('error', new Error('spawn siann-engine ENOENT'));
  assert.deepEqual(last(r.exits), { code: null, signal: null, restartInMs: null });
  assert.equal(r.gaveUp.length, 1);
  assert.match(r.gaveUp[0]!.stderr.join('\n'), /ENOENT/);
  assert.deepEqual(r.scheduler.pending(), []);
});

test('an error followed by an exit counts as one failure', async () => {
  const r = rig();
  r.supervisor.start();
  r.children[0]!.emit('error', new Error('spawn siann-engine ENOENT'));
  r.children[0]!.exit(1);
  assert.equal(r.exits.length, 1);
  assert.deepEqual(r.scheduler.pending().map((t) => t.ms), [250]);
});

test('a spawn that throws is a launch that exited at once: restarted, then gave-up with the error', async () => {
  const r = rig({ ...BACKOFF, maxRestarts: 1 }, {
    spawn: () => {
      throw new Error('spawn EACCES');
    },
  });
  r.supervisor.start();
  assert.deepEqual(last(r.exits), { code: null, signal: null, restartInMs: 250 });
  r.scheduler.fire(250);
  assert.deepEqual(last(r.exits), { code: null, signal: null, restartInMs: null });
  assert.equal(r.gaveUp.length, 1);
  assert.match(r.gaveUp[0]!.stderr.join('\n'), /spawn EACCES/);
  await r.supervisor.stop();
});

test('the default kill graces are those in the spec: 5 s after stop(), 2 s after SIGTERM and after SIGKILL', async () => {
  const defaults: Partial<SupervisorOptions> = { stopGraceMs: undefined, killGraceMs: undefined };

  const stopped = rig(BACKOFF, defaults);
  stopped.supervisor.start();
  stopped.children[0]!.stdout.write(readyLine(1000));
  await flush();
  const done = stopped.supervisor.stop();
  assert.deepEqual(stopped.scheduler.pending().map((t) => t.ms), [5_000]);
  stopped.scheduler.fire(5_000);
  assert.deepEqual(stopped.scheduler.pending().map((t) => t.ms), [2_000]);
  stopped.scheduler.fire(2_000);
  await done;

  const failed = rig(BACKOFF, defaults);
  failed.supervisor.start();
  failed.children[0]!.stdout.write('not json\n');
  await flush();
  assert.deepEqual(failed.scheduler.pending().map((t) => t.ms), [2_000]);
  failed.scheduler.fire(2_000);
  assert.deepEqual(failed.children[0]!.kills, [undefined, 'SIGKILL']);
  assert.deepEqual(failed.scheduler.pending().map((t) => t.ms), [2_000]);
});

test('a second stdout line is a failed launch, also in the same chunk as the ready line', async () => {
  for (const sameChunk of [false, true]) {
    const r = rig();
    r.supervisor.start();
    if (sameChunk) {
      r.children[0]!.stdout.write(`${readyLine(1000)}{"token":"leak"}\n`);
      await flush();
      assert.equal(r.ready.length, 0, 'not emitted');
    } else {
      r.children[0]!.stdout.write(readyLine(1000));
      await flush();
      assert.equal(r.ready.length, 1);
      r.children[0]!.stdout.write('more\n');
      await flush();
    }
    assert.equal(r.children[0]!.kills.length, 1);
    assert.equal(r.supervisor.current(), null, 'the endpoint is withdrawn');
    r.children[0]!.exit(null, 'SIGTERM');
    assert.equal(last(r.exits).restartInMs, 250);
  }
});
