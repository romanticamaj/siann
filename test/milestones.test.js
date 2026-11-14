'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, '.claude', 'milestones');
const WORKFLOW = path.join(ROOT, '.claude', 'workflows', 'siann-milestone.js');
const SPEC = path.join(ROOT, 'docs', 'superpowers', 'specs', '2026-10-14-siann-native-daw-architecture.md');
const EXPECTED = ['M0', 'M2', 'M3', 'M4', 'M5', 'M5b', 'M6a', 'M6b', 'M6c', 'M7'];
const STATUSES = new Set(['not_started', 'in_progress', 'exit_pending', 'done']);

function load(id) {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
}

test('every milestone has a manifest named after its id', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(files, [...EXPECTED].sort());
  for (const id of EXPECTED) assert.equal(load(id).id, id);
});

test('manifests follow siann.milestone.v1', () => {
  for (const id of EXPECTED) {
    const m = load(id);
    assert.equal(m.schemaVersion, 'siann.milestone.v1', id);
    for (const key of ['title', 'goal']) assert.ok(typeof m[key] === 'string' && m[key].length > 0, `${id}.${key}`);
    assert.ok(STATUSES.has(m.status), `${id}.status ${m.status}`);
    for (const key of ['specSections', 'done', 'prerequisites', 'humanGates', 'features', 'exit']) {
      assert.ok(Array.isArray(m[key]), `${id}.${key} is an array`);
    }
    assert.ok(m.features.length > 0, `${id} has features`);
    assert.ok(m.exit.length > 0, `${id} has exit criteria`);
    for (const gate of m.humanGates) {
      assert.ok(gate.id && gate.text && gate.how, `${id} human gate ${gate.id}`);
    }
    for (const e of m.exit) assert.ok(e.id && e.text && e.how, `${id} exit ${e.id}`);
  }
});

test('feature ids are unique and dependencies point to earlier waves', () => {
  const seen = new Set();
  for (const id of EXPECTED) {
    const m = load(id);
    const wave = new Map(m.features.map((f) => [f.id, f.wave]));
    for (const f of m.features) {
      assert.ok(!seen.has(f.id), `duplicate feature id ${f.id}`);
      seen.add(f.id);
      assert.ok(f.id.startsWith(`${id.toLowerCase()}-`), `${f.id} is prefixed with ${id.toLowerCase()}-`);
      assert.ok(Number.isInteger(f.wave) && f.wave >= 1, `${f.id}.wave`);
      assert.ok(Array.isArray(f.acceptance) && f.acceptance.length > 0, `${f.id} has acceptance`);
      assert.ok(Array.isArray(f.specRefs) && f.specRefs.length > 0, `${f.id} has specRefs`);
      for (const dep of f.dependsOn) {
        assert.ok(wave.has(dep), `${f.id} depends on unknown ${dep}`);
        assert.ok(wave.get(dep) < f.wave, `${f.id} (wave ${f.wave}) depends on ${dep} (wave ${wave.get(dep)})`);
      }
    }
  }
});

// A ref 'UI redesign: <heading>' names a heading of the UI redesign spec: the heading
// itself or its number ('3.2'); a trailing ' (...)' names a ticket within it.
const UI_SPEC = path.join(ROOT, 'docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
const headingsOf = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/)
  .filter((line) => /^#{1,6} /.test(line))
  .map((line) => line.replace(/^#{1,6} /, '').trim());
const uiHeadings = headingsOf(UI_SPEC);
const inUiSpec = (ref) => {
  const name = ref.replace(/ \([^)]*\)$/, '');
  return uiHeadings.some((h) => h === name || h.startsWith(name + ' '));
};

test('spec references name headings that exist in the architecture or UI redesign spec', () => {
  const headings = new Set(headingsOf(SPEC));
  const missing = [];
  for (const id of EXPECTED) {
    const m = load(id);
    const refs = [...m.specSections, ...m.features.flatMap((f) => f.specRefs)];
    for (const ref of refs) {
      const ok = ref.startsWith('UI redesign: ') ? inUiSpec(ref.slice('UI redesign: '.length)) : headings.has(ref);
      if (!ok) missing.push(`${id}: ${ref}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the milestone workflow parses and declares every phase it uses', () => {
  const source = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(source, /^export const meta = \{/);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  // Parse only: the body runs inside the workflow runtime, which supplies these globals.
  assert.doesNotThrow(() => new AsyncFunction(
    'agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow',
    source.replace(/^export const meta/, 'const meta'),
  ));
  const declared = [...source.matchAll(/\{ title: '([^']+)'/g)].map((m) => m[1]);
  const used = new Set([
    ...[...source.matchAll(/phase\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/phase: '([^']+)'/g)].map((m) => m[1]),
  ]);
  for (const title of used) assert.ok(declared.includes(title), `phase ${title} is declared in meta`);
  assert.doesNotMatch(source, /Date\.now\(|Math\.random\(|new Date\(\)/);
});

test('the workflow and runbook point at files that exist', () => {
  for (const rel of ['docs/harness/agent-rules.md', 'docs/harness/runbook.md', 'scripts/check-all.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  }
});
