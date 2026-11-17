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

// ---- m5-ui-alignment-chrome: the shared stylesheets linked, the first enforced gate

test('the app links tokens.css and the chrome\'s shared stylesheets in the mockup\'s order, then shell.css', () => {
  const linked = (html) => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  const app = linked(read('app', 'renderer', 'index.html'));
  const chrome = ['tokens.css', 'ui/base.css', 'ui/layout.css', 'ui/top-bar.css', 'ui/status-bar.css'];
  // The mockup's own order, filtered to these five.
  const mockup = linked(MOCKUP).map((href) => href.replace('../../../../app/renderer/', '')).filter((href) => chrome.includes(href));
  assert.deepEqual(mockup, chrome);
  assert.deepEqual(app, [...mockup, 'shell.css']);
});

test('the chrome\'s gate is enforced, and the boxes of its absent parts are held by tokens applied in shell.css only', () => {
  assert.equal(MANIFEST.gates['m5-ui-alignment-chrome'], 'enforce');
  const tokens = read('app', 'renderer', 'tokens.css');
  const holds = {
    'branch-chip': ['w'],
    'transport-record': ['w', 'h'],
    'display-signature': ['w'],
    'dsp-load': ['w'],
    'zone-button-channel': ['w', 'h'],
  };
  for (const [part, sides] of Object.entries(holds)) {
    assert.equal(MANIFEST.gates[ruleOf(part).gate], 'pending', `${part} is pending`);
    for (const side of sides) assert.match(tokens, new RegExp(`--hold-${part}-${side}:\\s*calc\\([\\d.]+px \\* var\\(--scale\\)\\);`), `--hold-${part}-${side}`);
  }
  // Applied by shell.css, and by no rule of the shared stylesheets.
  const ui = fs.readdirSync(path.join(ROOT, 'app', 'renderer', 'ui')).map((file) => read('app', 'renderer', 'ui', file)).join('\n');
  assert.doesNotMatch(ui, /var\(--hold-/);
  const shell = read('app', 'renderer', 'shell.css');
  for (const [part, sides] of Object.entries(holds)) for (const side of sides) assert.ok(shell.includes(`var(--hold-${part}-${side})`), `shell.css applies --hold-${part}-${side}`);
});

test('the fidelity run passes the manifest\'s environment as SIANN_FIDELITY_ENVIRONMENT', () => {
  const spec = read('app', 'test', 'e2e', 'mockup-fidelity.spec.ts');
  assert.match(spec, /SIANN_FIDELITY_ENVIRONMENT: JSON\.stringify\(MANIFEST\.environment\)/);
  const main = read('app', 'src', 'main', 'main.ts');
  assert.match(main, /fidelityEnvironmentArgs\(process\.env\)/);
});

test('the rules and the runbook say the gate fails on an enforced mismatch, no longer "report-only until the first gate"', () => {
  for (const file of [['docs', 'harness', 'agent-rules.md'], ['docs', 'harness', 'runbook.md'], ['scripts', 'check-all.js'], ['.github', 'workflows', 'ci.yml']]) {
    assert.doesNotMatch(read(...file), /[Rr]eport-only until the first gate is enforced/, file.join('/'));
  }
  assert.match(read('docs', 'harness', 'runbook.md'), /an enforced mismatch fails/);
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

// ---- the second round of 2026-11-15 (UI redesign 10.7)

test('the mockup\'s fader taper is the app\'s (spec 4.5 C7), and every strip has M, S and e in place', () => {
  // Decided by the maintainer, 2026-11-15: the mockup was wrong and is corrected.
  const pairs = (text) => [...text.matchAll(/\[\s*(-?\d*\.?\d+)\s*,\s*(-?\d+)\s*\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const taper = read('app', 'src', 'renderer', 'mixer', 'taper.ts');
  const app = pairs(/const BREAKPOINTS[^=]*=\s*\[([\s\S]*?)\];/.exec(taper)[1]);
  const mockup = pairs(/const BP=\[(.*)\];/.exec(MOCKUP)[1]);
  assert.deepEqual(app, [[0.05, -60], [0.15, -40], [0.3, -24], [0.5, -12], [0.75, 0], [1, 6]], 'spec 4.5 C7');
  // The mockup adds the bottom of the travel, which the app computes.
  assert.deepEqual(mockup, [[0, -144], ...app]);
  // The step badge of a mute change is out of the flow, and e is on every strip.
  assert.ok(!/gUnmute\?'':`<span class="msr e"/.test(MOCKUP), 'the e button is not left out on a strip whose mute a plan changes');
  assert.match(MOCKUP, /<span class="stepn" \$\{dp\(k\+'-mute-step-ghost'\)\} style="position:absolute;[^"]*">/);
  // What a pending plan adds to a strip belongs to the ghosts, so the gate masks it.
  for (const id of ['strip-7-mute-step-ghost', 'strip-6-gain-step-ghost', 'strip-6-gain-line-ghost', 'strip-4-pan-step-ghost', 'strip-4-pan-value-ghost', 'strip-4-pan-knob-ghost']) {
    assert.equal(ruleOf(id).gate, 'm5b-ui-ghosts', id);
  }
  assert.equal(MANIFEST.gates['m5b-ui-ghosts'], 'pending');
  assert.equal(ruleOf('strip-7-mute').gate, 'm5-ui-alignment-mixer-inspector');
  assert.equal(ruleOf('strip-7-edit').gate, 'm5b-ui-inserts-master');
});

test('the Plans tab masks only what M5 cannot derive, and each mask names the feature that removes it', () => {
  const dynamic = MANIFEST.pixels.dynamic;
  const masked = (id) => dynamic.some((pattern) => glob(pattern).test(id));
  for (const id of ['plan-history-1', 'plan-history-2', 'plan-history-3', 'plan-step-2-title', 'plan-step-6-title']) assert.ok(masked(id), `${id} is masked`);
  // Derived in M5, so compared: the summary chips, the approve button, the steps, the history head.
  for (const id of ['plan-summary', 'plan-approve', 'plan-step-2', 'plan-step-3', 'plan-steps-head', 'plan-history-head', 'plan-card', 'plan-badge']) {
    assert.ok(!masked(id), `${id} is compared`);
    assert.equal(ruleOf(id).gate, 'm5-ui-alignment-plans', id);
  }
  // The history rows stay parts of the Plans alignment (boxes and styles); the
  // step titles that name a clip are pending parts of the feature that shows names.
  assert.equal(ruleOf('plan-history-2').gate, 'm5-ui-alignment-plans');
  assert.equal(ruleOf('plan-step-6-title').gate, 'm5b-ui-media');
  assert.equal(MANIFEST.gates['m5b-ui-media'], 'pending');
  // The mockup marks a title as a part only where it names a clip: steps 2 and 6.
  assert.equal((MOCKUP.match(/\$\{step\(\d,[^\n]*,false,true\)\}/g) || []).length, 2);
  assert.match(MOCKUP, /\$\{step\(2,'Place <b>Pad swell<\/b> on Pad',[^\n]*,false,true\)\}/);
  assert.match(MOCKUP, /\$\{step\(6,'Move <b>Riser<\/b> on FX',[^\n]*,false,true\)\}/);
  const plans = FEATURES.get('m5-ui-alignment-plans').acceptance.join('\n');
  assert.match(plans, /Approve N of M/);
  assert.match(plans, /count chips/);
  assert.match(plans, /plan-history-1 to plan-history-3/);
  assert.doesNotMatch(plans, /still names the plan by its first step/);
  assert.match(FEATURES.get('m5b-ui-plan-metadata').acceptance.join('\n'), /plan-history-1 to plan-history-3 leave pixels\.dynamic/);
  assert.match(FEATURES.get('m5b-ui-media').acceptance.join('\n'), /plan-step-\*-title leaves pixels\.dynamic/);
});

test('the chrome takes the mockup\'s text formats, and only the fidelity run takes its device and build', () => {
  const chrome = FEATURES.get('m5-ui-alignment-chrome').acceptance.join('\n');
  assert.match(chrome, /hh:mm:ss\.mmm/);
  assert.match(chrome, /two decimals/);
  assert.match(chrome, /changes the formatting m5-ui-transport shipped/);
  assert.match(chrome, /one latency, the round trip/);
  assert.match(chrome, /first 7 characters of the commit/);
  assert.match(chrome, /SIANN_FIDELITY_ENVIRONMENT/);
  // The environment is the mockup's status bar, value for value.
  const { device, engineAbout } = MANIFEST.environment;
  const [type, name] = device.id.split('/');
  const latency = (((device.inputLatencyFrames + device.outputLatencyFrames) * 1000) / device.sampleRate).toFixed(1);
  assert.ok(MOCKUP.includes(`>${type} · ${name} · <b class="num">${device.sampleRate / 1000} kHz</b> / <b class="num">${device.bufferFrames}</b> · <span class="num">${latency} ms</span>`), 'status-device');
  assert.ok(MOCKUP.includes(`>${engineAbout.name} ${engineAbout.version} (<span class="mono" style="font-size:var(--fs-micro)">${engineAbout.source.commit.slice(0, 7)}</span>) · ${engineAbout.license} · `), 'status-about');
  assert.match(engineAbout.source.commit, /^[0-9a-f]{40}$/);
  // The mockup's own formats.
  assert.match(MOCKUP, /<span class="val sm">00:00:19<em>\.<\/em>000<\/span>/);
  assert.match(MOCKUP, /<span class="val sm">120<em>\.<\/em>00<\/span>/);
  // The switch is the shell's and for tests only; no source reads it yet (it lands with the chrome).
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  assert.match(spec, /`SIANN_FIDELITY_ENVIRONMENT`, which the shell reads only under `SIANN_SHELL_TEST=1`/);
});

test('the decisions of the second round are written where contributors read them', () => {
  const rules = read('docs', 'harness', 'agent-rules.md');
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  assert.match(spec, /\n### 10\.7 Decisions of 2026-11-15, second round\n/);
  for (const [, id] of spec.slice(spec.indexOf('### 10.7 ')).matchAll(/`(m5b?-[a-z0-9-]+|m6a-[a-z0-9-]+)`/g)) assert.ok(FEATURES.has(id) || DONE.has(id), `${id} is a feature`);
  // Token debt: both changes authorised for the closing feature.
  const closing = FEATURES.get(CLOSING).acceptance.join('\n');
  assert.match(closing, /app-only tokens are added to tokens\.css/);
  assert.match(closing, /conditions of container queries are not counted/);
  assert.match(rules, /App-only tokens in `tokens\.css`[^\n]*\| `m5-ui-mockup-alignment`[^|\n]*\|/);
  // The 2 px focus ring's token was applied early in m5-ui-tokens-spacing (10.7, 4a).
  assert.match(rules, /App-only tokens in `tokens\.css`[^\n]*the 2 px focus ring \(`--focus-ring`, 55 %\) applied early in `m5-ui-tokens-spacing`/);
  assert.match(spec, /applied early in `m5-ui-tokens-spacing` by the main session under the maintainer's 2026-11-15 authorisation 4a/);
  // A landed part that can be absent at runtime: a permanent width token, not a hold.
  assert.match(FEATURES.get('m5-ui-loop-click').acceptance.join('\n'), /its box keeps the width of --display-locators-empty-w/);
  assert.match(rules, /`--<part>-empty-w` token[^\n]*\| `--display-locators-empty-w`, in `m5-ui-loop-click` \|/);
  assert.match(spec, /permanent `--<part>-empty-w` token/);
  assert.equal(ruleOf('display-locators').gate, 'm5-ui-alignment-chrome');
  // The mixer's acceptance no longer bends around the mockup's two mistakes.
  const mixer = FEATURES.get('m5-ui-alignment-mixer-inspector').acceptance.join('\n');
  assert.match(mixer, /The fader's taper is unchanged/);
  assert.match(mixer, /M and S do not move/);
  // Clip titles come from the media's name in M5, so the project zone can match.
  assert.match(FEATURES.get('m5-ui-alignment-arrange').acceptance.join('\n'), /show the media's name \(media\.name/);
  const gate = milestone('M5').humanGates.find((entry) => entry.id === 'fidelity-decisions-2');
  assert.match(gate.resolution, /^Decided by the maintainer, 2026-11-15/);
});

// m5-ui-alignment-chrome, fix round 1. The zones are the mockup's CSS grid
// with SIANN's own dividers: the UI spec says so wherever it named the panel
// library, and the reversal of row 15's default is recorded there.
test('the UI spec no longer builds the zones with react-resizable-panels', () => {
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  const section = (heading) => {
    const start = spec.indexOf(`\n${heading}`);
    assert.ok(start >= 0, heading);
    const next = spec.slice(start + 1).search(/\n#{2,3} /);
    return next < 0 ? spec.slice(start) : spec.slice(start, start + 1 + next);
  };
  const library = /react-resizable-panels/;
  // Item 8 of section 0, the "Resizable zones" row of 5.9, P1-1's scope and
  // row 15 of section 8 name the library only as what left.
  const item8 = /\n8\. \*\*Dependencies:\*\*[^\n]*/.exec(spec)?.[0] ?? '';
  assert.match(item8, /SIANN's own dividers/);
  assert.match(item8, /react-resizable-panels[^\n]*left with `m5-ui-alignment-chrome`/);
  const row59 = /\n\| Resizable zones \|[^\n]*/.exec(section('### 5.9 Libraries'))?.[0] ?? '';
  assert.match(row59, /SIANN's own/);
  assert.doesNotMatch(row59, /would be more code hand-rolled/);
  assert.match(row59, /m5-ui-alignment-chrome/);
  const p11 = /\n- Scope: `tokens\.css`; local Inter[^\n]*/.exec(spec)?.[0] ?? '';
  assert.match(p11, /draggable and collapsible with `react-resizable-panels`[^;]*replaced by SIANN's own dividers in `m5-ui-alignment-chrome`/);
  const row15 = /\n\| 15 \| Dependencies and fonts \|[^\n]*/.exec(spec)?.[0] ?? '';
  assert.match(row15, /`m5-ui-alignment-chrome`/);
  assert.match(row15, /maintainer/);
  assert.doesNotMatch(row15, /\| `react-resizable-panels` in P1-1, pinned/);
  // 2.2's argument for zones stands, on the grid instead of the library.
  assert.doesNotMatch(section('### 2.2 Why zones and not free docking'), /react-resizable-panels` gives/);
  // Nothing else in the spec offers the library as current.
  for (const line of spec.split('\n').filter((l) => library.test(l))) {
    assert.match(line, /m5-ui-alignment-chrome|\[L1\]/, line.slice(0, 120));
  }
});

// Small windows (spec 2.4): every width at which shell.css changes the top
// bar or the status bar is a width 2.4 names, and 3.0's hold rule says what
// a held box does under it.
test('the small-window breakpoints of shell.css are the ones spec 2.4 and 3.0 describe', () => {
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  const css = read('app', 'renderer', 'shell.css');
  const start = spec.indexOf('\n### 2.4 Small windows');
  const s24 = spec.slice(start, spec.indexOf('\n### 2.5 ', start));
  const widths = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
  assert.deepEqual([...new Set(widths)].sort((a, b) => b - a), [1300, 1100]);
  for (const width of widths) assert.match(s24, new RegExp(`Under ${width} px wide`), `${width} px in 2.4`);
  // 1300 px: the transport leaves the centre and the three side holds go.
  assert.match(s24, /Under 1300 px wide[^\n]*the transport is no longer centred/);
  for (const part of ['branch chip', 'DSP load', 'Record button']) assert.match(s24, new RegExp(`Under 1300 px wide[^\n]*${part}`), part);
  // 1100 px: the brand goes too; the session name shortens instead of going.
  assert.match(s24, /Under 1100 px wide[^\n]*the brand/);
  assert.match(s24, /session name[^\n]*(ellipsis|shortens)/);
  // Media queries on the window for the bars, which span it; container queries in the zones.
  assert.match(s24, /media queries/);
  // 3.0's hold rule: a hold keeps its space at the mockup's width (1440 px) and down to 1300 px.
  const s30 = spec.slice(spec.indexOf('\n### 3.0 '), spec.indexOf('\n### 3.1 '));
  assert.match(s30, /1300 px/);
  // The CSS does what 2.4 says.
  const block = (width) => {
    const at = css.indexOf(`@media (max-width: ${width}px)`);
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) return css.slice(open, i + 1);
    }
    return '';
  };
  assert.match(block(1300), /\.topbar \{ grid-template-columns: auto auto minmax\(0, 1fr\); \}/);
  assert.match(block(1300), /\.hold-branch-chip, \.hold-dsp-load, \.hold-transport-record \{ display: none; \}/);
  assert.match(block(1100), /\.brand \{ display: none; \}/);
  assert.match(block(1100), /\.hold-display-signature/);
});
