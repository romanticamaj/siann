'use strict';

// src/runtime/client.js against an in-process fake engine over the same
// transport (m5b-bridge-native-client, acceptance item 2): WebSocket on
// 127.0.0.1, the first-frame token handshake and the Protocol v0 envelope. The
// engine process is a fake child (injected spawn) that writes the ready line
// with the fake server's port; timers are injected (schedule), so no test
// waits on the wall clock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EngineClient,
  READY_SCHEMA,
  RuntimeError,
  defaultEngineExe,
  parseReadyLine,
  resolveEngineExe,
} = require('../src/runtime/client');
const { FakeChild, POLL_MS, manualSchedule } = require('./helpers/fake-child');
const { FakeError, createFakeEngine } = require('./helpers/fake-engine-server');

const HEX = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);

function readyLineOf(options, engine) {
  if (typeof options.readyLine === 'function') return options.readyLine(engine);
  return options.readyLine || engine.readyLine();
}

async function fixture(t, options = {}) {
  const engine = await createFakeEngine(options.engine).listen();
  t.after(() => engine.close());
  const child = new FakeChild();
  Object.assign(child, options.child || {});
  const spawned = [];
  const timers = manualSchedule();
  const client = new EngineClient({
    exe: '/opt/siann/siann-engine',
    args: ['--device', 'fake'],
    spawn: (exe, args) => {
      spawned.push({ exe, args });
      if (options.ready !== false) setImmediate(() => child.line(readyLineOf(options, engine)));
      return child;
    },
    schedule: timers.schedule,
    readyTimeoutMs: 30000,
    stopGraceMs: 5000,
    killGraceMs: 2000,
    pollMs: POLL_MS,
    ...options.client,
  });
  t.after(async () => {
    child.exitOnStdinEnd = true;
    child.exitOnKill = true;
    await client.stop();
  });
  return { engine, child, client, spawned, timers };
}

test('parseReadyLine accepts the documented ready line and nothing else', () => {
  const good = { schema: READY_SCHEMA, port: 4100, token: HEX, mcpToken: OTHER_HEX, sessionId: 'ses_0abc', pid: 7,
    about: { name: 'siann-engine' } };
  assert.deepEqual(parseReadyLine(JSON.stringify(good)),
    { port: 4100, token: HEX, mcpToken: OTHER_HEX, sessionId: 'ses_0abc', pid: 7, about: { name: 'siann-engine' } });
  const bad = [
    'not json', '[]', 'null',
    { ...good, schema: 'siann.engine.ready.v1' },
    { ...good, port: 0 }, { ...good, port: 70000 }, { ...good, port: 1.5 },
    { ...good, token: 'A'.repeat(64) }, { ...good, mcpToken: HEX },
    { ...good, sessionId: 'ses_XYZ' }, { ...good, pid: 0 }, { ...good, about: null },
  ];
  for (const value of bad) {
    assert.equal(parseReadyLine(typeof value === 'string' ? value : JSON.stringify(value)), null, JSON.stringify(value));
  }
});

test('start launches the engine on a scratch bundle, authenticates, and requests carry the envelope', async (t) => {
  const { engine, client, spawned } = await fixture(t);
  const ready = await client.start();
  assert.equal(ready.port, engine.port);
  assert.equal(client.sessionId, engine.sessionId);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].exe, '/opt/siann/siann-engine');
  const at = spawned[0].args.indexOf('--session');
  assert.ok(at >= 0, 'the engine is launched with --session');
  assert.ok(path.isAbsolute(spawned[0].args[at + 1]));
  assert.deepEqual(spawned[0].args.slice(-2), ['--device', 'fake']);

  const status = await client.request('engine.status');
  assert.equal(status.device.sampleRate, 48000);
  await client.request('engine.about');
  const ids = engine.calls.map((call) => call.method);
  assert.deepEqual(ids, ['engine.status', 'engine.about']);
  assert.ok(engine.calls.every((call) => call.sessionId === ready.sessionId));
});

test('requestIds are unique per client', async (t) => {
  const seen = [];
  const { client } = await fixture(t, { engine: { onRequest: (request) => seen.push(request.requestId) } });
  await client.start();
  await Promise.all([client.request('engine.status'), client.request('engine.status'), client.request('engine.about')]);
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 3);
});

test('a refused token is invalid_token, and the engine is stopped', async (t) => {
  const badToken = (engine) => JSON.stringify({ ...JSON.parse(engine.readyLine()), token: 'c'.repeat(64) });
  const { client, child } = await fixture(t, { readyLine: badToken, child: { exitOnStdinEnd: true } });
  await assert.rejects(client.start(), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, 'invalid_token');
    return true;
  });
  assert.equal(child.stdinEnded, true);
});

