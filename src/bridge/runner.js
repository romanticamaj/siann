'use strict';

// Runs siann.command.v0 files through the native engine (m5b-bridge-native-client;
// architecture spec, "siann-protocol", "Plans", "Journal as write-ahead log").
//
// One engine process per run (src/runtime/client.js). The ops map onto
// protocol methods:
//
//   create_session   engine.status (the rate check), session.create {path, name}
//   open_session     session.open {path}
//   create_audio_track, import_audio
//                    media.import per file (followed through job.status), and
//                    the tracks and clips as steps of one plan: track.add and
//                    clip.place, submitted, approved and applied when the next
//                    other op (or the end of the file) comes
//   save_session     session.save
//   render           render.start + job.status; the render is copied to outputPath
//                    (32-bit float WAV at the session rate, unnormalised: a
//                    bitDepth other than "float32", normalize, or a sampleRate
//                    other than the session's is render_format_unsupported)
//   observe_session  session.inspect
//   rollback_plan    plan.rollback {revision} (a plan an earlier run applied)
//
// The plan's hash as the engine reports it must equal the Node hash
// (src/hash/plan-hash.js) before it is approved. The run writes a
// siann.command_journal.v1 (docs/schemas/command-journal-v1.md) to the
// command file's journalPath: the bundle, and per plan its hash, base and
// applied revisions, the stable IDs it touched (the applied revision's diff)
// and the document hashes before and after.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { EngineClient, RuntimeError, resolveEngineExe } = require('../runtime/client');
const { planHash } = require('../hash/plan-hash');
const { scriptInvocation } = require('./script-invocation');

