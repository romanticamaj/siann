'use strict';

// The Node bridge's client for the native engine (m5b-bridge-native-client;
// architecture spec, "siann-protocol", Protocol v0 items 2 and 17, and
// "Process model"). It starts siann-engine on a scratch bundle, reads the ready
// line as app/src/main/supervisor.ts does, connects to the command socket on
// 127.0.0.1 with the first-frame token handshake, sends requests in the v0
// envelope, follows job.status for jobs, and stops the engine by closing its
// stdin (the engine exits on EOF), with SIGKILL after a grace period.
//
// The engine executable is SIANN_ENGINE_EXE, else the core preset's build
// (native/build/dev/apps/engine/siann-engine, `cmake --preset dev`). Node
// built-ins only: the WebSocket codec is src/runtime/ws.js.
//
// Process creation and timers are injected (spawn, schedule), so the unit
// tests drive every path without real processes or wall-clock waits.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ws = require('./ws');

const READY_SCHEMA = 'siann.engine.ready.v0';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HEX64 = /^[0-9a-f]{64}$/;
const SESSION_ID = /^ses_[0-9a-f]+$/;
const STDERR_LINES = 20;

// A protocol error (`code`, `message`, `step`, `data` as the engine sent
// them), or a client-side failure with a stable code: engine_not_found,
// engine_spawn_failed, bad_ready_line, ready_timeout, unexpected_stdout,
// engine_exited, connection_closed, engine_stopped, engine_not_started.
class RuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message || code || 'runtime error');
    this.name = 'RuntimeError';
    this.code = code || 'runtime_error';
    if (details.step !== undefined) this.step = details.step;
    if (details.data !== undefined) this.data = details.data;
    if (details.method !== undefined) this.method = details.method;
    if (details.response !== undefined) this.response = details.response;
  }
}

// The ready line, strictly (app/src/main/supervisor.ts, parseReadyLine): null
// unless every field has its documented shape.
function parseReadyLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { port, token, mcpToken, sessionId, pid, about } = value;
  if (value.schema !== READY_SCHEMA) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof token !== 'string' || !HEX64.test(token)) return null;
  if (typeof mcpToken !== 'string' || !HEX64.test(mcpToken) || mcpToken === token) return null;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null;
  if (typeof about !== 'object' || about === null) return null;
  return { port, token, mcpToken, sessionId, pid, about };
}

// Where the core preset (`cmake --preset dev`) puts siann-engine.
function defaultEngineExe(root = REPO_ROOT, platform = process.platform) {
  return path.join(root, 'native', 'build', 'dev', 'apps', 'engine',
    platform === 'win32' ? 'siann-engine.exe' : 'siann-engine');
}

function resolveEngineExe({ env = process.env, root = REPO_ROOT, platform = process.platform,
  exists = fs.existsSync } = {}) {
  if (env.SIANN_ENGINE_EXE) return path.resolve(env.SIANN_ENGINE_EXE);
  const built = defaultEngineExe(root, platform);
  if (exists(built)) return built;
  throw new RuntimeError('engine_not_found', `no siann-engine: set SIANN_ENGINE_EXE, or build the core preset `
    + `(cmake --preset dev && cmake --build --preset dev --target siann-engine in native/) so that ${built} exists`);
}

function defaultSpawn(exe, args, options) {
  return childProcess.spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...options });
}

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

// Splits a stream into lines, calling onLine for each complete one.
function onLines(stream, onLine) {
  let partial = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    partial += chunk;
    let at = partial.indexOf('\n');
    while (at >= 0) {
      const line = partial.slice(0, at).replace(/\r$/, '');
      partial = partial.slice(at + 1);
      onLine(line);
      at = partial.indexOf('\n');
    }
  });
}

// A launch error from the engine's last stderr line ({ok: false, error: {code,
// message}}, Protocol v0 item 17), or null.
function launchError(stderrLines) {
  for (let i = stderrLines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(stderrLines[i]);
      if (value && value.ok === false && value.error && typeof value.error.code === 'string') return value.error;
    } catch {
      // not the JSON error line
    }
  }
  return null;
}