test('an unknown method is unknown_method', async (t) => {
  const { client } = await fixture(t);
  await client.start();
  await assert.rejects(client.request('no.such'), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, 'unknown_method');
    assert.match(error.message, /no\.such/);
    return true;
  });
});

test('protocol errors map code, message, step and data onto RuntimeError', async (t) => {
  const { client } = await fixture(t, { engine: { handlers: {
    'plan.approve': () => {
      throw new FakeError('plan_stale', 'the plan is stale', { step: 2,
        data: { plan: 'sha256:x', changedEntities: [{ ref: 'track:trk_1', change: 'modified' }] } });
    },
  } } });
  await client.start();
  await assert.rejects(client.request('plan.approve', { plan: 'sha256:x' }), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, 'plan_stale');
    assert.equal(error.message, 'the plan is stale');
    assert.equal(error.step, 2);
    assert.deepEqual(error.data.changedEntities, [{ ref: 'track:trk_1', change: 'modified' }]);
    assert.equal(error.method, 'plan.approve');
    return true;
  });
});

test('waitJob follows job.status until done', async (t) => {
  let polls = 0;
  const { client } = await fixture(t, { engine: { handlers: {
    'job.status': (params) => {
      polls += 1;
      return polls < 3 ? { jobId: params.jobId, kind: 'render', state: 'running' }
        : { jobId: params.jobId, kind: 'render', state: 'done', result: { path: '/x.wav' } };
    },
  } } });
  await client.start();
  const status = await client.waitJob('job_1');
  assert.equal(status.state, 'done');
  assert.deepEqual(status.result, { path: '/x.wav' });
  assert.equal(polls, 3);
});

test('a job that ends failed rejects with its error code', async (t) => {
  const { client } = await fixture(t, { engine: { handlers: {
    'job.status': (params) => ({ jobId: params.jobId, kind: 'media.import', state: 'failed',
      error: { code: 'decode_failed', message: 'truncated' } }),
  } } });
  await client.start();
  await assert.rejects(client.waitJob('job_9'), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, 'decode_failed');
    assert.equal(error.message, 'truncated');
    assert.equal(error.data.jobId, 'job_9');
    return true;
  });
});

test('a cancelled job rejects with cancelled', async (t) => {
  const { client } = await fixture(t, { engine: { handlers: {
    'job.status': (params) => ({ jobId: params.jobId, kind: 'media.import', state: 'failed',
      error: { code: 'cancelled', message: 'session.create cancelled the import' } }),
  } } });
  await client.start();
  await assert.rejects(client.waitJob('job_2'), { code: 'cancelled' });
});

test('the engine exiting mid-request rejects the request at once', async (t) => {
  const { client, child } = await fixture(t, { engine: { handlers: {
    'slow.method': () => {
      setImmediate(() => child.exit(3));
      return undefined; // never answered
    },
  } } });
  await client.start();
  await assert.rejects(client.request('slow.method'), (error) => {
    assert.equal(error.code, 'engine_exited');
    assert.match(error.message, /3/);
    return true;
  });
  await assert.rejects(client.request('engine.status'), { code: 'engine_exited' });
});

test('the socket closing mid-request rejects the request', async (t) => {
  const { client, engine } = await fixture(t, { engine: { handlers: {
    'drop.me': () => {
      setImmediate(() => { for (const ws of engine.sockets) ws.destroy(); });
      return undefined;
    },
  } } });
  await client.start();
  await assert.rejects(client.request('drop.me'), { code: 'connection_closed' });
});

test('stop with requests in flight rejects them, closes stdin, and kills after the grace', async (t) => {
  const { client, child, timers } = await fixture(t, { engine: { handlers: { 'hang': () => undefined } } });
  await client.start();
  const first = client.request('hang');
  const second = client.request('hang');
  const stopped = client.stop();
  await assert.rejects(first, { code: 'engine_stopped' });
  await assert.rejects(second, { code: 'engine_stopped' });
  assert.equal(child.stdinEnded, true);
  assert.deepEqual(child.kills, []);
  timers.fire(5000);
  assert.deepEqual(child.kills, ['SIGKILL']);
  child.exit(null, 'SIGKILL');
  await stopped;
  await assert.rejects(client.request('engine.status'), { code: 'engine_stopped' });
});

test('stop resolves after SIGKILL and the kill grace even when the child never exits', async (t) => {
  const { client, child, timers } = await fixture(t);
  await client.start();
  const stopped = client.stop();
  timers.fire(5000);
  timers.fire(2000);
  await stopped;
  assert.deepEqual(child.kills, ['SIGKILL']);
});

