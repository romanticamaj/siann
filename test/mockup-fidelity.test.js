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
const FEATURES = new Map(['M5', 'M5b'].flatMap((id) => milestone(id).features.map((f) => [f.id, { ...f, milestone: id }])));
const DONE = new Set(['M5', 'M5b'].flatMap((id) => milestone(id).done));

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

test('every rule names a feature of M5 or M5b and a gate with a mode, or says why it is unowned', () => {
  const modes = new Set(['pending', 'report', 'enforce']);
  for (const [gate, mode] of Object.entries(MANIFEST.gates)) {
    assert.ok(FEATURES.has(gate), `gate ${gate} is a feature of M5 or M5b`);
    assert.ok(modes.has(mode), `${gate}: ${mode}`);
  }
  for (const rule of MANIFEST.rules) {
    assert.ok(Array.isArray(rule.match) && rule.match.length > 0, JSON.stringify(rule));
    if (rule.gate === null) {
      assert.equal(rule.feature, null);
      assert.ok(typeof rule.unowned === 'string' && rule.unowned.length > 20, `an unowned rule says what it waits for: ${rule.match.join(', ')}`);
      continue;
    }
    assert.ok(FEATURES.has(rule.feature) || DONE.has(rule.feature), `${rule.feature} is a feature of M5 or M5b`);
    assert.ok(rule.gate in MANIFEST.gates, `${rule.gate} has a mode in manifest.gates`);
    // M5's parts answer to the alignment feature; an M5b feature answers for its own.
    assert.equal(rule.gate, rule.feature.startsWith('m5b-') ? rule.feature : 'm5-ui-mockup-alignment', rule.match.join(', '));
  }
  for (const gate of Object.keys(MANIFEST.gates)) assert.ok(MANIFEST.rules.some((rule) => rule.gate === gate), `${gate} owns no part`);
});

test('a feature that owns parts carries the gate in its acceptance, and a landed one enforces it', () => {
  for (const [gate, mode] of Object.entries(MANIFEST.gates)) {
    const feature = FEATURES.get(gate);
    assert.ok(feature.acceptance.some((line) => /fidelity gate|mockup-fidelity\.spec/.test(line)), `${gate}: an acceptance line names the fidelity gate`);
    if (DONE.has(gate)) assert.equal(mode, 'enforce', `${gate} is done: its gate is enforce`);
  }
});

test('m5-ui-mockup-alignment follows the in-flight UI features and ports from the mockup', () => {
  const feature = FEATURES.get('m5-ui-mockup-alignment');
  assert.equal(feature.milestone, 'M5');
  for (const dep of ['m5-ui-transport', 'm5-ui-edit-basics', 'm5-ui-loop-click']) {
    assert.ok(feature.dependsOn.includes(dep), `depends on ${dep}`);
    assert.ok(FEATURES.get(dep).wave < feature.wave, `a later wave than ${dep}`);
  }
  const text = feature.acceptance.join('\n');
  assert.match(text, /DOM structure and class names/);
  assert.match(text, /app\/renderer\/ui/);
  assert.match(text, /Canvas surfaces copy the mockup's drawing parameters/);
  assert.match(text, /en against mockup\.html and in zh-TW against mockup\.html\?lang=zh-TW/);
  assert.match(text, /within 1 px/);
  assert.match(text, /0\.5 %/);
  assert.match(text, /enforce/);
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
