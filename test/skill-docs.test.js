const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('siann-intake skill defines the AI-to-deterministic bridge workflow', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', '.codex', 'skills', 'siann-intake', 'SKILL.md'), 'utf8');

  assert.match(skill, /siann\.import_pack\.v0/);
  assert.match(skill, /node bin\/siann\.js export dawproject/);
  assert.match(skill, /unzip -t/);
  assert.match(skill, /needsReview/);
  assert.match(skill, /Fixed layouts such as `_DAW\/` and `_SpliceSFX\/` are examples, not\s+requirements\./);
  assert.match(skill, /Do not directly\s+mutate engine\/session files\./);
});

test('claude skill points to the canonical siann-intake skill', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', '.claude', 'skills', 'siann-intake', 'SKILL.md'), 'utf8');

  assert.match(skill, /\.codex\/skills\/siann-intake\/SKILL\.md/);
  assert.match(skill, /AI planner owns arbitrary input/);
});

// m5b-bridge-native-client: the bridge finds the native siann-engine itself
// (SIANN_ENGINE_EXE, else the core preset's build); no skill names the removed
// Ardour-era option or the sibling checkout.
test('the committed intake skills no longer name --engine-dir or the sibling checkout', () => {
  for (const dir of ['.codex', '.claude']) {
    const skill = fs.readFileSync(path.join(__dirname, '..', dir, 'skills', 'siann-intake', 'SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /engine-dir|SIANN_ENGINE_DIR|\.\.\/siann-engine/, dir);
  }
});

// m5b-bridge-native-client acceptance item 6: the contributor and product docs
// say how the bridge finds the native siann-engine, and no live mention still
// describes the engine as a separate (Ardour-derived) checkout or the result as
// an Ardour session. Historical links (ADR titles, research notes) are not
// mentions of how the engine is found and stay.
const STALE_ENGINE_MENTION = new RegExp([
  String.raw`engine checkout`,
  String.raw`siann-engine\x60? checkout`,
  String.raw`\.\./siann-engine`,
  String.raw`/Users/garyhsieh/siann-engine`,
  String.raw`SIANN_ENGINE_DIR`,
  String.raw`--engine-dir`,
  String.raw`\bin Ardour\b`,
  String.raw`Ardour session`,
  String.raw`Ardour-compatible`,
  String.raw`Ardour compatibility`,
].join('|'), 'i');

const ENGINE_DOCS = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'docs/README.md',
  'docs/setup/windows.md',
  'examples/bridge/README.md',
  'examples/import-pack/README.md',
];

test('the contributor and product docs no longer describe the engine as a sibling checkout or an Ardour session', () => {
  for (const rel of ENGINE_DOCS) {
    // Join wrapped lines so a phrase split across a line break is still found.
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\s+/g, ' ');
    const match = text.match(STALE_ENGINE_MENTION);
    assert.equal(match, null, `${rel}: stale engine mention "${match && match[0]}"`);
  }
});

test('README.md, AGENTS.md, CLAUDE.md and docs/setup/windows.md say how the bridge finds siann-engine', () => {
  for (const rel of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/setup/windows.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.match(text, /SIANN_ENGINE_EXE/, rel);
  }
  for (const rel of ['README.md', 'CLAUDE.md', 'docs/setup/windows.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.match(text, /native[\\/]build[\\/]dev[\\/]apps[\\/]engine[\\/]siann-engine/, rel);
  }
});