class EngineClient {
  constructor(options = {}) {
    if (!options.exe) throw new Error('EngineClient requires exe (resolveEngineExe())');
    this.exe = options.exe;
    this.args = options.args || [];
    // Before --session: a script's path when exe is an interpreter (the tests' fake engine).
    this.prefixArgs = options.prefixArgs || [];
    this.bundle = options.session || null;
    this.cwd = options.cwd;
    this.env = options.env;
    this.spawn = options.spawn || defaultSpawn;
    this.schedule = options.schedule || defaultSchedule;
    this.connect = options.connect || ws.connect;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30000;
    this.stopGraceMs = options.stopGraceMs ?? 5000;
    this.killGraceMs = options.killGraceMs ?? 2000;
    this.pollMs = options.pollMs ?? 50;
    this.requestPrefix = `bridge-${crypto.randomBytes(4).toString('hex')}`;
    this.nextRequest = 1;
    this.pending = new Map();
    this.stderr = [];
    this.child = null;
    this.socket = null;
    this.ready = null;
    this.sessionId = null;
    this.failure = null; // the RuntimeError every later request gets
    this.exited = false;
    this.exitWaiters = [];
    this.starting = null;
    this.stopping = null;
    this.scratchDir = null;
  }

  // Launches the engine and authenticates; resolves with the ready line.
  start() {
    if (!this.starting) {
      this.starting = this.launch().catch((error) => {
        this.fail(error);
        this.terminate();
        throw error;
      });
    }
    return this.starting;
  }

  async launch() {
    if (!this.bundle) {
      this.scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-bridge-'));
      this.bundle = path.join(this.scratchDir, 'scratch.siann');
    }
    const ready = await this.spawnEngine([...this.prefixArgs, '--session', this.bundle, ...this.args]);
    this.ready = ready;
    this.sessionId = ready.sessionId;
    let socket;
    try {
      socket = await this.connect({ host: '127.0.0.1', port: ready.port, path: '/' });
    } catch (error) {
      throw new RuntimeError('connection_closed', `cannot connect to siann-engine on port ${ready.port}: ${error.message}`);
    }
    if (this.failure) {
      socket.destroy();
      throw this.failure;
    }
    this.socket = socket;
    const auth = await this.authenticate(socket, ready.token);
    this.sessionId = auth.sessionId || ready.sessionId;
    return ready;
  }

