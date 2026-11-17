#!/usr/bin/env node
'use strict';

// Writes the seed corpus of the fuzz targets (native/fuzz/corpus/<target>/,
// m5b-nightly-quality): real requests as the protocol tests send them, the
// meter frames of fixtures/protocol/meter-frames.json, and the plans and
// commands of fixtures/plan/plan-hash.json. The files are committed (and
// binary in .gitattributes, so the bytes are the same on every OS); the
// libFuzzer runs add to the corpus only in their own working copy. Run it again
// after a fixture changes: `node scripts/generate-fuzz-corpus.js`.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORPUS = path.join(ROOT, 'native', 'fuzz', 'corpus');

const json = (value) => JSON.stringify(value);
// A protocol request; the harness replaces $session with the server's session id.
let nextId = 0;
const request = (method, params = {}) => json({ method, params, requestId: `req_${++nextId}`, sessionId: '$session' });
const rpc = (id, method, params = {}) => json({ id, jsonrpc: '2.0', method, params });
const tool = (id, name, args = {}) => rpc(id, 'tools/call', { arguments: args, name });

const trackAdd = (id) => ({ channels: 2, name: id, op: 'track.add', trackId: id });
const mediaAdd = (id) => ({
  channels: 2, contentHash: `sha256:${'a'.repeat(64)}`, format: 'wav', frames: '480000', mediaId: id, op: 'media.add',
  sampleRate: 48000,
});
const clipPlace = (id, track, media, at) => ({
  clipId: id, length: '48000', mediaId: media, op: 'clip.place', position: { domain: 'audio', value: String(at) },
  sourceStart: '0', trackId: track,
});

function protocolWs() {
  const meter = require(path.join(ROOT, 'fixtures', 'protocol', 'meter-frames.json'));
  const out = {
    'auth-bad-token': json({ token: '0'.repeat(64), type: 'auth' }),
    'engine-capabilities': request('engine.capabilities'),
    'engine-about': request('engine.about'),
    'session-inspect': request('session.inspect'),
    'session-sync': request('session.sync'),
    'command-list': request('command.list'),
    'command-execute': request('command.execute', { commands: [trackAdd('trk_fz')] }),
    'plan-list': request('plan.list'),
    'transport-play': request('transport.play'),
    'gesture-begin': request('gesture.begin', { target: { trackId: 'trk_fz', param: 'gain' } }),
    // A sequence: commit, undo, redo, fetch.
    'sequence-edit': [
      request('command.execute', { commands: [trackAdd('trk_seq'), mediaAdd('med_seq'), clipPlace('clp_seq', 'trk_seq', 'med_seq', 0)] }),
      request('session.undo'),
      request('session.redo'),
      request('session.fetch', { entities: [{ id: 'trk_seq', type: 'track' }] }),
    ].join('\n'),
    'unknown-method': request('no.such_method'),
    'missing-request-id': json({ method: 'engine.capabilities', params: {}, sessionId: '$session' }),
  };
  meter.meterFrames.forEach((frame, i) => {
    out[`meter-frame-${i}`] = Buffer.from(frame.hex, 'hex');
  });
  return out;
}

function mcpHttp() {
  return {
    initialize: rpc(1, 'initialize', { capabilities: {}, clientInfo: { name: 'seed', version: '1' }, protocolVersion: '2025-06-18' }),
    'notifications-initialized': json({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    'tools-list': rpc(2, 'tools/list'),
    'list-commands': tool(3, 'list_commands'),
    'describe-capabilities': tool(4, 'describe_capabilities'),
    'inspect-session': tool(5, 'inspect_session'),
    execute: tool(6, 'execute', { commands: [trackAdd('trk_mcp')] }),
    'plan-status': tool(7, 'plan_status', { plan: `sha256:${'0'.repeat(64)}` }),
    'engine-status': tool(8, 'engine_status'),
    'unknown-tool': tool(9, 'no_such_tool'),
    'bad-jsonrpc': json({ id: 10, jsonrpc: '1.0', method: 'tools/list' }),
    ping: rpc(11, 'ping'),
  };
}

function commandJson() {
  const plans = require(path.join(ROOT, 'fixtures', 'plan', 'plan-hash.json'));
  const out = {
    'track-add': json(trackAdd('trk_b')),
    'media-add': json(mediaAdd('med_b')),
    'clip-place': json(clipPlace('clp_b', 'trk_a', 'med_a', 48000)),
    'clip-remove': json({ clipId: 'clp_a', op: 'clip.remove' }),
    'track-set-gain': json({ gainMilliDb: -6000, op: 'track.set_gain', trackId: 'trk_a' }),
    transaction: json({ commands: [trackAdd('trk_c'), clipPlace('clp_c', 'trk_c', 'med_a', 0)] }),
    'transaction-array': json([trackAdd('trk_d'), { op: 'track.remove', trackId: 'trk_d' }]),
  };
  plans.valid.slice(0, 6).forEach((entry, i) => {
    out[`plan-valid-${i}`] = json(entry.plan);
  });
  plans.invalid.slice(0, 6).forEach((entry, i) => {
    out[`plan-invalid-${i}`] = entry.planText;
  });
  return out;
}

function write(target, files) {
  const dir = path.join(CORPUS, target);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return Object.keys(files).length;
}

if (require.main === module) {
  for (const [target, files] of [['protocol_ws', protocolWs()], ['mcp_http', mcpHttp()], ['command_json', commandJson()]]) {
    console.log(`${target}: ${write(target, files)} files`);
  }
}

module.exports = { protocolWs, mcpHttp, commandJson };
