'use strict';

// The mockup fidelity gate's bookkeeping (docs/harness/agent-rules.md, "UI
// fidelity"; UI redesign spec, section 10): the manifest that owns every part
// of the mockup, the milestone features whose acceptance carries the gate,
// and the places that run it (check-all, CI, the workflow's prompts, the
// rules). The gate itself is app/test/e2e/mockup-fidelity.spec.ts; the token
// layer is test/ui-tokens.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stepsForPaths, fidelityEnforced } = require('../scripts/check-all');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const MANIFEST = JSON.parse(read('app', 'test', 'fidelity', 'manifest.json'));
const MOCKUP = read(...MANIFEST.mockup.split('/'));
const milestone = (id) => JSON.parse(read('.claude', 'milestones', `${id}.json`));
// The milestones that own parts of the mockup: M5 built the window, M5b is the
// usable release, and M6a owns the automation parts (maintainer, 2026-11-15).
const OWNERS = ['M5', 'M5b', 'M6a'];
const FEATURES = new Map(OWNERS.flatMap((id) => milestone(id).features.map((f) => [f.id, { ...f, milestone: id }])));
const DONE = new Set(OWNERS.flatMap((id) => milestone(id).done));
// M5's parts answer to the alignment feature of their region; the closing
// feature ends the alignment and empties the debt ledger.
const ALIGNMENT = ['m5-ui-alignment-chrome', 'm5-ui-alignment-arrange', 'm5-ui-alignment-mixer-inspector', 'm5-ui-alignment-plans'];
const CLOSING = 'm5-ui-mockup-alignment';
const REGION_GATES = {
  'top-bar': 'm5-ui-alignment-chrome',
  'status-bar': 'm5-ui-alignment-chrome',
  'project-zone': 'm5-ui-alignment-arrange',
  'left-zone': 'm5-ui-alignment-mixer-inspector',
  'lower-zone': 'm5-ui-alignment-mixer-inspector',
  'right-zone': 'm5-ui-alignment-plans',
};

const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const ruleOf = (id) => MANIFEST.rules.find((rule) => rule.match.some((pattern) => glob(pattern).test(id)));

