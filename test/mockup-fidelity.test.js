'use strict';

// The mockup fidelity run's bookkeeping (docs/harness/agent-rules.md, "UI
// fidelity"; UI redesign spec, section 10): the manifest that owns every part
// of the mockup, the milestone features that port the parts, and the places
// that run the comparison (check-all, CI, the workflow's prompts, the rules).
// Decided by the maintainer, 2026-11-17 (UI redesign 10.9): the run is a
// visual aid. It reports and never blocks, no gate is `enforce`, and a UI
// pull request is reviewed by eye from side-by-side screenshots. The run
// itself is app/test/e2e/mockup-fidelity.spec.ts; the token layer, which
// still blocks, is test/ui-tokens.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const checkAll = require('../scripts/check-all');

const { stepsForPaths } = checkAll;

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const MANIFEST = JSON.parse(read('app', 'test', 'fidelity', 'manifest.json'));
const MOCKUP = read(...MANIFEST.mockup.split('/'));
const milestone = (id) => JSON.parse(read('.claude', 'milestones', `${id}.json`));
// The milestones that own parts of the mockup: M5 built the window, M5b is the
// usable release, and M6a owns the automation parts (maintainer, 2026-11-15).
// Decided by Fable, delegated by the maintainer, 2026-11-18 (UI redesign
// 10.11): M6a also owns the tools M5b leaves out, and M6c the master's mute,
// insert rack and e, which need engine work no earlier milestone has.
const OWNERS = ['M5', 'M5b', 'M6a', 'M6c'];
const FEATURES = new Map(OWNERS.flatMap((id) => milestone(id).features.map((f) => [f.id, { ...f, milestone: id }])));
const DONE = new Set(OWNERS.flatMap((id) => milestone(id).done));
// M5's parts answer to the feature that ports them from the mockup's markup:
// the chrome, and one feature per component (maintainer, 2026-11-17). The
// closing feature removes what the port left over and empties the debt ledger.
const CHROME = 'm5-ui-alignment-chrome';
const PORTS = ['m5-ui-port-arrange-canvas', 'm5-ui-port-mixer-strip', 'm5-ui-port-plans', 'm5-ui-port-inspector', 'm5-ui-port-track-list', 'm5-ui-port-toolbar'];
const CLOSING = 'm5-ui-port-cleanup';
// The alignment features the port replaced; the spec's history still names them.
const REPLACED = ['m5-ui-alignment-arrange', 'm5-ui-alignment-mixer-inspector', 'm5-ui-alignment-plans', 'm5-ui-mockup-alignment'];
const REGION_GATES = {
  'top-bar': CHROME,
  'status-bar': CHROME,
  'project-zone': 'm5-ui-port-arrange-canvas',
  'left-zone': 'm5-ui-port-inspector',
  'lower-zone': 'm5-ui-port-mixer-strip',
  'right-zone': 'm5-ui-port-plans',
};

const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const ruleOf = (id) => MANIFEST.rules.find((rule) => rule.match.some((pattern) => glob(pattern).test(id)));

// The ids the mockup's markup names outright; ids built per track, strip or
// step are checked by the run, which reports a part no rule owns.
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
  // What the report measures against: one pixel, identical styles, the pixel layer's limits.
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

test('every rule names its feature and a gate that is pending or report, and no part is unowned', () => {
  // Decided by the maintainer, 2026-11-17: the run never blocks, so there is no enforce mode.
  const modes = new Set(['pending', 'report']);
  for (const [gate, mode] of Object.entries(MANIFEST.gates)) {
    assert.ok(FEATURES.has(gate), `gate ${gate} is a feature of ${OWNERS.join(', ')}`);
    assert.notEqual(mode, 'enforce', `${gate}: no gate is enforce (maintainer, 2026-11-17)`);
    assert.ok(modes.has(mode), `${gate}: ${mode}`);
  }
  for (const rule of MANIFEST.rules) {
    assert.ok(Array.isArray(rule.match) && rule.match.length > 0, JSON.stringify(rule));
    // Decided by the maintainer, 2026-11-15: every part has an owner.
    assert.ok(rule.feature && rule.gate && !('unowned' in rule), `no part is unowned: ${rule.match.join(', ')}`);
    assert.ok(FEATURES.has(rule.feature) || DONE.has(rule.feature), `${rule.feature} is a feature of ${OWNERS.join(', ')}`);
    assert.ok(rule.gate in MANIFEST.gates, `${rule.gate} has a mode in manifest.gates`);
    // M5's parts answer to the feature that ports them; a later feature answers for its own.
    if (rule.feature.startsWith('m5-')) assert.ok([CHROME, ...PORTS].includes(rule.gate), `${rule.match.join(', ')}: ${rule.gate}`);
    else assert.equal(rule.gate, rule.feature, rule.match.join(', '));
  }
  for (const gate of Object.keys(MANIFEST.gates)) assert.ok(MANIFEST.rules.some((rule) => rule.gate === gate), `${gate} owns no part`);
  // What M5 built is measured: its gates are report, today and for good.
  for (const gate of [CHROME, ...PORTS]) assert.equal(MANIFEST.gates[gate], 'report', gate);
  for (const gate of REPLACED) assert.ok(!(gate in MANIFEST.gates), `${gate} was replaced by the component port`);
  // A region's image answers to the feature that ports its main component.
  assert.deepEqual(Object.keys(REGION_GATES).sort(), [...MANIFEST.regions].sort());
  for (const [region, gate] of Object.entries(REGION_GATES)) assert.equal(ruleOf(region).gate, gate, region);
});

test('each component of M5 has the port feature that owns its parts', () => {
  const owner = {
    'event-display': 'm5-ui-port-arrange-canvas', 'ruler-upper': 'm5-ui-port-arrange-canvas', 'lane-3': 'm5-ui-port-arrange-canvas', 'clip-5': 'm5-ui-port-arrange-canvas',
    'locator-band': 'm5-ui-port-arrange-canvas', cursor: 'm5-ui-port-arrange-canvas', 'scroll-zoom': 'm5-ui-port-arrange-canvas',
    'track-list': 'm5-ui-port-track-list', 'track-list-head': 'm5-ui-port-track-list', 'track-count': 'm5-ui-port-track-list', 'track-2': 'm5-ui-port-track-list', 'track-2-solo': 'm5-ui-port-track-list',
    toolbar: 'm5-ui-port-toolbar', tools: 'm5-ui-port-toolbar', 'tool-1': 'm5-ui-port-toolbar', snap: 'm5-ui-port-toolbar', 'grid-type': 'm5-ui-port-toolbar', 'auto-scroll': 'm5-ui-port-toolbar',
    'info-line': 'm5-ui-port-toolbar', 'info-name': 'm5-ui-port-toolbar', 'info-volume': 'm5-ui-port-toolbar',
    'inspector-head': 'm5-ui-port-inspector', 'inspector-volume': 'm5-ui-port-inspector', 'inspector-mute': 'm5-ui-port-inspector', 'inspector-tabs': 'm5-ui-port-inspector',
    'lower-tabs': 'm5-ui-port-mixer-strip', mixer: 'm5-ui-port-mixer-strip', 'strip-3': 'm5-ui-port-mixer-strip', 'strip-3-pan-knob': 'm5-ui-port-mixer-strip', 'strip-3-cap': 'm5-ui-port-mixer-strip', 'strip-master-meter': 'm5-ui-port-mixer-strip',
    'right-tabs': 'm5-ui-port-plans', 'hearing-switch': 'm5-ui-port-plans', 'plan-card': 'm5-ui-port-plans', 'plan-step-3': 'm5-ui-port-plans', 'plan-approve': 'm5-ui-port-plans', 'plan-history-2': 'm5-ui-port-plans',
    transport: CHROME, 'display-time': CHROME, 'status-device': CHROME, 'plans-button': CHROME,
  };
  for (const [id, gate] of Object.entries(owner)) assert.equal(ruleOf(id).gate, gate, id);
  for (const gate of PORTS) assert.ok(Object.values(owner).includes(gate), gate);
  // Parts of a later feature inside a ported component stay that feature's, pending.
  for (const [id, gate] of Object.entries({ 'tool-4': 'm5b-ui-edit-more', 'info-fade-in': 'm5b-ui-fades', 'marker-head': 'm5b-ui-markers', 'track-2-record': 'm5b-ui-recording', 'strip-3-inserts': 'm5b-ui-inserts-master', 'inspector-notepad': 'm5b-ui-notepad' })) {
    assert.equal(ruleOf(id).gate, gate, id);
    assert.equal(MANIFEST.gates[gate], 'pending', gate);
  }
  // A later feature that landed its parts keeps them, its gate report (m5b-ui-plan-metadata).
  assert.equal(ruleOf('agent-row').gate, 'm5b-ui-plan-metadata');
  assert.equal(MANIFEST.gates['m5b-ui-plan-metadata'], 'report');
  // The proposal pill stays m5b-ui-ghosts', which landed it (report).
  assert.equal(ruleOf('proposal-pill').gate, 'm5b-ui-ghosts');
  assert.equal(MANIFEST.gates['m5b-ui-ghosts'], 'report');
});

test('a feature that owns parts names its gate in its acceptance, asks for a side-by-side screenshot and never for enforce', () => {
  for (const [gate, mode] of Object.entries(MANIFEST.gates)) {
    const feature = FEATURES.get(gate);
    const text = feature.acceptance.join('\n');
    assert.ok(feature.acceptance.some((line) => line.includes(`app/test/fidelity/manifest.json (${gate})`)), `${gate}: its acceptance names its own gate`);
    assert.match(text, /side-by-side screenshot/, `${gate}: a side-by-side screenshot is attached`);
    assert.match(text, /[Dd]ecided by the maintainer, 2026-11-17/, gate);
    assert.match(text, /ported from the mockup's markup|Ported from the mockup's markup|ported from the mockup's draw\(\)/, `${gate}: its parts are ported from the mockup`);
    // No acceptance asks for a gate to be enforced, or for a pixel or geometry threshold to pass.
    assert.doesNotMatch(text, /set(s)? [^.]*to enforce in this pull request|is set to enforce|within 1 px|differ by at most 0\.5 %/, gate);
    // A landed feature's parts are measured.
    if (DONE.has(gate)) assert.equal(mode, 'report', `${gate} is done: its gate is report`);
  }
  // No feature of the three milestones still asks for the gate to pass or to be enforced.
  for (const feature of FEATURES.values()) {
    const text = feature.acceptance.join('\n');
    assert.doesNotMatch(text, /fidelity gate[^.]*\) pass(es)? for/, `${feature.id}: the gate does not block`);
    assert.doesNotMatch(text, /gate is set to enforce|to enforce in this pull request|All four gates are enforce/, feature.id);
  }
});

