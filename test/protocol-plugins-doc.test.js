'use strict';

// m4-juce-formats, acceptance 3 (ADR-0018, Amendment 3; Protocol v0 item 18):
// midiOutputSysex is reported beside midiOutputOverflows in engine.status
// plugins[] and documented in docs/schemas/protocol-plugins-v0.md. The native
// tests prove the field; this keeps the schema document saying so.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DOC = path.join(__dirname, '..', 'docs', 'schemas', 'protocol-plugins-v0.md');

function statusSection() {
  const text = fs.readFileSync(DOC, 'utf8');
  const start = text.indexOf('## engine.status plugins[]');
  assert.ok(start >= 0, 'the document has an engine.status plugins[] section');
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? text.length : end);
}

test('the engine.status plugins[] example carries midiOutputSysex beside midiOutputOverflows', () => {
  const section = statusSection();
  const example = /```json\r?\n([\s\S]*?)```/.exec(section);
  assert.ok(example, 'the section has a JSON example');
  assert.match(example[1], /"midiOutputOverflows": "\d+", "midiOutputSysex": "\d+"/);
});

// m5-plugin-registry (Protocol v0 item 21): the registry methods, their stable
// codes, and that neither is an MCP tool. The native tests prove the behaviour.
function section(heading) {
  const text = fs.readFileSync(DOC, 'utf8');
  const start = text.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `the document has a ${heading} section`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? text.length : end);
}

test('the plugin.registry, plugin.approve section names the codes and keeps them off MCP', () => {
  const prose = section('plugin.registry, plugin.approve');
  for (const word of ['plugin_not_registered', 'plugin_not_approved', 'not an MCP tool', 'unc_path', 'inside_bundle',
    'unregistered_path', '--plugin-dir', '--plugin-registry']) {
    assert.ok(prose.includes(word), `the section mentions ${word}`);
  }
  const example = /```json\r?\n([\s\S]*?)```/.exec(prose);
  assert.ok(example, 'the section has a JSON example');
  for (const field of ['"format"', '"path"', '"uid"', '"name"', '"approved"']) {
    assert.ok(example[1].includes(field), `the example carries ${field}`);
  }
});

test('the plugin.registry section stands before the editor methods in the document', () => {
  const text = fs.readFileSync(DOC, 'utf8');
  assert.ok(text.indexOf('## plugin.registry, plugin.approve') < text.indexOf('## plugin.open_editor'));
});

test('the engine.status plugins[] prose says what midiOutputSysex counts in each format', () => {
  const prose = statusSection().replace(/```json[\s\S]*?```/, '');
  assert.match(prose, /`midiOutputSysex`/);
  assert.match(prose, /CLAP_EVENT_MIDI_SYSEX/);
  assert.match(prose, /Amendment 3/);
});

// Fix round 1 of m5-plugin-registry: the spec's Jobs v0 paragraph for
// plugin.instantiate says what the engine host does since the registry: no probe
// of its own, and the registry's codes before any plugin host is reached.
const SPEC = path.join(__dirname, '..', 'docs', 'superpowers', 'specs', '2026-10-14-siann-native-daw-architecture.md');

test('the spec\'s Jobs v0, plugins paragraph names the registry codes of plugin.instantiate', () => {
  const text = fs.readFileSync(SPEC, 'utf8');
  const start = text.indexOf('Jobs v0, plugins (m4-plugin-node');
  assert.ok(start >= 0, 'the spec has the Jobs v0, plugins paragraph');
  const end = text.indexOf('\n- Slot ids', start);
  const item = text.slice(start, end < 0 ? text.length : end);
  for (const word of ['plugin_not_registered', 'plugin_not_approved', 'plugin_not_found', 'registry',
    'unregistered_path']) {
    assert.ok(item.includes(word), `the paragraph mentions ${word}`);
  }
  assert.ok(!item.includes('probes and instantiates'), 'plugin.instantiate no longer probes');
  assert.ok(!item.includes('`not_found`'), 'the PluginError code is plugin_not_found');
});