// The ids the mockup's markup names outright; ids built per track, strip or
// step are checked by the gate's run, which fails on a part no rule owns.
function literalIds() {
  const ids = new Set();
  for (const m of MOCKUP.matchAll(/\$\{d[pr]\('([a-z0-9-]+)'\)\}/g)) ids.add(m[1]);
  for (const m of MOCKUP.matchAll(/fp\('([a-z0-9-]+)',/g)) ids.add(m[1]);
  return [...ids];
}

test('the manifest is a siann.fidelity.v1 document for the mockup at 1440x900, scale 1', () => {
  assert.equal(MANIFEST.schemaVersion, 'siann.fidelity.v1');
  assert.ok(fs.existsSync(path.join(ROOT, MANIFEST.mockup)), MANIFEST.mockup);
  assert.deepEqual(MANIFEST.viewport, { width: 1440, height: 900, deviceScaleFactor: 1 });
  assert.deepEqual(Object.keys(MANIFEST.locales), ['en', 'zh-TW']);
  assert.equal(MANIFEST.locales['zh-TW'].query, '?lang=zh-TW');
  // The strict layer: one pixel, identical styles; the pixel layer's limits.
  assert.equal(MANIFEST.geometry.tolerancePx, 1);
  assert.ok(MANIFEST.styles.length >= 25, 'the computed styles compared');
  assert.ok(MANIFEST.pixels.maxMismatch <= 0.005, 'at most 0.5 % of a region');
  assert.ok(MANIFEST.pixels.channelTolerance <= 16);
});

test('every id the mockup names is owned by a rule, and the regions are marked', () => {
  const ids = literalIds();
  assert.ok(ids.length > 100, `${ids.length} ids named in the mockup`);
  assert.deepEqual(ids.filter((id) => !ruleOf(id)), [], 'ids no manifest rule owns');
  for (const region of MANIFEST.regions) {
    assert.ok(MOCKUP.includes(`\${dr('${region}')}`), `the mockup marks the region ${region}`);
    assert.ok(ruleOf(region), `a rule owns the region ${region}`);
  }
  // Ids built per item: one of each kind resolves too.
  for (const id of ['track-3', 'track-3-mute', 'track-ghost-name', 'strip-2-cap', 'strip-6-cap-ghost', 'strip-master-meter', 'plan-step-4', 'lane-7', 'clip-12', 'tool-3', 'inspector-sends']) {
    assert.ok(ruleOf(id), id);
  }
});

test('every rule names its feature and a gate with a mode, and no part is unowned', () => {
  const modes = new Set(['pending', 'report', 'enforce']);
  for (const [gate, mode] of Object.entries(MANIFEST.gates)) {
    assert.ok(FEATURES.has(gate), `gate ${gate} is a feature of ${OWNERS.join(', ')}`);
    assert.ok(modes.has(mode), `${gate}: ${mode}`);
  }
  for (const rule of MANIFEST.rules) {
    assert.ok(Array.isArray(rule.match) && rule.match.length > 0, JSON.stringify(rule));
    // Decided by the maintainer, 2026-11-15: every part has an owner.
    assert.ok(rule.feature && rule.gate && !('unowned' in rule), `no part is unowned: ${rule.match.join(', ')}`);
    assert.ok(FEATURES.has(rule.feature) || DONE.has(rule.feature), `${rule.feature} is a feature of ${OWNERS.join(', ')}`);
    assert.ok(rule.gate in MANIFEST.gates, `${rule.gate} has a mode in manifest.gates`);
    // M5's parts answer to the alignment feature of their region; a later feature answers for its own.
    if (rule.feature.startsWith('m5-')) assert.ok(ALIGNMENT.includes(rule.gate), `${rule.match.join(', ')}: ${rule.gate}`);
    else assert.equal(rule.gate, rule.feature, rule.match.join(', '));
  }
  for (const gate of Object.keys(MANIFEST.gates)) assert.ok(MANIFEST.rules.some((rule) => rule.gate === gate), `${gate} owns no part`);
  for (const gate of ALIGNMENT) assert.ok(gate in MANIFEST.gates, `${gate} has a mode`);
  // A region's pixels answer to the alignment feature that ports it.
  assert.deepEqual(Object.keys(REGION_GATES).sort(), [...MANIFEST.regions].sort());
  for (const [region, gate] of Object.entries(REGION_GATES)) assert.equal(ruleOf(region).gate, gate, region);
});

test('a feature that owns parts carries the gate in its acceptance, and a landed one enforces it', () => {
  for (const [gate, mode] of Object.entries(MANIFEST.gates)) {
    const feature = FEATURES.get(gate);
    assert.ok(feature.acceptance.some((line) => /fidelity gate|mockup-fidelity\.spec/.test(line)), `${gate}: an acceptance line names the fidelity gate`);
    assert.ok(feature.acceptance.some((line) => line.includes(`gate ${gate})`) || line.includes(`gate is ${gate} `)), `${gate}: its acceptance names its own gate`);
    if (DONE.has(gate)) assert.equal(mode, 'enforce', `${gate} is done: its gate is enforce`);
  }
});

test('the alignment is split by region after the token conversion, and one feature closes it', () => {
  const wave = (id) => FEATURES.get(id).wave;
  const tokens = FEATURES.get('m5-ui-tokens-spacing');
  assert.equal(tokens.milestone, 'M5');
  assert.match(tokens.acceptance.join('\n'), /no allowlist/);
  assert.match(tokens.acceptance.join('\n'), /No visual change to the mockup, proven by the gate's own measurement/);
  for (const id of ALIGNMENT) {
    const feature = FEATURES.get(id);
    assert.equal(feature.milestone, 'M5');
    assert.ok(wave('m5-ui-tokens-spacing') < feature.wave, `${id} follows the token conversion`);
    assert.ok(wave('m5-ui-loop-click') < feature.wave, `${id} follows m5-ui-loop-click`);
    const text = feature.acceptance.join('\n');
    assert.match(text, /DOM structure and class names/);
    assert.match(text, /en against mockup\.html and in zh-TW against mockup\.html\?lang=zh-TW/);
    assert.match(text, /within 1 px/);
    assert.match(text, /0\.5 %/);
    assert.match(text, /enforce/);
    assert.match(text, /An absent part keeps its space empty/);
  }
  const chrome = FEATURES.get('m5-ui-alignment-chrome');
  for (const dep of ['m5-ui-tokens-spacing', 'm5-ui-loop-click', 'm5-ui-transport']) assert.ok(chrome.dependsOn.includes(dep), `the chrome depends on ${dep}`);
  assert.match(chrome.acceptance.join('\n'), /JetBrains Mono Medium \(500\) is bundled/);
  for (const id of ALIGNMENT.slice(1)) assert.ok(FEATURES.get(id).dependsOn.includes('m5-ui-alignment-chrome'), `${id} depends on the chrome`);
  const arrange = FEATURES.get('m5-ui-alignment-arrange');
  assert.ok(arrange.dependsOn.includes('m5-ui-edit-basics'));
  assert.match(arrange.acceptance.join('\n'), /Canvas surfaces copy the mockup's drawing parameters/);
  const closing = FEATURES.get(CLOSING);
  assert.deepEqual([...closing.dependsOn].sort(), [...ALIGNMENT].sort());
  for (const id of ALIGNMENT) assert.ok(wave(id) < closing.wave, `a later wave than ${id}`);
  const text = closing.acceptance.join('\n');
  assert.match(text, /app\/renderer\/ui/);
  assert.match(text, /debt\.json is empty/);
  assert.match(text, /All four gates are enforce/);
  // The closing feature is done only with every alignment gate enforced.
  if (DONE.has(CLOSING)) for (const id of ALIGNMENT) assert.equal(MANIFEST.gates[id], 'enforce', id);
});

test('an absent part keeps its space empty: a hold token names a part that is still pending', () => {
  // Where the shared rules do not size the empty box, a --hold-<part>-w or
  // --hold-<part>-h token does; the feature that lands the part deletes it.
  const tokens = read('app', 'renderer', 'tokens.css');
  for (const m of tokens.matchAll(/--hold-([a-z0-9-]+)-[wh]\s*:/g)) {
    const rule = ruleOf(m[1]);
    assert.ok(rule, `--hold-${m[1]}: no part of the mockup has that id`);
    assert.equal(MANIFEST.gates[rule.gate], 'pending', `--hold-${m[1]}: ${rule.gate} has landed, so the hold goes`);
  }
});

test('check-all runs the app step, and with it the gate, when app/ or the mockup changes', () => {
  assert.deepEqual(stepsForPaths([MANIFEST.mockup]), ['node', 'app']);
  assert.deepEqual(stepsForPaths(['docs/superpowers/specs/2026-11-13-siann-ui-redesign/mockup.png']), ['node', 'app']);
  assert.deepEqual(stepsForPaths(['docs/superpowers/specs/2026-11-13-siann-ui-redesign.md']), ['node']);
  assert.deepEqual(stepsForPaths(['app/renderer/ui/top-bar.css']), ['node', 'app']);
  const text = read('scripts', 'check-all.js');
  assert.match(text, /'playwright', 'test', '--project', 'fidelity'/);
  assert.match(text, /SIANN_FIDELITY: '1'/);
  assert.equal(fidelityEnforced(), Object.values(MANIFEST.gates).includes('enforce'));
});

test('CI runs the gate on Windows and Linux and keeps the report; it is report-only until a gate is enforced', () => {
  const ci = read('.github', 'workflows', 'ci.yml');
  const at = ci.indexOf('      - name: Mockup fidelity gate\n');
  assert.ok(at > ci.indexOf('\n  app:\n'), 'the app job has the step');
  const step = ci.slice(at, ci.indexOf('\n      - name: Fidelity report', at));
  assert.match(step, /if: runner\.os != 'macOS'/);
  assert.match(step, /SIANN_FIDELITY: '1'/);
  assert.match(step, /xvfb-run -a npx playwright test --project fidelity/);
  assert.match(ci, /uses: actions\/upload-artifact@v4\n {8}with:\n {10}name: fidelity-\$\{\{ runner\.os \}\}/);
  assert.equal(/continue-on-error: true/.test(step), !fidelityEnforced(), 'continue-on-error goes when a gate is enforced');
});

test('the spec runs only when asked, in its own Playwright project, at device scale factor 1', () => {
  const config = read('app', 'playwright.config.ts');
  assert.match(config, /SIANN_FIDELITY === '1'/);
  assert.match(config, /name: 'fidelity'/);
  const spec = read('app', 'test', 'e2e', 'mockup-fidelity.spec.ts');
  assert.match(spec, /--force-device-scale-factor=1/);
  assert.match(spec, /deviceScaleFactor: MANIFEST\.viewport\.deviceScaleFactor/);
});

test('the rules, the runbook, the spec and the workflow carry the guideline', () => {
  const rules = read('docs', 'harness', 'agent-rules.md');
  assert.match(rules, /\n## UI fidelity\n/);
  assert.match(rules, /reference implementation of styling and markup, and UI work ports from it/);
  assert.match(rules, /Every UI pull request runs the gate and attaches its report/);
  assert.match(rules, /Not without the maintainer/);
  assert.match(read('docs', 'harness', 'runbook.md'), /\n### UI fidelity gate\n/);
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  assert.match(spec, /\n## 10\. Mockup fidelity\n/);
  assert.match(spec, /do not conflict; they apply at different times/);
  const workflow = read('.claude', 'workflows', 'siann-milestone.js');
  for (const name of ['uiBuild', 'uiVerify', 'uiSpec']) assert.ok(workflow.includes(`\${${name}(f)}`), `the ${name} prompt is used`);
  assert.match(workflow, /mockup fidelity gate/);
});

test('the decisions of 2026-11-15 are written where contributors read them', () => {
  const rules = read('docs', 'harness', 'agent-rules.md');
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  // An absent part keeps its space empty; "no reserved space" is gone as a rule.
  assert.match(spec, /is not rendered, and its space stays empty\.\*\*/);
  assert.match(rules, /is absent, and it keeps its space empty/);
  assert.match(spec, /\n### 10\.5 Decisions of 2026-11-15\n/);
  assert.match(spec, /\n### 10\.6 The alignment tickets \(P1-9 to P1-14\)\n/);
  for (const text of [rules, spec]) {
    assert.match(text, /[Dd]ecided by the maintainer, 2026-11-15/);
    assert.match(text, /no allowlist/);
    assert.match(text, /JetBrains Mono Medium/);
    assert.doesNotMatch(text, /unowned" in the manifest/);
  }
  // Every feature the manifest or the spec's ownership table names exists.
  for (const [, id] of spec.slice(spec.indexOf('### 10.5 ')).matchAll(/`(m5b?-[a-z0-9-]+|m6a-[a-z0-9-]+)`/g)) assert.ok(FEATURES.has(id) || DONE.has(id), `${id} is a feature`);
  // The loop and click ticket names the states it changes.
  const loop = FEATURES.get('m5-ui-loop-click').acceptance.join('\n');
  assert.match(loop, /Tour states changed: the top bar in every state/);
  assert.doesNotMatch(`${loop}\n${spec.slice(spec.indexOf('**P1-7 '), spec.indexOf('**P1-8 '))}`, /Tour states changed: none of 01/);
});