test('the port is split by component after the chrome, in parallel where the components are independent, and one feature closes it', () => {
  const wave = (id) => FEATURES.get(id).wave;
  const tokens = FEATURES.get('m5-ui-tokens-spacing');
  assert.equal(tokens.milestone, 'M5');
  assert.match(tokens.acceptance.join('\n'), /no allowlist/);
  assert.match(tokens.acceptance.join('\n'), /No visual change to the mockup, proven by the gate's own measurement/);
  const chrome = FEATURES.get(CHROME);
  for (const dep of ['m5-ui-tokens-spacing', 'm5-ui-loop-click', 'm5-ui-transport']) assert.ok(chrome.dependsOn.includes(dep), `the chrome depends on ${dep}`);
  assert.match(chrome.acceptance.join('\n'), /JetBrains Mono Medium \(500\) is bundled/);
  for (const id of REPLACED) assert.ok(!FEATURES.has(id), `${id} was replaced by the component port`);
  for (const id of PORTS) {
    const feature = FEATURES.get(id);
    assert.ok(feature, id);
    assert.equal(feature.milestone, 'M5');
    assert.ok(wave(CHROME) < feature.wave, `${id} follows the chrome`);
    assert.match(feature.title, /^Component port, /);
    const text = feature.acceptance.join('\n');
    // Ported from the mockup's markup or script function, on real data.
    assert.match(text, /^Decided by the maintainer, 2026-11-17 \(UI redesign 10\.9\)/);
    assert.match(text, /DOM structure and class names|the event display's DOM is the mockup's/);
    assert.match(text, /Real data|Waveforms are real/);
    // Tested: unit, e2e, ids, and a side-by-side screenshot for the eye.
    assert.match(text, /[Uu]nit test/);
    assert.match(text, /e2e/);
    assert.match(text, /Ids: every part keeps the mockup's data-part id/);
    assert.match(text, /no id of a pending part/);
    assert.match(text, /side-by-side screenshot of the app and the mockup/);
    assert.match(text, /in en and zh-TW/);
    assert.match(text, /is report and stays report/);
    // What blocks: the token rules and the ledger.
    assert.match(text, /Layer 1 still blocks \(test\/ui-tokens\.test\.js\)/);
    assert.match(text, /debt\.json only shrinks/);
    // Earlier decisions stand.
    assert.match(text, /An absent part keeps its space empty \(UI redesign 3\.0, decided by the maintainer, 2026-11-15, and unchanged\)/);
    assert.match(text, /Tour states changed: /);
    assert.ok(feature.specRefs.includes('UI redesign: 10.9') && feature.specRefs.some((ref) => /^UI redesign: 10\.10 \(P1-1[1-6]\)$/.test(ref)), `${id}: specRefs`);
  }
  // Wave 10: the first component of each zone, side by side; each depends on the chrome only among the ports.
  // The MixConsole and the Inspector are the exceptions: their M and S take .msr from project-zone.css, which the canvas links.
  const first = ['m5-ui-port-arrange-canvas', 'm5-ui-port-plans'];
  for (const id of first) {
    assert.equal(wave(id), wave(CHROME) + 1, id);
    assert.ok(FEATURES.get(id).dependsOn.includes(CHROME), `${id} depends on the chrome`);
    assert.deepEqual(FEATURES.get(id).dependsOn.filter((dep) => PORTS.includes(dep)), [], `${id} waits for no other port`);
  }
  // The track list and the toolbar share the project zone's stylesheet, row geometry and clip title with the
  // canvas; the MixConsole and the Inspector take M and S (.msr) from it.
  for (const id of ['m5-ui-port-track-list', 'm5-ui-port-toolbar', 'm5-ui-port-mixer-strip', 'm5-ui-port-inspector']) {
    assert.equal(wave(id), wave('m5-ui-port-arrange-canvas') + 1, id);
    assert.deepEqual(FEATURES.get(id).dependsOn.filter((dep) => PORTS.includes(dep)), ['m5-ui-port-arrange-canvas'], id);
  }
  const canvas = FEATURES.get('m5-ui-port-arrange-canvas');
  for (const dep of ['m5-ui-edit-basics', 'm5-ui-loop-click']) assert.ok(canvas.dependsOn.includes(dep), dep);
  const canvasText = canvas.acceptance.join('\n');
  assert.match(canvasText, /ported from the mockup's draw\(\) function/);
  assert.match(canvasText, /Waveforms are real: each clip's interior is drawn from its media's peak pyramid/);
  assert.match(canvasText, /TimelineCanvas\.ts holds no size literal/);
  assert.match(FEATURES.get('m5-ui-port-mixer-strip').acceptance.join('\n'), /the mockup's knob\(\)/);
  assert.match(FEATURES.get('m5-ui-port-mixer-strip').acceptance.join('\n'), /MixerMeters\.ts holds no colour literal/);
  assert.match(FEATURES.get('m5-ui-port-mixer-strip').acceptance.join('\n'), /M and S take \.msr, whose rules are in ui\/project-zone\.css, linked by m5-ui-port-arrange-canvas, which lands first/);
  assert.match(FEATURES.get('m5-ui-port-plans').acceptance.join('\n'), /as step\(\) returns it/);
  assert.match(FEATURES.get('m5-ui-port-track-list').acceptance.join('\n'), /as th\(\) returns it/);
  assert.match(FEATURES.get('m5-ui-port-inspector').acceptance.join('\n'), /ui\/project-zone\.css is already linked by m5-ui-port-arrange-canvas, and M and S take \.msr from it/);
  const toolbar = FEATURES.get('m5-ui-port-toolbar').acceptance.join('\n');
  assert.match(toolbar, /as tool\(\) returns it/);
  assert.match(toolbar, /opened with Ctrl\+P/);
  assert.match(toolbar, /bar\.beat\.sixteenth\.tick/);
  // The closing feature: after every port, nothing left over, an empty ledger, and still a report.
  const closing = FEATURES.get(CLOSING);
  assert.deepEqual([...closing.dependsOn].sort(), [CHROME, ...PORTS].sort());
  for (const id of PORTS) assert.ok(wave(id) < closing.wave, `a later wave than ${id}`);
  const text = closing.acceptance.join('\n');
  assert.match(text, /app\/renderer\/ui/);
  assert.match(text, /No leftover component/);
  assert.match(text, /debt\.json is empty/);
  assert.match(text, /The fidelity run stays a report/);
  assert.match(text, /side-by-side screenshot of the whole window/);
  assert.doesNotMatch(text, /All four gates are enforce/);
  // The ledger names the closing feature.
  assert.equal(JSON.parse(read('app', 'test', 'fidelity', 'debt.json')).gate, CLOSING);
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

// ---- m5-ui-alignment-chrome: the shared stylesheets linked; its gate stays report
// (decided by the maintainer, 2026-11-17: the fidelity run is a visual aid and never blocks)

// m5-ui-port-cleanup (acceptance 1): one stylesheet set for the app and the
// mockup. The app links the mockup's nine files (tokens.css and every file of
// app/renderer/ui) in the mockup's order, optionally followed by shell.css,
// and nothing else.
test('the app\'s links are the mockup\'s nine, in order, optionally followed by shell.css and by nothing else', () => {
  const linked = (html) => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  const app = linked(read('app', 'renderer', 'index.html'));
  const mockup = linked(MOCKUP).map((href) => href.replace('../../../../app/renderer/', ''));
  assert.equal(mockup.length, 9, 'the mockup links nine stylesheets');
  assert.equal(mockup[0], 'tokens.css', 'tokens.css first');
  // The mockup's nine cover every file of app/renderer/ui.
  const ui = fs.readdirSync(path.join(ROOT, 'app', 'renderer', 'ui')).filter((f) => f.endsWith('.css')).map((f) => `ui/${f}`).sort();
  assert.deepEqual(mockup.slice(1).sort(), ui, 'every file of app/renderer/ui is one of the mockup\'s links');
  assert.ok(app.length === 9 || app.length === 10, `${app.length} links`);
  assert.deepEqual(app.slice(0, 9), mockup, 'the mockup\'s nine, in its order');
  if (app.length === 10) assert.equal(app[9], 'shell.css', 'then shell.css, and nothing else');
  // No other way in: no <style> and no @import.
  assert.doesNotMatch(read('app', 'renderer', 'index.html'), /<style[\s>]/);
  assert.doesNotMatch(read('app', 'renderer', 'shell.css'), /@import/);
});

// ---- m5-ui-port-mixer-strip (UI redesign 10.10, P1-12): the MixConsole ported from strip(), knob() and the master

test('the MixConsole port links ui/lower-zone.css in the mockup\'s order, its gate is report and it holds no part', () => {
  const linked = (html) => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  const app = linked(read('app', 'renderer', 'index.html'));
  assert.ok(app.includes('ui/lower-zone.css'), 'index.html links ui/lower-zone.css');
  assert.ok(app.indexOf('ui/lower-zone.css') < app.indexOf('shell.css'), 'before shell.css');
  assert.ok(app.indexOf('ui/layout.css') < app.indexOf('ui/lower-zone.css') && app.indexOf('ui/lower-zone.css') < app.indexOf('ui/status-bar.css'), 'in the mockup\'s order');
  assert.equal(MANIFEST.gates['m5-ui-port-mixer-strip'], 'report');
  // No hold token for a part this feature landed: its boxes are sized by the shared rules or existing tokens.
  const tokens = read('app', 'renderer', 'tokens.css');
  for (const m of tokens.matchAll(/--hold-([a-z0-9-]+)-[wh]\s*:/g)) assert.notEqual(ruleOf(m[1]).gate, 'm5-ui-port-mixer-strip', `--hold-${m[1]}`);
  // The ledger no longer names the meter surface.
  assert.ok(!('app/src/renderer/mixer/MixerMeters.ts' in JSON.parse(read('app', 'test', 'fidelity', 'debt.json')).literals));
});

test('every shared stylesheet that draws a MixConsole class is linked: M and S take .msr from ui/project-zone.css', () => {
  const linked = (html) => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  const app = linked(read('app', 'renderer', 'index.html'));
  const strip = read('app', 'src', 'renderer', 'mixer', 'Strip.tsx');
  // The class names the strip renders, from its className literals.
  const classes = new Set();
  for (const m of strip.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
    for (const name of (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (/^[a-z][\w-]*$/.test(name)) classes.add(name);
  }
  assert.ok(classes.has('msr'), 'the strip renders .msr');
  const dir = path.join(ROOT, 'app', 'renderer', 'ui');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const drawn = [...classes].filter((name) => new RegExp(`\\.${name}(?![\\w-])`).test(css));
    if (drawn.includes('msr')) assert.ok(app.includes(`ui/${file}`), `index.html links ui/${file}, which draws .msr`);
  }
  // shell.css draws no second .msr rule: outside the button reset's
  // :where()/:not() lists (which only exclude .msr from the app's own button
  // look), no selector names .msr (the empty .msr-box hold is another class).
  let shell = read('app', 'renderer', 'shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
  while (/\([^()]*\)/.test(shell)) shell = shell.replace(/\([^()]*\)/g, '');
  const selectors = [...shell.matchAll(/([^{}]+)\{/g)].map((m) => m[1]);
  assert.deepEqual(selectors.filter((s) => /\.msr(?![\w-])/.test(s)), [], 'no .msr rule in shell.css');
});

// UI redesign 10.9 (1) and 10.10: a ported component is styled by the shared
// rules and nothing else. The lower zone holds nothing unported after this
// feature (tab row, strips, master), so shell.css's pinned pre-port text
// styles (line height, letter spacing, tabular figures, no font features)
// no longer reach it: it inherits base.css's body text as the mockup does.
test('shell.css\'s pinned pre-port text styles do not reach the ported lower zone', () => {
  const shell = read('app', 'renderer', 'shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...shell.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /letter-spacing:\s*normal/.test(m[2]) || /font-feature-settings:\s*normal/.test(m[2]))
    .map((m) => m[1].trim());
  // Every zone is ported (m5-ui-port-cleanup): what still sets these text
  // styles is a rule for the app's own overlays, and it names no zone.
  for (const list of rules) assert.doesNotMatch(list, /\.zone(?![\w-])/, `"${list}" pins text styles on a zone`);
  // The lower zone's element: section.lower.zone.zone-lower (Shell.tsx, ZoneFrame).
  const lower = new Set(['lower', 'zone', 'zone-lower']);
  // Whether one compound selector (classes, :not() and :where() of classes) matches it.
  const matchesLower = (compound) => {
    const excluded = [...compound.matchAll(/:not\(\s*\.([\w-]+)\s*\)/g)].map((m) => m[1]);
    const required = [...compound.replace(/:(?:not|where|is)\((?:[^()]|\([^()]*\))*\)/g, '').matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
    if (/[\s>+~]/.test(compound.trim())) return true; // a descendant selector: treated as reaching it
    return required.every((c) => lower.has(c)) && excluded.every((c) => !lower.has(c));
  };
  for (const list of rules) {
    for (const selector of list.split(/,(?![^()]*\))/).map((s) => s.trim())) {
      assert.ok(!matchesLower(selector), `"${selector}" in shell.css pins pre-port text styles on the lower zone`);
    }
  }
  // Nor does any rule of shell.css set them on a part of the lower zone.
  for (const name of ['lower', 'zone-lower', 'tabs', 'tab', 'mixer', 'strip', 'master']) {
    const pinned = [...shell.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => new RegExp(`\\.${name}(?![\\w-])`).test(m[1].replace(/:(?:not|where)\((?:[^()]|\([^()]*\))*\)/g, '')))
      .filter((m) => /letter-spacing|font-variant-numeric|font-feature-settings|line-height/.test(m[2]));
    assert.deepEqual(pinned.map((m) => m[1].trim()), [], `no text-style rule for .${name} in shell.css`);
  }
});

// Acceptance 9: one strip muted (the mockup's FX, in both images) and one
// with its fader held, side by side, in en and zh-TW, written by the
// fidelity run. The mockup draws no held fader, so the run writes the app's
// lower zone alone in that state and says so in the report's notes.
test('the fidelity run writes the lower zone with a strip\'s fader held, in every locale', () => {
  const spec = read('app', 'test', 'e2e', 'mockup-fidelity.spec.ts');
  assert.match(spec, /path\.join\(dir, 'lower-zone\.fader-held\.app\.png'\)/);
  assert.match(spec, /notes\.push\(`The held-fader state[^`]*lower-zone\.fader-held\.app\.png/);
  // Pointer down on a fader's cap, moved, screenshot taken before the release.
  const held = spec.slice(spec.indexOf("'lower-zone.fader-held.app.png'") - 1500, spec.indexOf("'lower-zone.fader-held.app.png'"));
  assert.match(held, /page\.mouse\.down\(\)/);
  assert.match(held, /\.locator\('\.cap'\)/);
  assert.doesNotMatch(held, /page\.mouse\.up\(\)/);
  assert.match(read('docs', 'harness', 'test-matrix.md'), /\| m5-ui-port-mixer-strip \|[^\n]*lower-zone\.fader-held\.app\.png/);
});

// ---- m5-ui-port-arrange-canvas: the event display ported from draw(); its gate stays report

test('the event display\'s gate is report, shell.css leaves .arrange to the shared rules, and no marker row is held by a token', () => {
  assert.equal(MANIFEST.gates['m5-ui-port-arrange-canvas'], 'report');
  const shell = read('app', 'renderer', 'shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // ui/project-zone.css's .arrange is the mockup's whole section; the app's
  // arrange body is .arr-body, and shell.css no longer styles .arrange, the
  // old .event-display or the old .zoom-slider.
  for (const selector of ['arrange', 'event-display', 'zoom-slider']) {
    assert.doesNotMatch(shell, new RegExp(`\\.${selector}(?![\\w-])`), `shell.css has no .${selector} rule`);
  }
  // The marker track row is a row the shared rules fix (--marker-h): no hold token.
  assert.doesNotMatch(read('app', 'renderer', 'tokens.css'), /--hold-marker-/);
});

// ---- m5-ui-port-plans: the Plans tab ported (UI redesign 10.10, P1-13)

test('the Plans tab\'s absent parts keep their boxes through hold tokens applied in shell.css, and its gate is report', () => {
  assert.equal(MANIFEST.gates['m5-ui-port-plans'], 'report');
  const tokens = read('app', 'renderer', 'tokens.css');
  const shell = read('app', 'renderer', 'shell.css');
  // The part, its sides, and whether a value is set again per Chinese locale.
  const holds = {
    composer: [['h'], false],
    'tab-media': [['w'], true],
    'tab-meter': [['w'], true],
  };
  for (const [part, [sides, perLocale]] of Object.entries(holds)) {
    assert.equal(MANIFEST.gates[ruleOf(part).gate], 'pending', `${part} is pending`);
    for (const side of sides) {
      const values = [...tokens.matchAll(new RegExp(`--hold-${part}-${side}:\\s*calc\\([\\d.]+px \\* var\\(--scale\\)\\);`, 'g'))];
      assert.ok(values.length >= 1, `--hold-${part}-${side}`);
      if (perLocale) assert.ok(values.length >= 2, `--hold-${part}-${side} is set again for zh-TW and zh-CN`);
      assert.ok(shell.includes(`var(--hold-${part}-${side})`), `shell.css applies --hold-${part}-${side}`);
    }
  }
  if (Object.values(holds).some(([, perLocale]) => perLocale)) assert.match(tokens, /:root:lang\(zh-TW\)[^{]*\{[^}]*--hold-tab-media-w/);
  // The rules the port replaced are gone from shell.css: the old card, the
  // hearing label, the badges by state key, and the right zone's .zone-tabs.
  for (const selector of ['.plan-review', '.plan-list', '.plan-card', '.plan-detail', '.plan-steps-select', '.plan-step ', '.step-label', '.hearing-switch', '.hearing-label', '.badge-', '.plan-diff', '.plan-action', '.plan-landed', '.plan-card-lead']) {
    assert.ok(!shell.includes(selector), `shell.css has no ${selector.trim()} rule`);
  }
  assert.doesNotMatch(shell, /\.zone-right \.zone-tabs|\.plans \.zone-tabs/);
});

test('the chrome\'s gate is report, and the boxes of its absent parts are held by tokens applied in shell.css only', () => {
  assert.equal(MANIFEST.gates['m5-ui-alignment-chrome'], 'report');
  assert.ok(!Object.values(MANIFEST.gates).includes('enforce'), 'no gate is enforce');
  const tokens = read('app', 'renderer', 'tokens.css');
  const holds = {
    'transport-record': ['w', 'h'],
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
  // m5b-ui-signature landed the Sig cell: its gate is report and its hold is gone.
  assert.equal(MANIFEST.gates['m5b-ui-signature'], 'report');
  assert.doesNotMatch(tokens, /--hold-display-signature-w/);
  assert.doesNotMatch(shell, /hold-display-signature/);
});

test('the fidelity run passes the manifest\'s environment as SIANN_FIDELITY_ENVIRONMENT', () => {
  const spec = read('app', 'test', 'e2e', 'mockup-fidelity.spec.ts');
  assert.match(spec, /SIANN_FIDELITY_ENVIRONMENT: JSON\.stringify\(MANIFEST\.environment\)/);
  const main = read('app', 'src', 'main', 'main.ts');
  assert.match(main, /fidelityEnvironmentArgs\(process\.env\)/);
});

test('the runbook, check-all and CI say the fidelity run is a report that never blocks', () => {
  for (const file of [['docs', 'harness', 'runbook.md'], ['scripts', 'check-all.js'], ['.github', 'workflows', 'ci.yml']]) {
    assert.doesNotMatch(read(...file), /[Rr]eport-only until the first gate is enforced|an enforced mismatch fails/, file.join('/'));
    assert.match(read(...file), /decided by the\s+(\/\/ |# )?maintainer,\s+(# )?2026-11-17/, file.join('/'));
  }
  assert.match(read('docs', 'harness', 'runbook.md'), /never fails check-all or CI/);
});

test('check-all runs the app step, and with it the gate, when app/ or the mockup changes', () => {
  assert.deepEqual(stepsForPaths([MANIFEST.mockup]), ['node', 'app']);
  assert.deepEqual(stepsForPaths(['docs/superpowers/specs/2026-11-13-siann-ui-redesign/mockup.png']), ['node', 'app']);
  assert.deepEqual(stepsForPaths(['docs/superpowers/specs/2026-11-13-siann-ui-redesign.md']), ['node']);
  assert.deepEqual(stepsForPaths(['app/renderer/ui/top-bar.css']), ['node', 'app']);
  const text = read('scripts', 'check-all.js');
  assert.match(text, /'playwright', 'test', '--project', 'fidelity'/);
  assert.match(text, /SIANN_FIDELITY: '1'/);
  // A visual aid: a failed run is a note, never a failed step, and nothing reads a gate's mode to decide.
  assert.equal(checkAll.fidelityEnforced, undefined, 'check-all has no enforce switch');
  assert.doesNotMatch(text, /failedAt: `the mockup fidelity gate/);
  assert.match(text, /the mockup fidelity run did not pass \(a report, never blocking\)/);
});

test('CI runs the fidelity run on Windows and Linux as a report and keeps its artifact', () => {
  const ci = read('.github', 'workflows', 'ci.yml');
  const at = ci.indexOf('      - name: Mockup fidelity gate\n');
  assert.ok(at > ci.indexOf('\n  app:\n'), 'the app job has the step');
  const step = ci.slice(at, ci.indexOf('\n      - name: Fidelity report', at));
  assert.match(step, /if: runner\.os != 'macOS'/);
  assert.match(step, /SIANN_FIDELITY: '1'/);
  assert.match(step, /xvfb-run -a npx playwright test --project fidelity/);
  assert.match(ci, /uses: actions\/upload-artifact@v4\n {8}with:\n {10}name: fidelity-\$\{\{ runner\.os \}\}/);
  // Decided by the maintainer, 2026-11-17: the step never fails the job.
  assert.match(step, /continue-on-error: true/, 'the fidelity step never fails the job');
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
  assert.match(rules, /Every UI pull request attaches side-by-side screenshots, and the fidelity run is a report/);
  assert.match(rules, /Not without the maintainer/);
  assert.match(read('docs', 'harness', 'runbook.md'), /\n### UI fidelity gate\n/);
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  assert.match(spec, /\n## 10\. Mockup fidelity\n/);
  assert.match(spec, /do not conflict; they apply at different times/);
  const workflow = read('.claude', 'workflows', 'siann-milestone.js');
  for (const name of ['uiBuild', 'uiVerify', 'uiSpec']) assert.ok(workflow.includes(`\${${name}(f)}`), `the ${name} prompt is used`);
  assert.match(workflow, /mockup fidelity run/);
});

test('the decision of 2026-11-17 is written where contributors read it: ported components, a report, side-by-side screenshots', () => {
  const rules = read('docs', 'harness', 'agent-rules.md');
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  const runbook = read('docs', 'harness', 'runbook.md');
  const matrix = read('docs', 'harness', 'test-matrix.md');
  assert.match(spec, /\n### 10\.9 Decision of 2026-11-17: components are ported, and the gate is a visual aid\n/);
  assert.match(spec, /\n### 10\.10 The component port tickets \(P1-11 to P1-17\)\n/);
  for (const text of [rules, spec]) {
    assert.match(text, /[Dd]ecided by the maintainer, 2026-11-17/);
    assert.match(text, /side-by-side screenshot/);
    // The token layer still blocks, and the absent-part rule stands.
    assert.match(text, /debt\.json`?[^\n]* only shrinks/);
  }
  const s109 = spec.slice(spec.indexOf('\n### 10.9 '), spec.indexOf('\n### 10.10 '));
  assert.match(s109, /supersed/);
  assert.match(s109, /pixel by pixel/);
  assert.match(s109, /An absent part keeps its space empty/);
  // 3.0 still holds: the space stays.
  const s30 = spec.slice(spec.indexOf('\n### 3.0 '), spec.indexOf('\n### 3.1 '));
  assert.match(s30, /is not rendered, and its space stays empty\.\*\*/);
  assert.match(s30, /2026-11-17/);
  // Every feature the two new sections name exists, and every port feature is in the ticket table.
  const s1010 = spec.slice(spec.indexOf('\n### 10.10 '));
  for (const [, id] of `${s109}\n${s1010}`.matchAll(/`(m5b?-[a-z0-9-]+|m6a-[a-z0-9-]+)`/g)) assert.ok(FEATURES.has(id) || DONE.has(id) || REPLACED.includes(id), `${id} is a feature`);
  for (const id of [...PORTS, CLOSING]) assert.match(s1010, new RegExp(`\\| P1-1[1-7] \\| \`${id}\` \\| ${FEATURES.get(id).wave} \\|`), `${id} and its wave in 10.10`);
  // No document still tells a feature to enforce its gate.
  for (const [name, text] of [['agent-rules', rules], ['runbook', runbook], ['test-matrix', matrix]]) {
    assert.doesNotMatch(text, /sets its gate to `enforce`|set(s)? its gate to `enforce`|[Rr]eport-only until/, name);
    assert.match(text, /2026-11-17/, name);
  }
  assert.match(runbook, /never fails check-all or CI/);
  // The human gate records it, and the workflow's prompts ask for the screenshots.
  const gate = milestone('M5').humanGates.find((entry) => entry.id === 'component-port');
  assert.match(gate.resolution, /^Decided by the maintainer, 2026-11-17/);
  assert.match(gate.resolution, /superseding the pixel-identity parts of the decisions of 2026-11-14 and 2026-11-15/);
  for (const id of [...PORTS, CLOSING]) assert.ok(gate.resolution.includes(id.replace('m5-ui-port', '')) || gate.resolution.includes(id), id);
  const workflow = read('.claude', 'workflows', 'siann-milestone.js');
  assert.match(workflow, /side-by-side screenshot/);
  assert.doesNotMatch(workflow, /Blocking: a geometry, computed-style or pixel mismatch/);
  // The meta block stays a pure literal: no call, template or variable in it.
  const meta = workflow.slice(0, workflow.indexOf('\n}\n') + 2);
  assert.match(meta, /^export const meta = \{/);
  assert.doesNotMatch(meta, /\$\{|`|\(\)|\bconst (?!meta)/);
});

test('the decisions of 2026-11-15 are written where contributors read them', () => {
  const rules = read('docs', 'harness', 'agent-rules.md');
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  // An absent part keeps its space empty; "no reserved space" is gone as a rule.
  assert.match(spec, /is not rendered, and its space stays empty\.\*\*/);
  assert.match(rules, /is absent, and it keeps its space empty/);
  assert.match(spec, /\n### 10\.5 Decisions of 2026-11-15\n/);
  assert.match(spec, /\n### 10\.6 The alignment tickets \(P1-9 and P1-10\)\n/);
  for (const text of [rules, spec]) {
    assert.match(text, /[Dd]ecided by the maintainer, 2026-11-15/);
    assert.match(text, /no allowlist/);
    assert.match(text, /JetBrains Mono Medium/);
    assert.doesNotMatch(text, /unowned" in the manifest/);
  }
  // Every feature the manifest or the spec's ownership table names exists, or is one the port replaced.
  for (const [, id] of spec.slice(spec.indexOf('### 10.5 ')).matchAll(/`(m5b?-[a-z0-9-]+|m6a-[a-z0-9-]+)`/g)) assert.ok(FEATURES.has(id) || DONE.has(id) || REPLACED.includes(id), `${id} is a feature`);
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
  // What a pending plan adds to a strip belongs to the ghosts, so the run masks it.
  for (const id of ['strip-7-mute-step-ghost', 'strip-6-gain-step-ghost', 'strip-6-gain-line-ghost', 'strip-4-pan-step-ghost', 'strip-4-pan-value-ghost', 'strip-4-pan-knob-ghost']) {
    assert.equal(ruleOf(id).gate, 'm5b-ui-ghosts', id);
  }
  // m5b-ui-ghosts landed: its parts are measured and reported.
  assert.equal(MANIFEST.gates['m5b-ui-ghosts'], 'report');
  assert.equal(ruleOf('strip-7-mute').gate, 'm5-ui-port-mixer-strip');
  // Decided by Fable, delegated by the maintainer, 2026-11-18 (UI redesign 10.11): e opens the Channel zone.
  assert.equal(ruleOf('strip-7-edit').gate, 'm5b-ui-editor-channel');
});

// Decided by Fable, delegated by the maintainer, 2026-11-18 (UI redesign
// 10.11): the plan phase of M5b found parts no M5b feature can wire to real
// data. Each has an owner whose engine work exists or lands first, so no
// control is rendered that does nothing (UI redesign 3.0).
test('the tools M5b leaves out, the master\'s mute, rack and e, and the strips\' e have the owners of 2026-11-18', () => {
  const owners = {
    'tool-4': 'm5b-ui-edit-more', 'tool-5': 'm5b-ui-edit-more',
    'tool-8': 'm6a-ui-automation',
    'tool-2': 'm6a-ui-tools', 'tool-6': 'm6a-ui-tools', 'tool-7': 'm6a-ui-tools', 'tool-9': 'm6a-ui-tools',
    'strip-master-mute': 'm6c-ui-master-channel', 'strip-master-inserts': 'm6c-ui-master-channel', 'strip-master-edit': 'm6c-ui-master-channel', 'strip-master-buttons': 'm6c-ui-master-channel',
    'strip-master-fader': 'm5b-ui-inserts-master', 'strip-master-cap': 'm5b-ui-inserts-master', 'strip-3-inserts': 'm5b-ui-inserts-master', 'inspector-inserts': 'm5b-ui-inserts-master', 'mixer-racks': 'm5b-ui-inserts-master',
    'strip-3-edit': 'm5b-ui-editor-channel', 'inspector-edit': 'm5b-ui-editor-channel', 'tab-editor': 'm5b-ui-editor-channel',
  };
  for (const [id, gate] of Object.entries(owners)) {
    assert.equal(ruleOf(id).gate, gate, id);
    assert.equal(ruleOf(id).feature, gate, id);
    assert.equal(MANIFEST.gates[gate], 'pending', gate);
    // The acceptance of the owner names the part.
    const text = FEATURES.get(gate).acceptance.join('\n');
    const name = id.replace(/^strip-3-/, 'strip-').replace(/^strip-(inserts|edit)$/, 'strip-');
    assert.ok(text.includes(name), `${gate} names ${id}`);
  }
  assert.equal(FEATURES.get('m6a-ui-tools').milestone, 'M6a');
  assert.equal(FEATURES.get('m6c-ui-master-channel').milestone, 'M6c');
  // The engine work each needs lands in an earlier wave of the same milestone.
  assert.deepEqual(FEATURES.get('m6a-ui-tools').dependsOn, ['m6a-engine-clip-mute']);
  assert.deepEqual(FEATURES.get('m6c-ui-master-channel').dependsOn, ['m6c-engine-master-channel']);
  // m5b-ui-edit-more no longer claims the tools it does not build.
  const editMore = FEATURES.get('m5b-ui-edit-more').acceptance.join('\n');
  assert.match(editMore, /this feature's parts, tool-4 and tool-5, take/);
  assert.doesNotMatch(editMore, /this feature's parts,[^.]*tool-(2|6|7|8|9)/);
  // The features that extend the ghost model wait for it.
  for (const id of ['m5b-ui-fades', 'm5b-ui-markers', 'm5b-ui-sends-buses']) assert.ok(FEATURES.get(id).dependsOn.includes('m5b-ui-ghosts'), id);
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  assert.match(spec, /\n### 10\.11 Decisions of 2026-11-18: the plan phase of M5b\n/);
  assert.match(spec, /decided by Fable, delegated by the maintainer, 2026-11-18/);
});

test('the Plans tab masks only what M5 cannot derive, and each mask names the feature that removes it', () => {
  const dynamic = MANIFEST.pixels.dynamic;
  const masked = (id) => dynamic.some((pattern) => glob(pattern).test(id));
  for (const id of ['plan-step-2-title', 'plan-step-6-title']) assert.ok(masked(id), `${id} is masked`);
  // m5b-ui-plan-metadata shows the titles and the agent's name: the history rows are compared.
  for (const id of ['plan-history-1', 'plan-history-2', 'plan-history-3']) assert.ok(!masked(id), `${id} is compared`);
  // Derived in M5, so compared: the summary chips, the approve button, the steps, the history head.
  for (const id of ['plan-summary', 'plan-approve', 'plan-step-2', 'plan-step-3', 'plan-steps-head', 'plan-history-head', 'plan-card', 'plan-badge']) {
    assert.ok(!masked(id), `${id} is compared`);
    assert.equal(ruleOf(id).gate, 'm5-ui-port-plans', id);
  }
  // The history rows stay parts of the Plans port (boxes and styles); the
  // step titles that name a clip are pending parts of the feature that shows names.
  assert.equal(ruleOf('plan-history-2').gate, 'm5-ui-port-plans');
  assert.equal(ruleOf('plan-step-6-title').gate, 'm5b-ui-media');
  assert.equal(MANIFEST.gates['m5b-ui-media'], 'pending');
  // The mockup marks a title as a part only where it names a clip: steps 2 and 6.
  assert.equal((MOCKUP.match(/\$\{step\(\d,[^\n]*,false,true\)\}/g) || []).length, 2);
  assert.match(MOCKUP, /\$\{step\(2,'Place <b>Pad swell<\/b> on Pad',[^\n]*,false,true\)\}/);
  assert.match(MOCKUP, /\$\{step\(6,'Move <b>Riser<\/b> on FX',[^\n]*,false,true\)\}/);
  const plans = FEATURES.get('m5-ui-port-plans').acceptance.join('\n');
  assert.match(plans, /Approve N of M/);
  assert.match(plans, /count chips/);
  assert.match(plans, /plan-history-1 to plan-history-3/);
  assert.doesNotMatch(plans, /still names the plan by its first step/);
  assert.match(FEATURES.get('m5b-ui-plan-metadata').acceptance.join('\n'), /plan-history-1 to plan-history-3 leave pixels\.dynamic/);
  assert.match(FEATURES.get('m5b-ui-media').acceptance.join('\n'), /plan-step-\*-title leaves pixels\.dynamic/);
});

test('the chrome takes the mockup\'s text formats, and only the fidelity run takes its device and build', () => {
  const chrome = FEATURES.get(CHROME).acceptance.join('\n');
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
  for (const [, id] of spec.slice(spec.indexOf('### 10.7 ')).matchAll(/`(m5b?-[a-z0-9-]+|m6a-[a-z0-9-]+)`/g)) assert.ok(FEATURES.has(id) || DONE.has(id) || REPLACED.includes(id), `${id} is a feature`);
  // Token debt: both changes authorised for the closing feature.
  const closing = FEATURES.get(CLOSING).acceptance.join('\n');
  assert.match(closing, /app-only tokens are added to tokens\.css/);
  assert.match(closing, /conditions of container queries are not counted/);
  assert.match(rules, /App-only tokens in `tokens\.css`[^\n]*\| `m5-ui-port-cleanup`[^|\n]*\|/);
  // The 2 px focus ring's token was applied early in m5-ui-tokens-spacing (10.7, 4a).
  assert.match(rules, /App-only tokens in `tokens\.css`[^\n]*the 2 px focus ring \(`--focus-ring`, 55 %\) applied early in `m5-ui-tokens-spacing`/);
  assert.match(spec, /applied early in `m5-ui-tokens-spacing` by the main session under the maintainer's 2026-11-15 authorisation 4a/);
  // A landed part that can be absent at runtime: a permanent width token, not a hold.
  assert.match(FEATURES.get('m5-ui-loop-click').acceptance.join('\n'), /its box keeps the width of --display-locators-empty-w/);
  assert.match(rules, /`--<part>-empty-w` token[^\n]*\| `--display-locators-empty-w`, in `m5-ui-loop-click`; `--dsp-load-empty-w` and `--tab-meter-empty-w`, in `m5b-ui-meter`; `--tab-media-empty-w`, in `m5b-ui-media` \|/);
  assert.match(FEATURES.get('m5b-ui-meter').acceptance.join('\n'), /keep the widths of --dsp-load-empty-w and --tab-meter-empty-w/);
  assert.match(FEATURES.get('m5b-ui-media').acceptance.join('\n'), /the empty box of tab-media keeps the width of --tab-media-empty-w/);
  assert.match(spec, /permanent `--<part>-empty-w` token/);
  assert.equal(ruleOf('display-locators').gate, CHROME);
  // The mixer's acceptance does not bend around the mockup's two corrected mistakes.
  const mixer = FEATURES.get('m5-ui-port-mixer-strip').acceptance.join('\n');
  assert.match(mixer, /the taper is unchanged \(mixer\/taper\.ts, UI redesign 4\.5 C7/);
  assert.match(mixer, /Every strip has the same button row: M, S and the empty box of e/);
  // Clip titles come from the media's name in M5.
  assert.match(FEATURES.get('m5-ui-port-arrange-canvas').acceptance.join('\n'), /shows the media's name \(media\.name/);
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
  assert.match(block(1300), /\[data-part="branch-chip"\], \.hold-dsp-load, \.hold-transport-record \{ display: none; \}/);
  assert.match(block(1100), /\.brand \{ display: none; \}/);
  assert.match(block(1100), /\.lcd \.cell\[data-part="display-signature"\]/);
});

// ---- m5-ui-port-inspector (UI redesign 10.10, P1-14): the left zone ported from the mockup's template

test('the Inspector port links ui/left-zone.css in the mockup\'s order, its gate is report, and its holds name pending parts', () => {
  const linked = (html) => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  const app = linked(read('app', 'renderer', 'index.html'));
  assert.ok(app.includes('ui/left-zone.css'), 'index.html links ui/left-zone.css');
  assert.ok(app.indexOf('ui/top-bar.css') < app.indexOf('ui/left-zone.css') && app.indexOf('ui/left-zone.css') < app.indexOf('ui/project-zone.css'), 'in the mockup\'s order');
  assert.equal(MANIFEST.gates['m5-ui-port-inspector'], 'report');
  // The three open sections are held by tokens until their features land; each names a pending part.
  const tokens = read('app', 'renderer', 'tokens.css');
  const holds = [...tokens.matchAll(/--hold-(inspector-[a-z0-9-]+)-h\s*:/g)].map((m) => m[1]).sort();
  assert.deepEqual(holds, ['inspector-inserts', 'inspector-routing']);
  for (const id of holds) assert.equal(MANIFEST.gates[ruleOf(id).gate], 'pending', id);
  // The temporary pre-port rules #136 kept for the Inspector are gone.
  const shell = read('app', 'renderer', 'shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(shell, /\.inspector \.ms\b|\.inspector \.value-readout|\.inspector-row|\.value-control|\.fader-cap/);
});

// ---- m5-ui-port-toolbar (UI redesign 10.10, P1-16): the toolbar and the info line ported from the mockup's template

test('the toolbar port: its gate is report, its holds name pending parts and shell.css applies them, the old toolbar rules are gone', () => {
  assert.equal(MANIFEST.gates['m5-ui-port-toolbar'], 'report');
  const tokens = read('app', 'renderer', 'tokens.css');
  // The en values, and the Chinese ones of the pill and the fades.
  const holds = [...new Set([...tokens.matchAll(/--hold-((?:tool|proposal|info)-[a-z0-9-]+)-w\s*:/g)].map((m) => m[1]))].sort();
  assert.deepEqual(holds, ['info-fade-in', 'info-fade-out', 'tool-2', 'tool-4', 'tool-5', 'tool-6', 'tool-7', 'tool-8', 'tool-9']);
  for (const id of holds) {
    assert.equal(MANIFEST.gates[ruleOf(id).gate], 'pending', id);
    assert.match(tokens, new RegExp(`--hold-${id}-w:\\s*calc\\([\\d.]+px \\* var\\(--scale\\)\\);`), `--hold-${id}-w`);
  }
  const shell = read('app', 'renderer', 'shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const id of holds) assert.ok(shell.includes(`var(--hold-${id}-w)`), `shell.css applies --hold-${id}-w`);
  // The pre-port toolbar and info line rules are removed.
  assert.doesNotMatch(shell, /\.timeline-bar\b|\.info-line\b|\.info-field\b|\.media-pool\b|\.tool-buttons\b|\.snap-controls\b|\.grid-type\s*\{|\.snap-toggle\b/);
  // No second rule for what ui/project-zone.css draws: outside the button
  // reset's :where()/:not() lists, no selector of shell.css names them.
  let bare = shell;
  while (/\([^()]*\)/.test(bare)) bare = bare.replace(/\([^()]*\)/g, '');
  const selectors = [...bare.matchAll(/([^{}]+)\{/g)].map((m) => m[1]);
  for (const name of ['arr-toolbar', 'seg', 'b', 'field', 'spacer', 'infoline', 'f']) {
    assert.deepEqual(selectors.filter((s) => new RegExp(`\\.${name}(?![\\w-])`).test(s)), [], `no .${name} rule in shell.css`);
  }
});

test('shell.css\'s pinned pre-port text styles do not reach the ported project zone', () => {
  const shell = read('app', 'renderer', 'shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...shell.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /letter-spacing:\s*normal/.test(m[2]) || /font-feature-settings:\s*normal/.test(m[2]))
    .map((m) => m[1].trim());
  // The project zone's element: section.zone.zone-project (Shell.tsx, ZoneFrame).
  const project = new Set(['zone', 'zone-project']);
  for (const list of rules) {
    for (const selector of list.split(/,(?![^()]*\))/).map((s) => s.trim())) {
      if (/[\s>+~]/.test(selector)) continue;
      const excluded = [...selector.matchAll(/:not\(\s*\.([\w-]+)\s*\)/g)].map((m) => m[1]);
      const required = [...selector.replace(/:(?:not|where|is)\((?:[^()]|\([^()]*\))*\)/g, '').matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
      const reaches = required.every((c) => project.has(c)) && excluded.every((c) => !project.has(c));
      assert.ok(!reaches, `"${selector}" in shell.css pins pre-port text styles on the project zone`);
    }
  }
});

// ---- m5-ui-port-cleanup (UI redesign 10.10, P1-17): the port closed

// The rules of a stylesheet as { selector, at } pairs: each selector of a
// rule's list, whitespace normalised (runs of space collapsed, none around a
// combinator or inside parentheses), with the prelude of the at-rule that
// encloses it ('' at the top level). The steps of @keyframes are not selectors.
function cssRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const normal = (s) => s.trim().replace(/\s+/g, ' ').replace(/\s*([>+~])\s*/g, '$1').replace(/\(\s*/g, '(').replace(/\s*\)/g, ')').replace(/\s*,\s*/g, ',');
  const split = (list) => {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i] === '(') depth++;
      else if (list[i] === ')') depth--;
      else if (list[i] === ',' && depth === 0) {
        out.push(list.slice(start, i));
        start = i + 1;
      }
    }
    out.push(list.slice(start));
    return out.map(normal).filter(Boolean);
  };
  const rules = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ';') start = i + 1;
    else if (c === '}') {
      stack.pop();
      start = i + 1;
    } else if (c === '{') {
      const prelude = text.slice(start, i).trim();
      if (prelude.startsWith('@')) {
        stack.push(prelude.replace(/\s+/g, ' '));
        start = i + 1;
        continue;
      }
      if (!stack.some((at) => at.startsWith('@keyframes'))) {
        for (const selector of split(prelude)) rules.push({ selector, at: stack.join(' ') });
      }
      // A rule's body holds no braces: skip to its end.
      i = text.indexOf('}', i);
      start = i + 1;
    }
  }
  return rules;
}

const UI_RULES = () => fs.readdirSync(path.join(ROOT, 'app', 'renderer', 'ui')).filter((f) => f.endsWith('.css')).flatMap((f) => cssRules(read('app', 'renderer', 'ui', f)));
// A narrow-window state the mockup does not show: a rule inside a media or a
// container query (acceptance 1 and UI redesign 10.7 allow it).
const NARROW = (rule) => /^@(media|container)\b/.test(rule.at);

// shell.css holds nothing the mockup draws: no selector of it is also a
// selector of app/renderer/ui (acceptance 1).
function collisions(shellCss, uiRules) {
  const ui = new Set(uiRules.map((rule) => rule.selector));
  return cssRules(shellCss).filter((rule) => !NARROW(rule) && ui.has(rule.selector)).map((rule) => rule.selector);
}

test('no selector of shell.css is also styled by app/renderer/ui', () => {
  const ui = UI_RULES();
  assert.ok(ui.length > 200, `${ui.length} selectors in app/renderer/ui`);
  assert.deepEqual(collisions(read('app', 'renderer', 'shell.css'), ui), [], 'requalify the rule by the app-only element or state it serves, or delete it');
  // The parser: lists split at the top level only, whitespace normalised,
  // at-rules recorded, keyframe steps skipped.
  assert.deepEqual(cssRules('/* .x{} */ .a > .b,\n .c:not(.d, .e){x:1} @media (max-width: 10px){ .f{y:2} } @container (max-width: 5px){.g  .h{z:3}} @keyframes k{from{a:b}to{a:c}} i{j:k}'), [
    { selector: '.a>.b', at: '' },
    { selector: '.c:not(.d,.e)', at: '' },
    { selector: '.f', at: '@media (max-width: 10px)' },
    { selector: '.g .h', at: '@container (max-width: 5px)' },
    { selector: 'i', at: '' },
  ]);
  // It catches a collision however the selector is spaced, and exempts a narrow-window state.
  const shared = cssRules('.statusbar .loc{display:flex}.a>.b{x:1}*{box-sizing:border-box}');
  assert.deepEqual(collisions('.statusbar  .loc { position: relative; } .a > .b {y:2} *, *::before { box-sizing: border-box; } @media (max-width: 9px) { .a > .b { z: 3; } } .statusbar .loc:has(select) { q: 1; }', shared), ['.statusbar .loc', '.a>.b', '*']);
});

// The properties each top-level rule of a stylesheet sets, by selector (as
// cssRules normalises it); the rules inside an at-rule are left out.
function topLevelProperties(css) {
  const out = new Map();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      const prelude = text.slice(start, i).trim();
      const end = text.indexOf('}', i);
      if (depth === 0 && !prelude.startsWith('@')) {
        const props = [...text.slice(i + 1, end).matchAll(/(?:^|;)\s*([\w-]+)\s*:/g)].map((m) => m[1]);
        for (const { selector } of cssRules(`${prelude}{}`)) out.set(selector, [...(out.get(selector) || []), ...props]);
        i = end;
      } else if (prelude.startsWith('@')) {
        depth++;
      } else {
        i = end;
      }
      start = i + 1;
    } else if (text[i] === '}') {
      depth = Math.max(0, depth - 1);
      start = i + 1;
    } else if (text[i] === ';' && depth === 0) {
      start = i + 1;
    }
  }
  return out;
}

// The zone frame is the mockup's region element, styled by the shared rules
// (UI redesign 10.9, 1): aside.leftzone, section.arrange, section.lower and
// aside.plans. shell.css's frame classes (.zone, .zone-<zone>) add only what
// the app needs around them (clipping, shrinking, the focus frame of the
// zones the mockup does not show focused) and restate no property of the
// region's own rule; the project zone's rows, background and focus frame are
// .arrange's and .arrange::after's, with no app wrapper between the section
// and its toolbar, info line and arrange body.
const FRAME_REGIONS = {
  '.zone': ['.leftzone', '.arrange', '.lower', '.plans'],
  '.zone-left': ['.leftzone'],
  '.zone-project': ['.arrange'],
  '.zone-lower': ['.lower'],
  '.zone-right': ['.plans'],
};
function restated(shellCss, uiCss) {
  const shell = topLevelProperties(shellCss);
  const ui = topLevelProperties(uiCss);
  const out = [];
  for (const [frame, regions] of Object.entries(FRAME_REGIONS)) {
    for (const prop of shell.get(frame) || []) {
      for (const region of regions) if ((ui.get(region) || []).includes(prop)) out.push(`${frame} ${prop} (${region})`);
    }
  }
  return out;
}

test('the zone frame is the mockup\'s region element: shell.css restates none of its rules', () => {
  const uiCss = fs.readdirSync(path.join(ROOT, 'app', 'renderer', 'ui')).filter((f) => f.endsWith('.css')).map((f) => read('app', 'renderer', 'ui', f)).join('\n');
  const shellCss = read('app', 'renderer', 'shell.css');
  assert.deepEqual(restated(shellCss, uiCss), [], 'the region\'s shared rule draws it: delete the property from the frame rule');
  // The project zone is section.arrange, its children the toolbar, the info line and the arrange body.
  const shellTsx = read('app', 'src', 'renderer', 'shell', 'Shell.tsx');
  assert.match(shellTsx, /project: 'arrange zone zone-project',/);
  const shell = shellCss.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.zone-project\s*>?\s*\.zone-body/.test(shell), 'no app body inside the project zone');
  assert.ok(!/grid-template-rows:\s*var\(--toolbar\)/.test(shell), '.arrange lays out the project zone\'s rows');
  assert.ok(!/\.zone-lower\s*>\s*\.tabs/.test(shell), '.lower lays out the lower zone\'s tab row');
  // The focus frame: .arrange::after for the project zone, shown only while it has the focus;
  // an outline for the others, which the mockup does not show focused.
  const props = topLevelProperties(shellCss);
  assert.deepEqual(props.get('.zone-project:not([data-focused="true"])::after'), ['display']);
  assert.ok(!props.has('.zone[data-focused="true"]'), 'no outline frame on the project zone');
  for (const zone of ['left', 'lower', 'right']) assert.ok((props.get(`.zone-${zone}[data-focused="true"]`) || []).includes('outline'), zone);
  // The detector: a restated property is found, a rule inside a query and a qualified one are not.
  assert.deepEqual(
    restated('.zone { display: flex; overflow: hidden; } .zone-lower { min-height: 0; } .zone[hidden] { display: none; } @media (max-width: 9px) { .zone-left { background: red; } }', '.leftzone{display:flex;background:red}.lower{min-height:0}.arrange{display:grid}'),
    ['.zone display (.leftzone)', '.zone display (.arrange)', '.zone-lower min-height (.lower)'],
  );
});

test('shell.css names tokens only and holds nothing pinned for unported zones', () => {
  const shell = read('app', 'renderer', 'shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // The pre-port text styles pinned on the zones not ported yet are gone: every zone is ported.
  for (const zone of ['zone-lower', 'zone-left', 'zone-project', 'plans']) {
    assert.ok(!new RegExp(`:not\\(\\.${zone}\\)`).test(shell), `no rule pinned on the zones other than .${zone}`);
  }
  // Every value is a token: no colour and no size literal (test/ui-tokens.test.js counts them),
  // and no var() names a custom property tokens.css does not declare, except the ones the app sets on an element.
  const declared = new Set([...read('app', 'renderer', 'tokens.css').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const set = new Set([...shell.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const local = ['--c', '--zoom-at', '--drawer-width'];
  for (const m of shell.matchAll(/var\((--[\w-]+)/g)) assert.ok(declared.has(m[1]) || set.has(m[1]) || local.includes(m[1]), `shell.css names ${m[1]}, which tokens.css does not declare`);
  // The header says what is left, and nothing is "not ported yet".
  assert.doesNotMatch(read('app', 'renderer', 'shell.css'), /not ported yet|until their alignment/);
  // No comment sits inside a selector.
  assert.doesNotMatch(read('app', 'renderer', 'shell.css'), /[>+~,]\s*\/\*[^*]*\*\/\s*[.#\w]/);
});

// ---- no leftover class: what the renderer emits and what the stylesheets style

const RENDERER_SRC = path.join(ROOT, 'app', 'src', 'renderer');

function rendererSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // The token mirror and the catalogs hold no class names.
      else if (/\.tsx?$/.test(entry.name) && entry.name !== 'tokens.ts' && !full.includes(`${path.sep}i18n${path.sep}`)) out.push(full);
    }
  };
  walk(RENDERER_SRC);
  return out.sort().map((file) => ({ file: path.relative(ROOT, file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1') }));
}

// The end of the expression that starts at `i` (after an opening `{`, `(` or
// `[`, or a template's `${`): the index of its closing bracket, skipping strings.
function closeOf(text, i, open = '{', close = '}') {
  let depth = 1;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "'" || c === '"') j = endOfQuote(text, j);
    else if (c === '`') j = endOfTemplate(text, j);
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return j;
  }
  throw new Error(`unclosed ${open} at ${i}: ${text.slice(i - 20, i + 60)}`);
}
function endOfQuote(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === text[i]) return j;
  }
  throw new Error(`unclosed string at ${i}`);
}
function endOfTemplate(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '$' && text[j + 1] === '{') j = closeOf(text, j + 2);
    else if (text[j] === '`') return j;
  }
  throw new Error(`unclosed template at ${i}`);
}

// What a class-name expression can produce: the words of its string literals
// and of its templates' static parts, the values of the literal tables it
// looks up (`TABLE[key]`), of the *Class() helpers it calls and of the local
// constant it names. A template that glues a name to a value the scan cannot
// enumerate (`zone-${zone}`, `${name}`) is reported: the class is computed,
// and the scan would miss it. Strings compared (`x === 'a'`) or passed to a
// call (`.join(' ')`) are not classes.
function classesOf(expr, ctx, out) {
  let code = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" || c === '"') {
      const end = endOfQuote(expr, i);
      const before = expr.slice(0, i).trimEnd();
      const after = expr.slice(end + 1).trimStart();
      if (!/(===|!==|==|!=|\w\()$/.test(before) && !/^(===|!==|==|!=)/.test(after)) out.words.push(...expr.slice(i + 1, end).split(/\s+/));
      code += '0';
      i = end;
    } else if (c === '`') {
      const end = endOfTemplate(expr, i);
      let chunk = '';
      for (let j = i + 1; j < end; j++) {
        if (expr[j] === '$' && expr[j + 1] === '{') {
          const close = closeOf(expr, j + 2);
          const hole = expr.slice(j + 2, close).trim();
          const glued = /[\w-]$/.test(chunk) || /^[\w-]/.test(expr.slice(close + 1, end));
          const bare = /^[a-z_$][\w$.]*(\[[^\]]*\])?$/.test(hole);
          if (bare) out.computed.push(`${ctx.file}: \`...\${${hole}}...\``);
          else if (glued && !/^[^?]+\?\s*'( [^']*)?'\s*:\s*'( [^']*)?'$/.test(hole)) out.computed.push(`${ctx.file}: \`${chunk}\${${hole}}\``);
          out.words.push(...chunk.split(/\s+/));
          chunk = '';
          if (!bare) classesOf(hole, ctx, out);
          j = close;
        } else chunk += expr[j];
      }
      out.words.push(...chunk.split(/\s+/));
      code += '0';
      i = end;
    } else code += c;
  }
  for (const m of code.matchAll(/\b([A-Z][A-Z0-9_]*)\[/g)) tableOf(m[1], ctx, out);
  for (const m of code.matchAll(/\b(\w+Class)\(/g)) {
    const fn = ctx.sources.map((s) => ({ s, at: s.text.search(new RegExp(`function ${m[1]}\\(`)) })).find((x) => x.at >= 0);
    assert.ok(fn, `${ctx.file}: no function ${m[1]} in the renderer`);
    const open = fn.s.text.indexOf('{', fn.s.text.indexOf(')', fn.at));
    classesOf(fn.s.text.slice(open + 1, closeOf(fn.s.text, open + 1)).replace(/\breturn\b/g, ''), { ...ctx, file: fn.s.file }, out);
  }
  const bare = code.trim();
  if (/^[a-z]\w*$/.test(bare) && bare !== 'className') {
    // A local constant: what it is built from.
    const source = ctx.sources.find((s) => s.file === ctx.file);
    const decl = new RegExp(`\\bconst ${bare}(?::[^=]+)? = `).exec(source.text);
    if (!decl) out.computed.push(`${ctx.file}: className={${bare}}`);
    else classesOf(source.text.slice(decl.index + decl[0].length, source.text.indexOf(';\n', decl.index)), ctx, out);
  }
}

// The values of a literal table, `const NAME: Record<K, string> = { k: 'v', ... };`.
function tableOf(name, ctx, out) {
  const source = ctx.sources.find((s) => new RegExp(`\\bconst ${name}\\b[^=]*= \\{`).test(s.text));
  assert.ok(source, `${ctx.file}: no literal table ${name} in the renderer`);
  const at = source.text.search(new RegExp(`\\bconst ${name}\\b[^=]*= \\{`));
  const open = source.text.indexOf('= {', at) + 2;
  const body = source.text.slice(open + 1, closeOf(source.text, open + 1));
  const values = [...body.matchAll(/:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.ok(values.length > 0, `${name} holds string values`);
  for (const v of values) out.words.push(...v.split(/\s+/));
}

// Every class the renderer emits: the className attributes of its TSX, what
// they look up, and the classes its .ts code toggles.
function emittedClasses() {
  const sources = rendererSources();
  const out = { words: [], computed: [] };
  for (const source of sources) {
    const ctx = { file: source.file, sources };
    for (const m of source.text.matchAll(/\bclassName=(?:"([^"]*)"|\{)/g)) {
      if (m[1] !== undefined) out.words.push(...m[1].split(/\s+/));
      else classesOf(source.text.slice(m.index + m[0].length, closeOf(source.text, m.index + m[0].length)), ctx, out);
    }
    for (const m of source.text.matchAll(/classList\??\.(?:add|remove|toggle)\(\s*'([^']+)'/g)) out.words.push(m[1]);
  }
  return { classes: new Set(out.words.filter(Boolean)), computed: out.computed };
}

const selectorClasses = (rules) => new Set(rules.flatMap((rule) => [...rule.selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1])));

test('no leftover class: every class the renderer emits is styled, and every class of shell.css is emitted', () => {
  const { classes, computed } = emittedClasses();
  // The scan is exact: no class name is computed from a value it cannot enumerate.
  assert.deepEqual(computed, [], 'build the class from a literal table (const NAME = { key: \'class\' })');
  for (const name of ['app', 'zone', 'zone-lower', 'zone-project', 'zone-left', 'zone-right', 'divider-left', 'divider-right', 'divider-lower', 'hold-tool-2', 'hold-tool-9', 'strip', 'msr', 'badge', 'rolled-back', 'clip', 'shut', 'overlaypill']) {
    assert.ok(classes.has(name), `the scan finds .${name}`);
  }
  for (const name of classes) assert.match(name, /^-?[_a-zA-Z][\w-]*$/, `"${name}" is a class name`);
  const ui = selectorClasses(UI_RULES());
  const shellRules = cssRules(read('app', 'renderer', 'shell.css'));
  const shell = selectorClasses(shellRules);
  // (b) Each class the renderer emits has a rule, in app/renderer/ui or shell.css.
  assert.deepEqual([...classes].filter((name) => !ui.has(name) && !shell.has(name)).sort(), [], 'classes the renderer emits that no stylesheet styles');
  // (c) Each class of a shell.css selector is one the renderer emits.
  assert.deepEqual([...shell].filter((name) => !classes.has(name)).sort(), [], 'classes of shell.css no renderer source emits');
  // The scan itself: a glued computed name is reported, a conditional suffix and a table are not.
  const probe = { words: [], computed: [] };
  const sources = [{ file: 'probe.tsx', text: "const ZONES = { a: 'zone-a', b: 'zone-b' };\nconst classes = ['x', on ? 'y' : ''].join(' ');\n" }];
  for (const expr of ['`zone zone-${zone}`', '`${name}`', '`tab${on ? \' on\' : \'\'}`', '`zone ${ZONES[zone]}`', 'classes', "side === 'main' ? 'b on' : 'b'"]) classesOf(expr, { file: 'probe.tsx', sources }, probe);
  assert.deepEqual(probe.computed, ['probe.tsx: `...${zone}...`', 'probe.tsx: `...${name}...`']);
  assert.deepEqual([...new Set(probe.words.filter(Boolean))].sort(), ['b', 'on', 'tab', 'x', 'y', 'zone', 'zone-', 'zone-a', 'zone-b']);
});

// Acceptance 4 and 5: the gates of M5's parts are report, for good.
test('every gate of an M5 feature is report, none is enforce, every rule has an owner and every hold names a pending part', () => {
  const m5 = ['m5-ui-alignment-chrome', 'm5-ui-port-arrange-canvas', 'm5-ui-port-track-list', 'm5-ui-port-toolbar', 'm5-ui-port-mixer-strip', 'm5-ui-port-inspector', 'm5-ui-port-plans'];
  assert.deepEqual([CHROME, ...PORTS].sort(), [...m5].sort());
  for (const gate of m5) assert.equal(MANIFEST.gates[gate], 'report', gate);
  assert.deepEqual(Object.keys(MANIFEST.gates).filter((gate) => gate.startsWith('m5-')).sort(), [...m5].sort(), 'M5\'s gates are these seven');
  assert.deepEqual(Object.entries(MANIFEST.gates).filter(([, mode]) => mode === 'enforce'), [], 'no gate is enforce');
  for (const rule of MANIFEST.rules) assert.ok(rule.feature && rule.gate && FEATURES.has(rule.gate), `${rule.match.join(', ')} has an owner`);
  const holds = [...read('app', 'renderer', 'tokens.css').matchAll(/--hold-([a-z0-9-]+)-[wh]\s*:/g)].map((m) => m[1]);
  assert.ok(holds.length > 10, `${holds.length} hold tokens`);
  for (const id of holds) assert.equal(MANIFEST.gates[ruleOf(id).gate], 'pending', `--hold-${id}: its part's gate is pending`);
});

// Acceptance 5: the documents describe the port as finished for M5's parts.
test('the rules, the runbook and the test matrix describe the component port as finished for M5\'s parts', () => {
  const rules = read('docs', 'harness', 'agent-rules.md');
  const runbook = read('docs', 'harness', 'runbook.md');
  const matrix = read('docs', 'harness', 'test-matrix.md');
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  for (const [name, text] of [['agent-rules', rules], ['runbook', runbook], ['test-matrix', matrix]]) {
    assert.match(text, /[Tt]he component port is finished for M5's parts/, name);
  }
  // The ledger is empty and required empty; nothing says what "does not hold yet".
  assert.doesNotMatch(rules, /the ledger of what does not hold yet/);
  assert.match(rules, /`app\/test\/fidelity\/debt\.json` is empty/);
  assert.match(runbook, /`app\/test\/fidelity\/debt\.json` is empty/);
  // The matrix's row for the closing feature names its tests per acceptance item.
  assert.doesNotMatch(matrix, /m5-ui-port-cleanup \(open\)/);
  const row = /\n\| m5-ui-port-cleanup \|[^\n]*/.exec(matrix)?.[0] ?? '';
  for (const name of ['ui-tokens', 'mockup-fidelity', 'port-cleanup', 'i18n-catalogs', 'shell.spec']) assert.ok(row.includes(name), `the matrix row names ${name}`);
  // Spec 10.10 records that P1-17 landed.
  const s1010 = spec.slice(spec.indexOf('\n### 10.10 '));
  assert.match(s1010, /P1-17 \(`m5-ui-port-cleanup`\) landed/);
});

// ---- m5b-ui-plan-metadata: the agent row, the plan's title and intent

test("the plan metadata's gate is report, its holds are gone, and shell.css sizes its empty boxes by calc() of tokens", () => {
  assert.equal(MANIFEST.gates['m5b-ui-plan-metadata'], 'report');
  for (const id of ['agent-row', 'plan-title', 'plan-intent']) assert.equal(ruleOf(id).gate, 'm5b-ui-plan-metadata', id);
  const tokens = read('app', 'renderer', 'tokens.css');
  for (const hold of ['--hold-agent-row-h', '--hold-plan-title-h', '--hold-plan-intent-h']) assert.ok(!tokens.includes(hold), `${hold} is deleted`);
  const shell = read('app', 'renderer', 'shell.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const old of ['.hold-agent-row', '.hold-plan-title', '.hold-plan-intent']) assert.ok(!shell.includes(old), `no ${old} rule`);
  const heights = {
    'agent-row-empty': /^calc\(\s*2 \* var\(--space-2\) \+ var\(--agent-avatar\) \+ var\(--hairline\)\s*\)$/,
    'plan-title-empty': /^calc\(\s*var\(--space-2\) \+ var\(--space\) \+ 1\.3 \* var\(--fs-plan\)\s*\)$/,
    'plan-intent-empty': /^calc\(\s*2 \* 1\.45 \* var\(--fs-11h\)\s*\)$/,
  };
  for (const [cls, want] of Object.entries(heights)) {
    const rule = new RegExp(`(?:^|\\})\\s*\\.${cls}\\s*\\{([^}]*)\\}`).exec(shell);
    assert.ok(rule, `shell.css has a .${cls} rule of its own`);
    const height = /(?:^|;)\s*height:\s*([^;]+)/.exec(rule[1])?.[1].trim();
    assert.match(height ?? '', want, `.${cls}'s height`);
    assert.doesNotMatch(rule[1], /\d(px|rem|em)|--hold-/, `.${cls} names tokens only`);
  }
  // A shorter intent keeps the two lines, so the chips do not move.
  assert.match(shell, /\.card-h p\[data-part="plan-intent"\]\s*\{[^}]*min-height:\s*calc\(\s*2 \* 1\.45 \* var\(--fs-11h\)\s*\)/);
  // The history rows are unmasked (UI redesign 10.7, 3).
  assert.ok(!MANIFEST.pixels.dynamic.some((pattern) => /plan-history/.test(pattern)), 'no plan-history mask');
});

// ---- m5b-ui-ghosts (UI redesign 4.2, 10.4): the ghosts, the proposal pill and
// the Inspector's Agent changes landed, so their gate is report and their
// holds are gone; the pill needs no box when absent, so no empty-width token
// replaces its hold (UI redesign 3.0).
test("m5b-ui-ghosts: the gate is report, the pill's and the Agent changes' holds are gone, and every ghost id is the ghosts'", () => {
  assert.equal(MANIFEST.gates['m5b-ui-ghosts'], 'report');
  const tokens = read('app', 'renderer', 'tokens.css');
  const shell = read('app', 'renderer', 'shell.css');
  for (const name of ['--hold-proposal-pill-w', '--hold-inspector-agent-changes-h', '--proposal-pill-empty-w']) {
    assert.ok(!tokens.includes(name), `${name} is not in tokens.css`);
    assert.ok(!shell.includes(name), `${name} is not in shell.css`);
  }
  assert.doesNotMatch(shell, /\.hold-proposal-pill|\.inspector-hold\.agent-changes/);
  // The mockup's ids and the ones a later proposed track takes (ghost-2, ghost-3) are the ghosts'.
  for (const id of ['track-ghost', 'track-ghost-name', 'lane-ghost', 'strip-ghost', 'strip-ghost-inserts', 'clip-ghost-new', 'clip-ghost-move', 'strip-6-cap-ghost', 'strip-6-gain-line-ghost', 'strip-7-mute-step-ghost', 'strip-4-pan-knob-ghost',
    'track-ghost-2', 'track-ghost-2-name', 'lane-ghost-3', 'strip-ghost-2', 'strip-ghost-2-inserts', 'strip-ghost-2-name', 'clip-ghost-new-2', 'locator-band-ghost', 'proposal-pill', 'inspector-agent-changes']) {
    assert.equal(ruleOf(id).gate, 'm5b-ui-ghosts', id);
  }
});

// ---- m5b-ui-audition (UI redesign 4.3, 2.4, 10.4): the branch chip landed, so
// its gate is report and its hold is gone; it is always rendered while a head
// revision is known, so no empty-width token replaces the hold (3.0). The
// violet frame and the solid ghosts are app-only rules of shell.css on
// existing tokens: the frame's 2 px is --space-half, its colour --ai.
test('m5b-ui-audition: the gate is report, the branch chip\'s hold is gone, and the frame is drawn on existing tokens', () => {
  assert.equal(MANIFEST.gates['m5b-ui-audition'], 'report');
  assert.equal(ruleOf('branch-chip').gate, 'm5b-ui-audition');
  const tokens = read('app', 'renderer', 'tokens.css');
  const shell = read('app', 'renderer', 'shell.css');
  for (const name of ['--hold-branch-chip-w', '--branch-chip-empty-w']) {
    assert.ok(!tokens.includes(name), `${name} is not in tokens.css`);
    assert.ok(!shell.includes(name), `${name} is not in shell.css`);
  }
  assert.doesNotMatch(shell, /hold-branch-chip/);
  assert.doesNotMatch(read('app', 'src', 'renderer', 'tokens.ts'), /hold-branch-chip/);
  assert.match(shell, /\.app\[data-hearing="proposal"\]::after\s*\{[^}]*border:\s*var\(--space-half\) solid var\(--ai\)/);
  assert.match(shell, /\[data-ghost-mode="solid"\]/);
  // A proposed track's header and strip lose the shared rules' hatch while
  // heard: their body is the ghost tint, unhatched (UI redesign 4.3).
  const unhatched = /\.th\.ghost\[data-ghost-mode="solid"\],\s*\.strip\.ghost\[data-ghost-mode="solid"\]\s*\{[^}]*background:\s*linear-gradient\(var\(--ai-a100\), var\(--ai-a100\)\), var\(--bg-alt\)/;
  assert.match(shell, unhatched);
  // The chip gives way before the session's name: while it is in the left
  // group, the name does not shrink (above 1300 px, where the chip shows).
  assert.match(shell, /\.tb-left:has\(> \[data-part="branch-chip"\]\) > \.session\s*\{\s*flex-shrink:\s*0;\s*\}/);
});

// The state before the first snapshot is exempt from the empty box (UI
// redesign 3.0; 10.11, 15: decided by Fable, delegated by the maintainer,
// 2026-11-19): the session name is empty and the branch chip is absent, and
// no permanent token is authorised for the chip.
test('m5b-ui-audition: before the first snapshot the chip is exempt from the empty box, in the spec and the agent rules, with no token', () => {
  const spec = read('docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign.md');
  const rules = read('docs', 'harness', 'agent-rules.md');
  const rule = spec.slice(spec.indexOf('### 3.0 '), spec.indexOf('### 3.1 '));
  assert.match(rule, /\n  - Before the first snapshot nothing is held\.[^\n]*session name is empty[^\n]*branch chip[^\n]*no `--branch-chip-empty-w` exists \(10\.11, 15\)/);
  assert.match(rule, /\n  - Before the first snapshot[^\n]*covers that state only/);
  const decisions = spec.slice(spec.indexOf('### 10.11 '));
  assert.match(decisions, /\n\*\*15\. The branch chip before the first snapshot is exempt from the empty box\*\* \(`m5b-ui-audition`\)[^\n]*Decided by Fable, delegated by the maintainer, 2026-11-19\.\n/);
  assert.match(rules, /The state before the first snapshot is exempt \(spec 3\.0; 10\.11, 15\)[^\n]*no `--branch-chip-empty-w`/);
  assert.match(rules, /decided by Fable, delegated by the maintainer, 2026-11-19 \(spec 10\.11, 15\)/);
  // The table of authorised permanent tokens does not name the chip.
  assert.doesNotMatch(rules, /\| A permanent `--<part>-empty-w` token[^\n]*branch-chip/);
  for (const file of [['app', 'renderer', 'tokens.css'], ['app', 'renderer', 'shell.css'], ['app', 'src', 'renderer', 'tokens.ts']]) assert.doesNotMatch(read(...file), /branch-chip-empty/, file.join('/'));
});
