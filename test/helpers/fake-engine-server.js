'use strict';

// A fake siann-engine protocol server for the bridge's unit tests
// (m5b-bridge-native-client): node:http's upgrade plus the bridge's own codec
// (src/runtime/ws.js), the auth handshake and envelope of Protocol v0 item 2,
// and a small model of the methods the bridge calls (session.create and
// .open, engine.status, media.import with job.status, plan.submit, .approve,
// .apply and .rollback, session.save, .inspect and .sync, render.start). It
// is not the engine: the gated tests (SIANN_RUN_ENGINE_TESTS) run the real one.
//
// The state of an open session is written to <bundle>/fake-engine.json after
// every change, so a later process (test/helpers/fake-engine.js) opens it again
// the way siann-engine opens a bundle.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { acceptUpgrade } = require('../../src/runtime/ws');
const { sha256Jcs } = require('../../src/hash/jcs');
const { planHash } = require('../../src/hash/plan-hash');

const STATE_FILE = 'fake-engine.json';

class FakeError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.code = code;
    this.extra = extra;
  }
}

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

function emptyDocument(name, sampleRate) {
  return {
    root: { schema: 'siann.entity.root.v1', id: 'root', name, sampleRate, tempo: [], trackOrder: [] },
    media: {},
    tracks: {},
    clips: {},
  };
}

function documentHash(doc) {
  return sha256Jcs(doc);
}

function entityHash(doc, type, id) {
  if (type === 'root') return sha256Jcs(doc.root);
  const table = { track: doc.tracks, clip: doc.clips, media: doc.media }[type];
  return table && table[id] ? sha256Jcs(table[id]) : null;
}

// The WAV fields media.import reports: channels, rate and frames from the header.
function readWav(file) {
  const data = fs.readFileSync(file);
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new FakeError('unsupported_media', `${file} is not a WAV file`);
  }
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      fmt = { channels: data.readUInt16LE(offset + 10), sampleRate: data.readUInt32LE(offset + 12),
        blockAlign: data.readUInt16LE(offset + 20) };
    } else if (id === 'data' && fmt) {
      return { ...fmt, frames: Math.floor(Math.min(size, data.length - offset - 8) / fmt.blockAlign),
        contentHash: `sha256:${crypto.createHash('sha256').update(data).digest('hex')}` };
    }
    offset += 8 + size + (size % 2);
  }
  throw new FakeError('decode_failed', `${file} has no fmt and data chunks`);
}

class FakeSession {
  constructor(bundle, state) {
    this.bundle = bundle;
    this.state = state;
  }

  static create(bundle, name, sampleRate) {
    fs.mkdirSync(bundle);
    const doc = emptyDocument(name, sampleRate);
    const session = new FakeSession(bundle, {
      revisions: [{ id: 'r1', parents: [], cause: 'create', documentHash: documentHash(doc), doc }],
      checkpoint: null,
    });
    session.save();
    return session;
  }

