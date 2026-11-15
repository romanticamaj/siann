'use strict';

// A fake engine child process and hand-fired timers for the bridge's unit tests
// (m5b-bridge-native-client): the client's spawn and schedule are injected, so
// no test starts a process it does not need or waits on the wall clock.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { PassThrough } = require('node:stream');

const { EngineClient } = require('../../src/runtime/client');
const { createFakeEngine } = require('./fake-engine-server');

// The job poll interval the tests use: it runs at once (setImmediate).
const POLL_MS = 1;

// stdout and stderr streams, stdin with end(), and kill() that records the
// signal; it exits only when the test says so (or on stdin EOF or a kill when
// exitOnStdinEnd or exitOnKill is set).
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdinEnded = false;
    this.kills = [];
    this.pid = 4242;
    this.exited = false;
    this.stdin = { end: () => { this.stdinEnded = true; if (this.exitOnStdinEnd) this.exit(0); } };
  }

  kill(signal) {
    this.kills.push(signal || 'SIGTERM');
    if (this.exitOnKill) this.exit(null, signal || 'SIGTERM');
    return true;
  }

  line(text) {
    this.stdout.write(`${text}\n`);
  }

  exit(code, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

// Timers the test fires by hand; POLL_MS runs at once.
function manualSchedule() {
  const timers = [];
  const schedule = (fn, ms) => {
    if (ms === POLL_MS) {
      const handle = setImmediate(fn);
      return () => clearImmediate(handle);
    }
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  const fire = (ms) => {
    const due = timers.filter((t) => t.ms === ms && !t.cancelled);
    assert.ok(due.length > 0, `a timer of ${ms} ms is pending`);
    for (const t of due) { t.cancelled = true; t.fn(); }
  };
  return { schedule, timers, fire };
}

// An in-process fake engine and an EngineClient (not started) whose child
// writes its ready line and exits on stdin EOF. Cleaned up after the test.
async function inProcessClient(t, engineOptions = {}) {
  const engine = await createFakeEngine(engineOptions).listen();
  t.after(() => engine.close());
  const child = new FakeChild();
  child.exitOnStdinEnd = true;
  child.exitOnKill = true;
  const timers = manualSchedule();
  const client = new EngineClient({
    exe: 'fake-engine',
    spawn: () => {
      setImmediate(() => child.line(engine.readyLine()));
      return child;
    },
    schedule: timers.schedule,
    pollMs: POLL_MS,
  });
  t.after(() => client.stop());
  return { engine, child, client };
}

// Removes a test's temporary tree and never throws: on Windows an engine that
// is still stopping can hold a file, and a throwing after-hook would skip the
// hooks that stop it (a live engine keeps the test process running).
function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // left in the temp directory
  }
}

module.exports = { FakeChild, POLL_MS, inProcessClient, manualSchedule, removeTree };
