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

test('the engine.status plugins[] prose says what midiOutputSysex counts in each format', () => {
  const prose = statusSection().replace(/```json[\s\S]*?```/, '');
  assert.match(prose, /`midiOutputSysex`/);
  assert.match(prose, /CLAP_EVENT_MIDI_SYSEX/);
  assert.match(prose, /Amendment 3/);
});