  static open(bundle) {
    const file = path.join(bundle, STATE_FILE);
    if (!fs.existsSync(file)) throw new FakeError('not_a_bundle', `${bundle} is not a fake bundle`);
    return new FakeSession(bundle, JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  save() {
    fs.writeFileSync(path.join(this.bundle, STATE_FILE), JSON.stringify(this.state));
  }

  get head() {
    return this.state.revisions.at(-1);
  }

  revision(id) {
    const found = this.state.revisions.find((r) => r.id === id);
    if (!found) throw new FakeError('not_found', `no revision with id ${id}`);
    return found;
  }

  commit(cause, doc, extra = {}) {
    const revision = {
      id: `r${this.state.revisions.length + 1}`,
      parents: [this.head.id],
      cause,
      documentHash: documentHash(doc),
      doc,
      ...extra,
    };
    this.state.revisions.push(revision);
    this.save();
    return revision;
  }
}

function envelope(revision) {
  const { doc, ...rest } = revision;
  return rest;
}

// Applies plan steps to a document: the two commands the bridge plans.
function applySteps(doc, steps) {
  const next = clone(doc);
  steps.forEach((step, index) => {
    const fail = (code, message) => { throw new FakeError(code, message, { step: index }); };
    if (step.op === 'track.add') {
      if (next.tracks[step.trackId]) fail('already_exists', `a track with id ${step.trackId} already exists`);
      if (![1, 2].includes(step.channels)) fail('invalid_channels', 'track channels must be 1 or 2');
      next.tracks[step.trackId] = { schema: 'siann.entity.track.v1', id: step.trackId, name: step.name, kind: 'audio',
        channels: step.channels, gainMilliDb: 0, pan: 0, mute: false, solo: false };
      next.root.trackOrder.push(step.trackId);
    } else if (step.op === 'clip.place') {
      if (next.clips[step.clipId]) fail('already_exists', `a clip with id ${step.clipId} already exists`);
      if (!next.tracks[step.trackId]) fail('not_found', `no track with id ${step.trackId}`);
      if (!next.media[step.mediaId]) fail('not_found', `no media with id ${step.mediaId}`);
      next.clips[step.clipId] = { schema: 'siann.entity.clip.v1', id: step.clipId, trackId: step.trackId,
        mediaId: step.mediaId, position: step.position, sourceStart: step.sourceStart, length: step.length,
        gainMilliDb: 0 };
    } else {
      fail('unknown_command', `unknown command ${step.op}`);
    }
  });
  return next;
}

function writeSetOf(doc, steps) {
  const refs = new Map();
  for (const step of steps) {
    if (step.op === 'track.add') {
      refs.set('root:root', ['root', 'root']);
      refs.set(`track:${step.trackId}`, ['track', step.trackId]);
    } else if (step.op === 'clip.place') {
      refs.set(`clip:${step.clipId}`, ['clip', step.clipId]);
    }
  }
  return [...refs.values()]
    .sort(([ta, ia], [tb, ib]) => (ta === tb ? (ia < ib ? -1 : ia > ib ? 1 : 0) : (ta < tb ? -1 : 1)))
    .map(([type, id]) => ({ type, id, hash: entityHash(doc, type, id) }));
}

// The fake engine. options: token, sessionId, sampleRate (the device rate),
// handlers ({method: (params, ctx) => result}, run before the model), and
// onRequest(request) for the tests that watch the traffic.
function createFakeEngine(options = {}) {
  const engine = {
    token: options.token || hex(32),
    mcpToken: options.mcpToken || hex(32),
    sessionId: options.sessionId || `ses_${hex(8)}`,
    sampleRate: options.sampleRate || 48000,
    session: options.session || null,
    plans: new Map(),
    jobs: new Map(),
    calls: [],
    sockets: new Set(),
    nextJob: 1,
    importIds: new Map(),
  };
  const handlers = options.handlers || {};

  function requireSession() {
    if (!engine.session) throw new FakeError('internal_error', 'no session is served');
    return engine.session;
  }

  function serve(newSession) {
    engine.session = newSession;
    engine.sessionId = `ses_${hex(8)}`;
    engine.plans.clear();
    engine.importIds.clear();
    return { sessionId: engine.sessionId, revision: newSession.head.id, documentHash: newSession.head.documentHash };
  }

  function requirePlan(params) {
    const plan = engine.plans.get(params.plan);
    if (!plan) throw new FakeError('not_found', `no plan ${params.plan}`);
    return plan;
  }

  function stringParam(params, key, method) {
    if (typeof params[key] !== 'string') throw new FakeError('invalid_params', `${method}: ${key} must be a string`);
    return params[key];
  }

  const methods = {
    'engine.status': () => ({ device: { id: 'fake', sampleRate: engine.sampleRate, bufferFrames: 256 }, playing: false }),
    'engine.about': () => ({ name: 'fake-engine', version: '0' }),
    'session.create': (params) => {
      const target = stringParam(params, 'path', 'session.create');
      if (!path.isAbsolute(target)) throw new FakeError('invalid_params', 'session.create: path must be absolute');
      if (fs.existsSync(target)) throw new FakeError('already_exists', `${target} exists`);
      if (!fs.existsSync(path.dirname(target))) throw new FakeError('not_found', `no directory ${path.dirname(target)}`);
      const name = params.name || path.basename(target, path.extname(target));
      return serve(FakeSession.create(target, name, engine.sampleRate));
    },
    'session.open': (params) => {
      const target = stringParam(params, 'path', 'session.open');
      if (!fs.existsSync(target)) throw new FakeError('not_found', `no directory at ${target}`);
      return serve(FakeSession.open(target));
    },
    'session.inspect': () => {
      const session = requireSession();
      return { revision: session.head.id, documentHash: session.head.documentHash,
        revisions: session.state.revisions.length, branches: [] };
    },
    'session.sync': () => {
      const session = requireSession();
      const { doc } = session.head;
      return { revision: session.head.id, seq: '0', meters: null, pendingTakes: [],
        documentHash: session.head.documentHash, entities: 1 + Object.keys(doc.media).length
          + Object.keys(doc.tracks).length + Object.keys(doc.clips).length,
        chunk: { root: doc.root, media: Object.values(doc.media), tracks: Object.values(doc.tracks),
          clips: Object.values(doc.clips) },
        next: null };
    },
    'session.save': () => {
      const session = requireSession();
      session.state.checkpoint = session.head.id;
      session.save();
      return { revision: session.head.id, path: path.join(session.bundle, 'session.json') };
    },
    'media.import': (params) => {
      const file = stringParam(params, 'path', 'media.import');
      const clientImportId = stringParam(params, 'clientImportId', 'media.import');
      if (!path.isAbsolute(file)) throw new FakeError('invalid_params', 'media.import: path must be absolute');
      if (engine.importIds.has(clientImportId)) {
        const jobId = engine.importIds.get(clientImportId);
        return { jobId, kind: 'media.import', state: engine.jobs.get(jobId).state };
      }
      const jobId = `job_${engine.nextJob++}`;
      engine.importIds.set(clientImportId, jobId);
      const session = requireSession();
      let job;
      try {
        if (!fs.existsSync(file)) throw new FakeError('not_found', `no file at ${file}`);
        const wav = readWav(file);
        const doc = clone(session.head.doc);
        const existing = Object.values(doc.media).find((m) => m.contentHash === wav.contentHash);
        if (existing) {
          job = { state: 'done', result: { mediaId: existing.id, revision: session.head.id, contentHash: wav.contentHash,
            name: existing.name, frames: existing.frames, sampleRate: existing.sampleRate, channels: existing.channels,
            converted: false, existing: true } };
        } else {
          const mediaId = `med_${Object.keys(doc.media).length + 1}`;
          doc.media[mediaId] = { schema: 'siann.entity.media.v1', id: mediaId, contentHash: wav.contentHash,
            format: 'wav', channels: wav.channels, sampleRate: engine.session.head.doc.root.sampleRate,
            frames: String(wav.frames), name: path.basename(file) };
          const revision = session.commit('command', doc);
          job = { state: 'done', result: { mediaId, revision: revision.id, contentHash: wav.contentHash,
            name: path.basename(file), frames: String(wav.frames), sampleRate: wav.sampleRate, channels: wav.channels,
            converted: false } };
        }
      } catch (error) {
        job = { state: 'failed', error: { code: error.code || 'io_error', message: error.message } };
      }
      // The first job.status sees it running, the next its end.
      engine.jobs.set(jobId, { jobId, kind: 'media.import', state: 'queued', pending: job });
      return { jobId, kind: 'media.import', state: 'queued' };
    },
    'render.start': (params) => {
      const name = stringParam(params, 'name', 'render.start');
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new FakeError('invalid_params', 'render.start: bad name');
      const session = requireSession();
      const file = path.join(session.bundle, 'renders', `${name}.wav`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const header = Buffer.alloc(44 + 96);
      header.write('RIFF', 0); header.writeUInt32LE(36 + 96, 4); header.write('WAVE', 8); header.write('fmt ', 12);
      header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(2, 22);
      header.writeUInt32LE(engine.sampleRate, 24); header.writeUInt32LE(engine.sampleRate * 8, 28);
      header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34); header.write('data', 36); header.writeUInt32LE(96, 40);
      fs.writeFileSync(file, header);
      const jobId = `job_${engine.nextJob++}`;
      engine.jobs.set(jobId, { jobId, kind: 'render', state: 'queued',
        pending: { state: 'done', result: { path: file, frames: '12', sampleRate: engine.sampleRate } } });
      return { jobId, kind: 'render', state: 'queued' };
    },
    'job.status': (params) => {
      const job = engine.jobs.get(stringParam(params, 'jobId', 'job.status'));
      if (!job) throw new FakeError('not_found', `no job ${params.jobId}`);
      const { pending, ...visible } = job;
      if (job.state === 'queued') {
        job.state = 'running';
        return { ...visible, state: 'running', progress: { framesDone: '0', framesTotal: '1' } };
      }
      if (job.state === 'running') {
        Object.assign(job, pending);
        const { pending: _p, ...done } = job;
        return done;
      }
      return visible;
    },
    'plan.submit': (params) => {
      const session = requireSession();
      if (!Array.isArray(params.steps) || params.steps.length === 0) {
        throw new FakeError('invalid_params', 'plan.submit: steps must be a non-empty array');
      }
      const base = params.baseRevision ? session.revision(params.baseRevision) : session.head;
      applySteps(base.doc, params.steps);
      const plan = { schema: 'siann.plan.v1', baseRevision: base.id, steps: params.steps, readSet: [],
        writeSet: writeSetOf(base.doc, params.steps) };
      plan.hash = planHash(plan);
      plan.state = 'validated';
      if (!engine.plans.has(plan.hash)) engine.plans.set(plan.hash, plan);
      return clone(engine.plans.get(plan.hash));
    },
    'plan.approve': (params) => {
      const plan = requirePlan(params);
      if (plan.state !== 'validated') throw new FakeError('invalid_state', `the plan is ${plan.state}`);
      plan.state = 'approved';
      return clone(plan);
    },
    'plan.apply': (params) => {
      const plan = requirePlan(params);
      if (plan.state !== 'approved') throw new FakeError('invalid_state', `the plan is ${plan.state}`);
      const session = requireSession();
      const revision = session.commit('plan', applySteps(session.head.doc, plan.steps), { steps: plan.steps });
      plan.state = 'applied';
      plan.appliedRevision = revision.id;
      return { revision: envelope(revision) };
    },
    'plan.rollback': (params) => {
      const hasPlan = params.plan !== undefined;
      const hasRevision = params.revision !== undefined;
      if (hasPlan === hasRevision) {
        throw new FakeError('invalid_params', 'plan.rollback: exactly one of plan and revision');
      }
      const session = requireSession();
      const targetId = hasPlan ? requirePlan(params).appliedRevision : stringParam(params, 'revision', 'plan.rollback');
      if (!targetId) throw new FakeError('plan_not_applied', 'only an applied plan can be rolled back');
      const target = session.revision(targetId);
      if (target.cause !== 'plan') throw new FakeError('not_a_plan', `revision ${targetId} has cause ${target.cause}`);
      const doc = clone(session.head.doc);
      for (const step of target.steps) {
        if (step.op === 'clip.place') delete doc.clips[step.clipId];
        if (step.op === 'track.add') {
          delete doc.tracks[step.trackId];
          doc.root.trackOrder = doc.root.trackOrder.filter((id) => id !== step.trackId);
        }
      }
      const revision = session.commit('rollback', doc, { target: targetId });
      for (const plan of engine.plans.values()) {
        if (plan.appliedRevision === targetId) plan.state = 'rolled_back';
      }
      return { revision: envelope(revision) };
    },
  };

  async function answer(request) {
    const { requestId, method, params = {} } = request;
    engine.calls.push({ method, params, sessionId: request.sessionId });
    if (options.onRequest) options.onRequest(request, engine);
    if (request.sessionId !== engine.sessionId) {
      return { requestId, ok: false, error: { code: 'session_mismatch', message: 'unknown sessionId' } };
    }
    try {
      const handler = handlers[method] || methods[method];
      if (!handler) throw new FakeError('unknown_method', `unknown method ${method}`);
      const result = await handler(params, { engine, request, methods });
      if (result === undefined) return null;
      return { requestId, ok: true, result };
    } catch (error) {
      const out = { code: error.code || 'internal_error', message: error.message };
      if (error.extra && error.extra.step !== undefined) out.step = error.extra.step;
      if (error.extra && error.extra.data !== undefined) out.data = error.extra.data;
      return { requestId, ok: false, error: out };
    }
  }

  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"ok":false,"error":{"code":"not_found"}}');
  });
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptUpgrade(req, socket, head);
    engine.sockets.add(ws);
    let authed = false;
    ws.on('close', () => engine.sockets.delete(ws));
    ws.on('error', () => {});
    ws.on('message', async (data) => {
      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        ws.sendText(JSON.stringify({ requestId: null, ok: false, error: { code: 'bad_request', message: 'bad JSON' } }));
        return;
      }
      if (!authed) {
        if (frame.type === 'auth' && frame.token === engine.token) {
          authed = true;
          const head = engine.session ? engine.session.head : null;
          ws.sendText(JSON.stringify({ type: 'auth', ok: true, sessionId: engine.sessionId,
            revision: head ? head.id : 'r1', documentHash: head ? head.documentHash : null }));
        } else if (frame.type === 'auth') {
          ws.sendText(JSON.stringify({ type: 'auth', ok: false, error: { code: 'invalid_token' } }));
          ws.close(1008, 'invalid token');
        } else {
          ws.sendText(JSON.stringify({ requestId: frame.requestId ?? null, ok: false,
            error: { code: 'unauthenticated', message: 'authenticate first' } }));
          ws.close(1008, 'unauthenticated');
        }
        return;
      }
      const response = await answer(frame);
      if (response) ws.sendText(JSON.stringify(response));
    });
  });

  engine.server = server;
  engine.listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    engine.port = server.address().port;
    resolve(engine);
  }));
  engine.close = () => new Promise((resolve) => {
    for (const ws of engine.sockets) ws.destroy();
    server.close(() => resolve());
  });
  engine.readyLine = () => JSON.stringify({ schema: 'siann.engine.ready.v0', port: engine.port, token: engine.token,
    mcpToken: engine.mcpToken, sessionId: engine.sessionId, pid: process.pid, about: { name: 'fake-engine' } });
  engine.FakeError = FakeError;
  return engine;
}

module.exports = { FakeError, FakeSession, createFakeEngine, readWav };