test('an engine that exits on stdin EOF stops without a kill', async (t) => {
  const { client, child } = await fixture(t, { child: { exitOnStdinEnd: true } });
  await client.start();
  await client.stop();
  assert.deepEqual(child.kills, []);
});

test('a malformed ready line fails the launch', async (t) => {
  const { client, child } = await fixture(t, { readyLine: '{"schema":"siann.engine.ready.v0","port":"x"}' });
  await assert.rejects(client.start(), { code: 'bad_ready_line' });
  assert.equal(child.stdinEnded, true);
});

test('a second stdout line fails the engine: requests in flight reject', async (t) => {
  const { client, child } = await fixture(t, { engine: { handlers: { 'hang': () => undefined } } });
  await client.start();
  const pending = client.request('hang');
  child.line('{"surprise":true}');
  await assert.rejects(pending, { code: 'unexpected_stdout' });
  assert.equal(child.stdinEnded, true);
});

test('no ready line within the timeout fails the launch', async (t) => {
  const { client, child, timers } = await fixture(t, { ready: false });
  const started = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  timers.fire(30000);
  await assert.rejects(started, { code: 'ready_timeout' });
  assert.equal(child.stdinEnded, true);
});

test('an engine that exits before its ready line fails with its last stderr line', async (t) => {
  const { client, child } = await fixture(t, { ready: false });
  const started = client.start();
  child.stderr.write('JUCE noise\n{"ok":false,"error":{"code":"session_locked","message":"held by 12"}}\n');
  await new Promise((resolve) => setImmediate(resolve));
  child.exit(1);
  await assert.rejects(started, (error) => {
    assert.equal(error.code, 'session_locked');
    assert.match(error.message, /held by 12/);
    return true;
  });
});

test('a spawn that throws or emits error fails the launch', async (t) => {
  const failing = new EngineClient({ exe: '/nope', spawn: () => { throw new Error('ENOENT'); },
    schedule: manualSchedule().schedule });
  await assert.rejects(failing.start(), { code: 'engine_spawn_failed' });
  const { client, child } = await fixture(t, { ready: false });
  const started = client.start();
  child.emit('error', new Error('EACCES'));
  await assert.rejects(started, { code: 'engine_spawn_failed' });
});

test('session.create and session.open results are adopted as the served sessionId', async (t) => {
  const { client, engine } = await fixture(t);
  await client.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-client-create-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const created = await client.request('session.create', { path: path.join(dir, 'Song.siann') });
  assert.equal(client.sessionId, created.sessionId);
  await client.request('session.inspect');
  assert.equal(engine.calls.at(-1).sessionId, created.sessionId);
  const opened = await client.request('session.open', { path: path.join(dir, 'Song.siann') });
  assert.notEqual(opened.sessionId, created.sessionId);
  assert.equal(client.sessionId, opened.sessionId);
});

test('requests before start are refused', async () => {
  const client = new EngineClient({ exe: '/x', spawn: () => { throw new Error('unused'); } });
  await assert.rejects(client.request('engine.status'), { code: 'engine_not_started' });
});

test('resolveEngineExe: SIANN_ENGINE_EXE first, then the core preset build under native/', () => {
  const root = path.join(os.tmpdir(), 'siann-root');
  assert.equal(resolveEngineExe({ env: { SIANN_ENGINE_EXE: '/opt/e/siann-engine' }, root, exists: () => false }),
    path.resolve('/opt/e/siann-engine'));
  const win = defaultEngineExe(root, 'win32');
  assert.equal(win, path.join(root, 'native', 'build', 'dev', 'apps', 'engine', 'siann-engine.exe'));
  const posix = defaultEngineExe(root, 'linux');
  assert.equal(posix, path.join(root, 'native', 'build', 'dev', 'apps', 'engine', 'siann-engine'));
  assert.equal(resolveEngineExe({ env: {}, root, platform: 'linux', exists: (p) => p === posix }), posix);
  assert.throws(() => resolveEngineExe({ env: {}, root, platform: 'darwin', exists: () => false }), (error) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, 'engine_not_found');
    assert.match(error.message, /SIANN_ENGINE_EXE/);
    assert.match(error.message, /--preset dev/);
    return true;
  });
});

test('client.js no longer knows the Ardour runtime or the sibling checkout', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime', 'client.js'), 'utf8');
  for (const gone of ['ardour9-siann_runtime', 'ardev_common_waf', 'SIANN_ENGINE_DIR', "'..', 'siann-engine'"]) {
    assert.ok(!source.includes(gone), gone);
  }
});