  spawnEngine(args) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(this.exe, args, { cwd: this.cwd, env: this.env ? { ...process.env, ...this.env } : undefined });
      } catch (error) {
        reject(new RuntimeError('engine_spawn_failed', `cannot start ${this.exe}: ${error.message}`));
        return;
      }
      this.child = child;
      let ready = null;
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cancelReady();
        fn(value);
      };
      const cancelReady = this.schedule(() => {
        settle(reject, new RuntimeError('ready_timeout',
          `siann-engine wrote no ready line within ${this.readyTimeoutMs} ms`));
      }, this.readyTimeoutMs);

      onLines(child.stdout, (line) => {
        if (ready === null && !settled) {
          ready = parseReadyLine(line);
          if (ready) settle(resolve, ready);
          else settle(reject, new RuntimeError('bad_ready_line', `siann-engine wrote a malformed ready line: ${line.slice(0, 200)}`));
          return;
        }
        // Protocol v0 item 17: the ready line is the only stdout line.
        this.fatal(new RuntimeError('unexpected_stdout', `siann-engine wrote to stdout after its ready line: ${line.slice(0, 200)}`));
      });
      if (child.stderr) {
        onLines(child.stderr, (line) => {
          this.stderr.push(line);
          if (this.stderr.length > STDERR_LINES) this.stderr.shift();
        });
      }
      child.on('error', (error) => {
        const failure = new RuntimeError('engine_spawn_failed', `siann-engine (${this.exe}): ${error.message}`);
        if (!settled) settle(reject, failure);
        else this.fatal(failure);
      });
      child.on('exit', (code, signal) => {
        this.exited = true;
        const how = signal ? `signal ${signal}` : `code ${code}`;
        if (!settled) {
          // Before the ready line: the launch error the engine printed last, if any.
          const launch = launchError(this.stderr);
          settle(reject, launch
            ? new RuntimeError(launch.code, `siann-engine exited with ${how}: ${launch.message || launch.code}`)
            : new RuntimeError('engine_exited', `siann-engine exited with ${how} before its ready line`
              + `${this.stderr.length ? `: ${this.stderr.at(-1)}` : ''}`));
        } else if (!this.stopping) {
          this.fail(new RuntimeError('engine_exited', `siann-engine exited with ${how}`
            + `${this.stderr.length ? `; last stderr line: ${this.stderr.at(-1)}` : ''}`));
        }
        for (const waiter of this.exitWaiters.splice(0)) waiter();
      });
    });
  }

  authenticate(socket, token) {
    return new Promise((resolve, reject) => {
      const onMessage = (data) => {
        let frame;
        try {
          frame = JSON.parse(data);
        } catch {
          return;
        }
        if (!frame || frame.type !== 'auth') return;
        socket.off('message', onMessage);
        if (frame.ok) {
          socket.on('message', (text) => this.receive(text));
          resolve(frame);
        } else {
          const code = (frame.error && frame.error.code) || 'invalid_token';
          reject(new RuntimeError(code, `siann-engine refused the token (${code})`));
        }
      };
      socket.on('message', onMessage);
      socket.on('error', () => {});
      socket.on('close', () => {
        reject(this.failure || new RuntimeError('connection_closed', 'the engine closed the connection'));
        this.fail(this.stopping
          ? new RuntimeError('engine_stopped', 'the engine was stopped')
          : new RuntimeError('connection_closed', 'the engine closed the command connection'));
      });
      socket.sendText(JSON.stringify({ type: 'auth', token }));
    });
  }

  receive(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message.requestId !== 'string') return; // events and stray frames
    const entry = this.pending.get(message.requestId);
    if (!entry) return;
    this.pending.delete(message.requestId);
    if (message.ok === true) {
      const { result } = message;
      // session.open and session.create serve a new session (Protocol v0 item 16).
      if (result && typeof result.sessionId === 'string'
          && (entry.method === 'session.create' || entry.method === 'session.open')) {
        this.sessionId = result.sessionId;
      }
      entry.resolve(result);
      return;
    }
    const error = message.error || {};
    entry.reject(new RuntimeError(error.code || 'internal_error', error.message || error.code,
      { step: error.step, data: error.data, method: entry.method, response: message }));
  }

  // Sends one request; resolves with its result or rejects with RuntimeError.
  request(method, params = {}, { expectedRevision } = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.socket || !this.ready) {
      return Promise.reject(new RuntimeError('engine_not_started', `start() the client before ${method}`));
    }
    const requestId = `${this.requestPrefix}-${this.nextRequest++}`;
    const envelope = { requestId, sessionId: this.sessionId, method, params };
    if (expectedRevision !== undefined) envelope.expectedRevision = expectedRevision;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { method, resolve, reject });
      this.socket.sendText(JSON.stringify(envelope));
    });
  }

  // Follows job.status until the job is done (resolves with its status) or
  // failed (rejects with the job's error code; data is the status).
  async waitJob(jobId) {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const status = await this.request('job.status', { jobId });
      if (status.state === 'done') return status;
      if (status.state === 'failed') {
        const error = status.error || {};
        throw new RuntimeError(error.code || 'job_failed', error.message || `job ${jobId} failed`,
          { data: status, method: 'job.status' });
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => this.schedule(resolve, this.pollMs));
    }
  }

  // Every request in flight and every later one rejects with error.
  fail(error) {
    if (!this.failure) this.failure = error;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(this.failure);
  }

  // A broken engine: fail, then end it.
  fatal(error) {
    this.fail(error);
    this.terminate();
  }

  // Closes the socket and the engine's stdin; SIGKILL after stopGraceMs, then
  // the child counts as gone after killGraceMs. Resolves once it has exited or
  // outlived SIGKILL.
  terminate() {
    if (this.terminating) return this.terminating;
    if (this.socket) {
      this.socket.close(1000, 'bridge done');
    }
    const child = this.child;
    if (!child || this.exited) {
      this.terminating = Promise.resolve();
      return this.terminating;
    }
    this.terminating = new Promise((resolve) => {
      let cancelKill = () => {};
      this.exitWaiters.push(() => { cancelKill(); resolve(); });
      try {
        child.stdin?.end();
      } catch {
        // a closed pipe: the child is on its way out
      }
      cancelKill = this.schedule(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // the exit event or the grace below ends it
        }
        cancelKill = this.schedule(resolve, this.killGraceMs);
      }, this.stopGraceMs);
    });
    return this.terminating;
  }

  // Stops the engine: requests in flight reject with engine_stopped; resolves
  // once the engine has exited (or outlived SIGKILL). Removes the scratch bundle.
  stop() {
    if (!this.stopping) {
      this.stopping = (async () => {
        this.fail(new RuntimeError('engine_stopped', 'the engine was stopped'));
        const ending = this.terminate();
        // A launch that failed already closed stdin; closing it again is harmless.
        if (this.child && !this.exited) {
          try {
            this.child.stdin?.end();
          } catch {
            // already closed
          }
        }
        await ending;
        if (this.socket) this.socket.destroy();
        if (this.scratchDir) {
          try {
            fs.rmSync(this.scratchDir, { recursive: true, force: true });
          } catch {
            // a file the engine still holds on Windows: left in the temp directory
          }
        }
      })();
    }
    return this.stopping;
  }
}

module.exports = {
  EngineClient,
  READY_SCHEMA,
  RuntimeError,
  defaultEngineExe,
  parseReadyLine,
  resolveEngineExe,
};