const COMMAND_SCHEMA = 'siann.command.v0';
const JOURNAL_SCHEMA = 'siann.command_journal.v1';
const JOURNAL_V0 = 'siann.command_journal.v0';
const RESULT_SCHEMA = 'siann.result.v0';
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_RATE = 48000;
const PLAN_OPS = new Set(['create_audio_track', 'import_audio']);

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function parseJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// A manifest time ("8", "0.25", "00:02.5", "1:00:00", in seconds) as frames
// at the session rate, rounded to the nearest frame.
function framesOf(text, rate) {
  const value = String(text ?? '');
  let seconds = null;
  let m;
  if (/^\d+(\.\d+)?$/.test(value)) {
    seconds = Number(value);
  } else if ((m = /^(\d+):([0-5]\d(?:\.\d+)?)$/.exec(value))) {
    seconds = Number(m[1]) * 60 + Number(m[2]);
  } else if ((m = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/.exec(value))) {
    seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  if (seconds === null || !Number.isFinite(seconds)) {
    throw new BridgeError('invalid_time', `${JSON.stringify(text)} is not a time in seconds, mm:ss or hh:mm:ss`);
  }
  return Math.round(seconds * rate);
}

// ---- Journal ----------------------------------------------------------------

const ENTITY_REF_RE = /^[a-z_]+:[^\s:][^\s]*$/;

function validateTouchedIds(touchedIds) {
  if (!Array.isArray(touchedIds) || !touchedIds.every((ref) => typeof ref === 'string' && ENTITY_REF_RE.test(ref))) {
    throw new Error(`invalid touchedIds (an array of "<entityType>:<id>" refs): ${JSON.stringify(touchedIds)}`);
  }
}

function validateJournal(journal) {
  if (journal && journal.schemaVersion === JOURNAL_V0) {
    throw new Error(`${JOURNAL_V0} is the Ardour engine's journal (session tar snapshots); it cannot be rolled back `
      + `or read by the native bridge, which writes ${JOURNAL_SCHEMA} (docs/schemas/command-journal-v1.md)`);
  }
  if (!journal || journal.schemaVersion !== JOURNAL_SCHEMA) {
    throw new Error(`journal schemaVersion must be ${JOURNAL_SCHEMA}`);
  }
  if (!journal.journalId || typeof journal.journalId !== 'string') {
    throw new Error('journalId must be a non-empty string');
  }
  if (!Array.isArray(journal.batches)) {
    throw new Error('journal batches must be an array');
  }
  const applied = journal.batches.some((batch) => batch && batch.status === 'applied');
  if ((typeof journal.bundle !== 'string' || !journal.bundle) && (applied || journal.bundle !== null)) {
    throw new Error('journal bundle must be the session bundle path (null only when nothing was applied)');
  }
  for (const batch of journal.batches) {
    if (!['applied', 'failed', 'rolled_back'].includes(batch.status)) {
      throw new Error(`invalid batch status: ${batch.status}`);
    }
    if (!['low', 'normal', 'high'].includes(batch.risk)) {
      throw new Error(`invalid batch risk: ${batch.risk}`);
    }
    if (!Array.isArray(batch.entries)) {
      throw new Error('batch entries must be an array');
    }
    if (batch.planHash !== undefined && batch.planHash !== null && !HASH_RE.test(batch.planHash)) {
      throw new Error(`invalid planHash: ${batch.planHash}`);
    }
    if (batch.touchedIds !== undefined && batch.touchedIds !== null) validateTouchedIds(batch.touchedIds);
    for (const state of [batch.preState, batch.postState]) {
      const hash = state && state.documentHash;
      if (hash && !HASH_RE.test(hash)) throw new Error(`invalid documentHash: ${hash}`);
    }
  }
  return journal;
}

function summarizeJournal(journal, journalPath) {
  validateJournal(journal);
  const applied = journal.batches.filter((b) => b.status === 'applied');
  const last = applied.at(-1);
  return {
    path: journalPath,
    journalId: journal.journalId,
    status: journal.status,
    risk: journal.batches[0] ? journal.batches[0].risk : journal.risk,
    entryCount: journal.batches.reduce((n, b) => n + b.entries.length, 0),
    bundle: journal.bundle,
    planHash: last ? last.planHash : null,
    appliedRevision: last ? last.appliedRevision : null,
  };
}

// ---- Running ----------------------------------------------------------------

function nextId(prefix, used) {
  for (let n = 1; ; n += 1) {
    const id = `${prefix}_${n}`;
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

class Run {
  constructor(client, payload, { commandFile, baseDir }) {
    this.client = client;
    this.payload = payload;
    this.commandFile = commandFile;
    this.baseDir = baseDir;
    this.risk = payload.batchRisk || 'normal';
    this.importPrefix = `siann-bridge-${crypto.randomBytes(4).toString('hex')}`;
    this.rate = null;
    this.bundle = null;
    this.tracks = null; // [{id, name}] of the served session's head, once synced
    this.trackIds = new Set();
    this.clipIds = new Set();
    this.planned = []; // the steps waiting for the next plan
    this.batches = [];
    this.media = [];
    this.results = [];
  }

  resolvePath(value) {
    return path.isAbsolute(value) ? value : path.resolve(this.baseDir, value);
  }

  // What siann-engine cannot honour is refused before anything runs, never
  // dropped: the Ardour runner's snapshotRetention (a v1 journal holds no
  // snapshots), create_audio_track inputChannels (track.add takes channels) and
  // a render format other than the one render.start writes.
  checkSupported(commands) {
    if (this.payload.snapshotRetention !== undefined) {
      throw new BridgeError('unsupported_field', 'snapshotRetention is not supported: siann-engine keeps the session '
        + 'history in the bundle and a v1 journal holds no snapshots (remove it)');
    }
    const fileRate = (commands.find((c) => c && c.op === 'create_session') || {}).sampleRate;
    commands.forEach((command, index) => {
      try {
        if (command.op === 'create_audio_track' && command.inputChannels !== undefined) {
          throw new BridgeError('unsupported_field', 'create_audio_track inputChannels is not supported: siann-engine '
            + 'tracks take channels (outputChannels) and no input routing (remove it)');
        }
        if (command.op === 'render') {
          checkRenderFormat(command);
          if (fileRate !== undefined) checkRenderRate(command, fileRate);
        }
      } catch (error) {
        error.op = command.op;
        error.index = index;
        throw error;
      }
    });
  }

  async execute() {
    const commands = this.payload.commands;
    if (!Array.isArray(commands)) throw new BridgeError('invalid_command_file', 'commands must be an array');
    this.checkSupported(commands);
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      try {
        if (!PLAN_OPS.has(command.op)) {
          // eslint-disable-next-line no-await-in-loop
          await this.flush();
        }
        // eslint-disable-next-line no-await-in-loop
        const result = await this.run(command, index);
        this.results.push({ op: command.op, ok: true, ...result });
      } catch (error) {
        if (error.op === undefined) {
          error.op = command.op;
          error.index = index;
        }
        throw error;
      }
    }
    await this.flush();
  }

  async run(command, index) {
    switch (command.op) {
      case 'create_session': return this.createSession(command);
      case 'open_session': return this.openSession(command);
      case 'create_audio_track': return this.addTrack(command);
      case 'import_audio': return this.importAudio(command, index);
      case 'save_session': return this.client.request('session.save');
      case 'render': return this.render(command, index);
      case 'observe_session': return this.client.request('session.inspect');
      case 'rollback_plan': return this.rollbackPlan(command);
      default: throw new BridgeError('unknown_op', `unknown command op ${JSON.stringify(command.op)}`);
    }
  }

  async engineRate() {
    try {
      const status = await this.client.request('engine.status');
      return status.device && status.device.sampleRate ? status.device.sampleRate : DEFAULT_RATE;
    } catch (error) {
      // An engine without a transport port runs sessions at 48000 (session.create).
      if (error.code === 'not_supported') return DEFAULT_RATE;
      throw error;
    }
  }

  served(result, bundle) {
    this.bundle = bundle;
    this.tracks = null;
    this.trackIds.clear();
    this.clipIds.clear();
    return { bundle, sessionId: result.sessionId, revision: result.revision, documentHash: result.documentHash };
  }

  async createSession(command) {
    const rate = await this.engineRate();
    if (command.sampleRate !== undefined && command.sampleRate !== rate) {
      throw new BridgeError('sample_rate_mismatch', `create_session asks for ${command.sampleRate} Hz; siann-engine `
        + `runs the session at the device rate, ${rate} Hz (select a device at ${command.sampleRate} Hz, or `
        + `set the manifest's sampleRate to ${rate})`);
    }
    const bundle = this.resolvePath(command.sessionDir);
    // session.create wants the parent to exist; the bundle itself must not.
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    const params = { path: bundle };
    if (command.sessionName) params.name = command.sessionName;
    const created = await this.client.request('session.create', params);
    this.rate = rate;
    return this.served(created, bundle);
  }

  async openSession(command) {
    const bundle = this.resolvePath(command.sessionDir);
    const opened = await this.client.request('session.open', { path: bundle });
    this.rate = null;
    return this.served(opened, bundle);
  }

  // The served head's tracks and ids (session.sync, every chunk), once per session.
  async sync() {
    if (this.tracks) return;
    const tracks = [];
    let cursor = null;
    let first = true;
    while (first || cursor) {
      // eslint-disable-next-line no-await-in-loop
      const sync = await this.client.request('session.sync', cursor ? { cursor } : {});
      first = false;
      const { chunk } = sync;
      if (chunk.root && this.rate === null) this.rate = chunk.root.sampleRate;
      for (const track of chunk.tracks || []) {
        tracks.push({ id: track.id, name: track.name });
        this.trackIds.add(track.id);
      }
      for (const clip of chunk.clips || []) this.clipIds.add(clip.id);
      cursor = sync.next;
    }
    if (this.rate === null) this.rate = DEFAULT_RATE;
    this.tracks = tracks;
  }

  async addTrack(command) {
    if (!this.bundle) throw new BridgeError('no_session', 'create_audio_track before create_session or open_session');
    await this.sync();
    const count = command.count || 1;
    const channels = command.channels ?? (command.outputChannels === 1 ? 1 : 2);
    const trackIds = [];
    for (let k = 1; k <= count; k += 1) {
      const trackId = nextId('trk', this.trackIds);
      const name = count > 1 ? `${command.name} ${k}` : command.name;
      this.planned.push({ step: { op: 'track.add', trackId, name, channels }, meta: { name } });
      trackIds.push(trackId);
    }
    return { trackIds };
  }

  // The track a placement names: a track this file adds, else one the head
  // holds. A name that matches more than one track is refused (commands target
  // stable ids; architecture spec).
  trackFor(name) {
    const planned = this.planned.filter((p) => p.step.op === 'track.add' && p.meta.name === name);
    const existing = this.tracks.filter((t) => t.name === name);
    const matches = [...planned.map((p) => p.step.trackId), ...existing.map((t) => t.id)];
    if (matches.length === 0) {
      throw new BridgeError('unknown_track', `no track named ${JSON.stringify(name)} in the session or this file`);
    }
    if (matches.length > 1) {
      throw new BridgeError('ambiguous_track', `${matches.length} tracks are named ${JSON.stringify(name)}`);
    }
    return matches[0];
  }

  async importAudio(command, index) {
    if (!this.bundle) throw new BridgeError('no_session', 'import_audio before create_session or open_session');
    await this.sync();
    const trackId = this.trackFor(command.trackName);
    const position = framesOf(command.start, this.rate);
    const sourceStart = framesOf(command.sourceStart ?? '0', this.rate);
    const file = this.resolvePath(command.path);
    const job = await this.client.request('media.import', { path: file, clientImportId: `${this.importPrefix}-${index}` });
    const done = await this.client.waitJob(job.jobId);
    const media = done.result;
    this.media.push({ path: file, mediaId: media.mediaId, revision: media.revision, contentHash: media.contentHash,
      frames: media.frames, existing: Boolean(media.existing) });
    const available = Number(media.frames) - sourceStart;
    if (available <= 0) {
      throw new BridgeError('invalid_placement', `sourceStart ${command.sourceStart} is past the end of ${file}`);
    }
    const length = command.duration !== undefined ? Math.min(framesOf(command.duration, this.rate), available) : available;
    if (length <= 0) throw new BridgeError('invalid_placement', `duration ${command.duration} is empty`);
    const clipId = nextId('clp', this.clipIds);
    this.planned.push({
      step: { op: 'clip.place', clipId, trackId, mediaId: media.mediaId,
        position: { domain: 'audio', value: String(position) }, sourceStart: String(sourceStart),
        length: String(length) },
      meta: { path: file, regionName: command.regionName },
    });
    return { mediaId: media.mediaId, clipId, trackId };
  }

  // Submits, approves and applies the planned steps as one plan.
  async flush() {
    if (this.planned.length === 0) return;
    const planned = this.planned;
    this.planned = [];
    const batch = {
      batchId: `batch_${String(this.batches.length + 1).padStart(4, '0')}`,
      status: 'failed',
      risk: this.risk,
      planHash: null,
      baseRevision: null,
      appliedRevision: null,
      touchedIds: null,
      preState: null,
      postState: null,
      entries: planned.map(({ step, meta }, k) => ({
        entryId: `entry_${String(k + 1).padStart(4, '0')}`, op: step.op, status: 'planned', command: step, ...meta,
      })),
    };
    this.batches.push(batch);
    const pre = await this.client.request('session.inspect');
    batch.preState = { revision: pre.revision, documentHash: pre.documentHash };
    const plan = await this.client.request('plan.submit', { steps: planned.map((p) => p.step) });
    batch.planHash = plan.hash;
    batch.baseRevision = plan.baseRevision;
    let nodeHash;
    try {
      nodeHash = planHash(plan);
    } catch (error) {
      throw new BridgeError('plan_hash_mismatch', `the engine's plan is not a siann.plan.v1 the bridge can hash: ${error.message}`);
    }
    if (nodeHash !== plan.hash) {
      throw new BridgeError('plan_hash_mismatch', `the engine reports plan hash ${plan.hash}; the Node hash of the `
        + `same plan is ${nodeHash}`);
    }
    await this.client.request('plan.approve', { plan: plan.hash });
    const applied = await this.client.request('plan.apply', { plan: plan.hash });
    batch.appliedRevision = applied.revision.id;
    // The engine-assigned stable IDs the plan touched (ADR-0011): the applied
    // revision's diff against its parent, "<entityType>:<id>" as the engine sent it.
    batch.touchedIds = applied.revision.diff;
    const post = await this.client.request('session.inspect');
    batch.postState = { revision: post.revision, documentHash: post.documentHash };
    batch.status = 'applied';
    for (const entry of batch.entries) entry.status = 'applied';
    for (const { step, meta } of planned) {
      if (step.op === 'track.add') this.tracks.push({ id: step.trackId, name: meta.name });
    }
  }

  async render(command, index) {
    if (command.sampleRate !== undefined) {
      if (this.rate === null) await this.sync();
      checkRenderRate(command, this.rate);
    }
    const name = `siann-bridge-${index + 1}`;
    const job = await this.client.request('render.start', { name });
    const done = await this.client.waitJob(job.jobId);
    const renderPath = done.result.path;
    const out = { renderPath };
    if (command.outputPath) {
      const outputPath = this.resolvePath(command.outputPath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.copyFileSync(renderPath, outputPath);
      out.outputPath = outputPath;
    }
    return out;
  }

  async rollbackPlan(command) {
    if (typeof command.revision !== 'string') {
      throw new BridgeError('invalid_command_file', 'rollback_plan needs the applied revision id');
    }
    const rolled = await this.client.request('plan.rollback', { revision: command.revision });
    return { target: command.revision, revision: rolled.revision.id, documentHash: rolled.revision.documentHash };
  }

  journal(journalId, error) {
    const journal = {
      schemaVersion: JOURNAL_SCHEMA,
      journalId,
      status: error ? 'failed' : 'applied',
      risk: this.risk,
      commandFile: this.commandFile,
      bundle: this.bundle || null,
      batches: this.batches,
      media: this.media,
    };
    if (error) journal.error = errorJson(error);
    return journal;
  }
}

// render.start {name, start?, frames?} writes 32-bit float WAV, unnormalised
// (architecture spec, Jobs v0); "float32" and false state that and pass.
function checkRenderFormat(command) {
  if (command.bitDepth !== undefined && command.bitDepth !== 'float32') {
    throw new BridgeError('render_format_unsupported', `render bitDepth ${JSON.stringify(command.bitDepth)} is not `
      + 'a format siann-engine renders: it writes 32-bit float WAV (omit bitDepth, or set "float32")');
  }
  if (command.normalize !== undefined && command.normalize !== false) {
    throw new BridgeError('render_format_unsupported', 'render normalize is not supported: siann-engine renders '
      + 'unnormalised (omit normalize)');
  }
}

function checkRenderRate(command, rate) {
  if (command.sampleRate !== undefined && command.sampleRate !== rate) {
    throw new BridgeError('render_format_unsupported', `render asks for ${command.sampleRate} Hz; siann-engine `
      + `renders at the session rate, ${rate} Hz (omit sampleRate)`);
  }
}

function errorJson(error) {
  const out = { code: error.code || 'internal_error', message: error.message };
  if (error.op !== undefined) out.op = error.op;
  if (error.index !== undefined) out.index = error.index;
  if (error.step !== undefined) out.step = error.step;
  if (error.data !== undefined) out.data = error.data;
  return out;
}

// The client for a run: the given one, or siann-engine (SIANN_ENGINE_EXE, else
// the core preset's build), or with `runner` a fake engine script (tests).
function clientFor(options) {
  if (options.client) return { client: options.client, owned: false };
  const engineArgs = options.device ? ['--device', options.device] : [];
  if (options.runner) {
    const invocation = scriptInvocation(options.runner);
    return { client: new EngineClient({ exe: invocation.command, prefixArgs: invocation.args, args: engineArgs,
      env: options.env }), owned: true };
  }
  return { client: new EngineClient({ exe: options.exe || resolveEngineExe(), args: engineArgs, env: options.env }),
    owned: true };
}

// Runs a command payload; returns {ok, results, journal, journalPath, error}.
async function runCommands(payload, options = {}) {
  const baseDir = options.baseDir || process.cwd();
  if (payload.schemaVersion !== undefined && payload.schemaVersion !== COMMAND_SCHEMA) {
    throw new Error(`command file schemaVersion must be ${COMMAND_SCHEMA}`);
  }
  const journalPath = payload.journalPath ? path.resolve(baseDir, payload.journalPath) : null;
  let client;
  let owned = false;
  let run = null;
  let failure = null;
  try {
    ({ client, owned } = clientFor(options));
    run = new Run(client, payload, { commandFile: options.commandFile || null, baseDir });
    if (!client.ready) await client.start();
    await run.execute();
  } catch (error) {
    if (!(error instanceof BridgeError) && !(error instanceof RuntimeError)) {
      if (!error.code) error.code = 'internal_error';
    }
    failure = error;
  } finally {
    if (owned && client) await client.stop();
  }
  const out = { ok: failure === null, results: run ? run.results : [], journalPath };
  if (failure) out.error = errorJson(failure);
  if (journalPath && run) {
    const journalId = path.basename(journalPath, path.extname(journalPath));
    out.journal = run.journal(journalId, failure);
    writeJson(journalPath, out.journal);
  }
  out.run = run;
  return out;
}

async function runCommandFile(commandFile, options = {}) {
  const absoluteCommandFile = path.resolve(commandFile);
  const payload = parseJsonFile(absoluteCommandFile);
  const outcome = await runCommands(payload, {
    ...options,
    commandFile: absoluteCommandFile,
    baseDir: path.dirname(absoluteCommandFile),
  });
  const summary = {
    ok: outcome.ok,
    status: outcome.ok ? 0 : 1,
    commandFile: absoluteCommandFile,
    result: { schemaVersion: RESULT_SCHEMA, results: outcome.results },
  };
  if (outcome.journal) summary.journal = summarizeJournal(outcome.journal, outcome.journalPath);
  if (outcome.error) summary.error = outcome.error;
  return summary;
}

module.exports = {
  BridgeError,
  JOURNAL_SCHEMA,
  framesOf,
  runCommandFile,
  runCommands,
  summarizeJournal,
  validateJournal,
};
