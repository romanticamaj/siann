'use strict';

// Layer 1 of the mockup fidelity gate (docs/harness/agent-rules.md, "UI
// fidelity"): the design tokens are identical, because there is one copy.
// app/renderer/tokens.css is the token source and app/renderer/ui/*.css the
// component rules, lifted from the redesign's mockup; the mockup has no
// stylesheet of its own and loads those files, as the app does. This test
// holds that:
//
//   - mockup.html links tokens.css and every file of app/renderer/ui, has no
//     <style> and asks the network for nothing;
//   - the shared rules name tokens for every colour, font size and radius, and
//     every colour, font size and weight of the mockup's canvas code is the
//     value of a token;
//   - every fixed size of the mockup's layout (bars, rows, strips, headers)
//     equals its token;
//   - the renderer's stylesheets and TypeScript hold no colour or size literal
//     of their own: they name tokens;
//   - app/src/renderer/tokens.ts, the mirror for canvas code, is the generated
//     copy of tokens.css.
//
// What does not hold yet is written down in app/test/fidelity/debt.json, the
// debt m5-ui-mockup-alignment pays: the test fails on anything not in it, and
// on an entry that no longer applies, so the ledger only shrinks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readTokens, resolve, simplify, generate, OUT } = require('../scripts/gen-ui-tokens');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const MOCKUP_PATH = ['docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign', 'mockup.html'];
const TOKENS_CSS = read('app', 'renderer', 'tokens.css');
const MOCKUP = read(...MOCKUP_PATH);
const MOCKUP_JS = MOCKUP.slice(MOCKUP.indexOf('<script>') + 8, MOCKUP.lastIndexOf('</script>'));
const DEBT = JSON.parse(read('app', 'test', 'fidelity', 'debt.json'));
const UI_DIR = path.join(ROOT, 'app', 'renderer', 'ui');
const UI_ORDER = ['base.css', 'layout.css', 'top-bar.css', 'left-zone.css', 'project-zone.css', 'lower-zone.css', 'right-zone.css', 'status-bar.css'];
const UI_FILES = fs.readdirSync(UI_DIR).filter((f) => f.endsWith('.css')).sort();
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
// The shared component rules, comments removed.
const UI_CSS = UI_FILES.map((f) => noComments(read('app', 'renderer', 'ui', f))).join('\n');

const tokens = readTokens(TOKENS_CSS);
const value = (name) => simplify(resolve(tokens.get(name), tokens));

// A colour as "r,g,b,a"; null when the text is not one.
function colour(text) {
  const v = text.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1).join(',');
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1).join(',');
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])].join(',');
  return null;
}

// Colours compare as colours, everything else without its spaces.
function same(a, b) {
  if (colour(a) !== null || colour(b) !== null) return colour(a) === colour(b);
  return a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
}

const COLOUR = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*[\d.]+\s*[, ][^)$]*\)/g;

function tokenValues(prefix) {
  return new Set([...tokens.keys()].filter((name) => name.startsWith(prefix)).map(value));
}

test('the mockup loads the shared stylesheets and nothing else', () => {
  assert.ok(!/<style[\s>]/.test(MOCKUP), 'mockup.html has no <style>: its rules are app/renderer/ui/*.css');
  assert.ok(!/https?:\/\//.test(MOCKUP), 'mockup.html asks the network for nothing');
  const links = [...MOCKUP.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  const base = '../../../../app/renderer/';
  assert.deepEqual(links, [`${base}tokens.css`, ...UI_ORDER.map((f) => `${base}ui/${f}`)]);
  assert.deepEqual([...UI_ORDER].sort(), UI_FILES, 'every file of app/renderer/ui is linked by the mockup');
  assert.ok(!UI_CSS.includes(':root'), 'tokens are declared in tokens.css only');
});

test('the shared rules name tokens for every colour, font size and radius', () => {
  assert.deepEqual(UI_CSS.match(COLOUR) || [], [], 'colour literals in app/renderer/ui');
  let checked = 0;
  for (const m of UI_CSS.matchAll(/(font-size|border-radius):\s*([^;}]+)/g)) {
    for (const part of m[2].trim().split(/\s+/)) {
      assert.match(part, /^var\(--(fs|radius)-[\w-]+\)$/, `${m[0]} names a token`);
      checked += 1;
    }
  }
  assert.ok(checked > 100, `${checked} font sizes and radii`);
  for (const m of UI_CSS.matchAll(/var\(--([\w-]+)\)/g)) {
    // --c is a track's colour, set on the element.
    if (m[1] !== 'c') assert.ok(tokens.has(m[1]), `tokens.css has no --${m[1]}`);
  }
});

test('every colour, font size and weight of the mockup is the value of a token', () => {
  const have = new Set([...tokens.keys()].map((name) => colour(value(name))).filter(Boolean));
  const sizes = tokenValues('fs-');
  const weights = tokenValues('fw-');
  const missing = new Set();
  const colours = MOCKUP_JS.match(COLOUR) || [];
  assert.ok(colours.length > 60, `${colours.length} colours in the mockup's script`);
  for (const literal of colours) {
    const c = colour(literal);
    assert.ok(c, `unreadable colour ${literal}`);
    if (!have.has(c)) missing.add(literal);
  }
  // The font shorthand `W Npx`, in the rules and in the canvas code.
  let fonts = 0;
  for (const m of `${UI_CSS}\n${MOCKUP_JS}`.matchAll(/\b(\d{3}) ([\d.]+px)[ /]/g)) {
    fonts += 1;
    if (!weights.has(m[1])) missing.add(`font weight ${m[1]}`);
    if (!sizes.has(m[2])) missing.add(`font size ${m[2]}`);
  }
  assert.ok(fonts >= 15, `${fonts} font shorthands`);
  for (const m of `${UI_CSS}\n${MOCKUP}`.matchAll(/font-weight:\s*(\d{3})/g)) if (!weights.has(m[1])) missing.add(`font weight ${m[1]}`);
  for (const m of MOCKUP.matchAll(/font-size:\s*([\d.]+px)/g)) if (!sizes.has(m[1])) missing.add(`font size ${m[1]}`);
  assert.deepEqual([...missing], [], 'values of the mockup with no token in tokens.css');
});

// The mockup's fixed sizes and the token each one is: the pattern captures
// the value in the shared rules.
const SIZES = [
  ['top-bar', /\.app\{[^}]*grid-template-rows:(\d+px)/],
  ['status-bar', /\.app\{[^}]*grid-template-rows:\d+px minmax\(0,1fr\) (\d+px)/],
  ['left-zone-w', /\.app\{[^}]*grid-template-columns:(\d+px)/],
  ['right-zone-w', /\.app\{[^}]*grid-template-columns:\d+px minmax\(0,1fr\) (\d+px)/],
  ['lower-zone-h', /\.center\{[^}]*grid-template-rows:minmax\(0,1fr\) (\d+px)/],
  ['toolbar', /\.arrange\{[^}]*grid-template-rows:(\d+px)/],
  ['info-line', /\.arrange\{[^}]*grid-template-rows:\d+px (\d+px)/],
  ['track-list-w', /\.arr-body\{[^}]*grid-template-columns:(\d+px)/],
  ['zone-head', /\.z-head\{height:(\d+px)/],
  ['zone-tabs', /\.tab\{height:(\d+px)/],
  ['ruler-h', /\.corner\{height:(\d+px)/],
  ['marker-h', /\.mk\{height:(\d+px)/],
  ['track-h', /\.th\{height:(\d+px)/],
  ['strip-w', /\.strip\{width:(\d+px)/],
  ['strip-master-w', /\.strip\.master\{width:(\d+px)/],
  ['ms-h', /\.msr\{width:\d+px;height:(\d+px)/],
  ['control-h', /\.seg \.b\{height:(\d+px)/],
  ['transport-h', /\.tbtn\{width:\d+px;height:(\d+px)/],
  ['display-h', /\.lcd\{[^}]*height:(\d+px)/],
  ['fader-cap-h', /\.cap\{[^}]*height:(\d+px)/],
  ['meter-w', /\.meter \.ch\{width:(\d+px)/],
  ['icon', /svg\.i\{width:(\d+px)/],
  ['icon-s', /svg\.i\.s\{width:(\d+px)/],
  ['letter-spacing', /body\{[^}]*letter-spacing:([\d.]+em)/],
  ['line-height', /body\{font:\d+ \d+px\/([\d.]+) /],
  ['fs-body', /body\{font:\d+ (\d+px)/],
  ['fw-ui', /body\{font:(\d+) /],
  ['focus', /\.arrange::after\{[^}]*border:1px solid var\(--([\w-]+)\)/],
];

test('every fixed size of the mockup equals its token, except the ledger\'s debts', () => {
  const debts = new Map(DEBT.tokens.map((entry) => [entry.token, entry]));
  const seen = new Set();
  for (const [name, at] of SIZES) {
    const found = at.exec(UI_CSS);
    assert.ok(found, `the shared rules no longer match ${at} (token ${name})`);
    assert.ok(tokens.has(name), `tokens.css has no --${name}`);
    // A captured token name stands for its value.
    const theirs = tokens.has(found[1]) ? value(found[1]) : found[1];
    const ours = value(name);
    const debt = debts.get(name);
    if (debt) {
      seen.add(name);
      assert.ok(!same(theirs, ours), `--${name} now equals the mockup: remove it from debt.json`);
      assert.ok(same(debt.mockup, theirs) && same(debt.app, ours), `debt.json is stale for --${name}: mockup ${theirs}, tokens.css ${ours}`);
    } else {
      assert.ok(same(theirs, ours), `--${name}: the mockup has ${theirs}, tokens.css has ${ours}`);
    }
  }
  assert.deepEqual(DEBT.tokens.map((entry) => entry.token).filter((name) => !seen.has(name)), [], 'debt.json names tokens this test does not compare');
});

// ---- the renderer names tokens: no colour or size literal of its own

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

// Literals in a stylesheet. Not counted: 0 without a unit, percentages,
// unitless numbers, times and angles, and the conditions of media queries.
function cssLiterals(text) {
  const body = noComments(text).replace(/@media[^{]*\{/g, '{');
  return {
    colours: (body.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) || []).length,
    sizes: (body.match(/(?<![\w.-])\d*\.?\d+(?:px|em|rem|pt)\b/g) || []).length,
  };
}

// Literals in code: colours and px sizes inside string literals.
function codeLiterals(text) {
  const body = stripComments(text);
  let colours = 0;
  let sizes = 0;
  for (const m of body.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
    colours += (m[0].match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(|hsla?\(/g) || []).length;
    sizes += (m[0].match(/(?<![\w.-])\d*\.?\d+px\b/g) || []).length;
  }
  return { colours, sizes };
}

function walk(dir, keep, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

function rendererLiterals() {
  const found = {};
  const note = (file, counts) => {
    if (counts.colours > 0 || counts.sizes > 0) found[path.relative(ROOT, file).replace(/\\/g, '/')] = counts;
  };
  const cssDir = path.join(ROOT, 'app', 'renderer');
  for (const file of walk(cssDir, (f) => f.endsWith('.css') && path.basename(f) !== 'tokens.css')) note(file, cssLiterals(fs.readFileSync(file, 'utf8')));
  const srcDir = path.join(ROOT, 'app', 'src', 'renderer');
  // The mirror holds the tokens; the catalogs hold prose.
  const skip = (f) => path.basename(f) === 'tokens.ts' || f.includes(`${path.sep}i18n${path.sep}`);
  for (const file of walk(srcDir, (f) => /\.tsx?$/.test(f) && !skip(f))) note(file, codeLiterals(fs.readFileSync(file, 'utf8')));
  // The mockup's markup and canvas code follow the same rule.
  note(path.join(ROOT, ...MOCKUP_PATH), codeLiterals(MOCKUP_JS));
  return found;
}

test('the renderer and the mockup hold no colour or size literal beyond the ledger\'s debts', () => {
  const found = rendererLiterals();
  for (const [file, counts] of Object.entries(found)) {
    const debt = DEBT.literals[file] || { colours: 0, sizes: 0 };
    assert.ok(counts.colours <= debt.colours, `${file}: ${counts.colours} colour literals (debt.json allows ${debt.colours}); name a token of app/renderer/tokens.css instead`);
    assert.ok(counts.sizes <= debt.sizes, `${file}: ${counts.sizes} size literals (debt.json allows ${debt.sizes}); name a token of app/renderer/tokens.css instead`);
  }
  // The ledger only shrinks: an entry above what is there is lowered or removed.
  for (const [file, debt] of Object.entries(DEBT.literals)) {
    const counts = found[file] || { colours: 0, sizes: 0 };
    assert.deepEqual(counts, { colours: debt.colours, sizes: debt.sizes }, `${file} has fewer literals than debt.json records: lower the entry`);
  }
});

test('the literal scanners see what they should', () => {
  assert.deepEqual(cssLiterals('a{color:#fff;margin:0 4px;width:50%;transition:120ms}/* #000 9px */'), { colours: 1, sizes: 1 });
  assert.deepEqual(cssLiterals('a{color:var(--tx-1);height:var(--track-h);flex:1 1 0}'), { colours: 0, sizes: 0 });
  assert.deepEqual(codeLiterals("const a = '#FF00AA'; // '#000000'\nconst f = `600 10px ${x}`; const n = 10;"), { colours: 1, sizes: 1 });
  assert.deepEqual(codeLiterals('class A { #abc = 1; f() { return this.#abc; } }'), { colours: 0, sizes: 0 });
});

test('the debt ledger is owned by a feature of M5', () => {
  const m5 = JSON.parse(read('.claude', 'milestones', 'M5.json'));
  assert.ok(m5.features.some((f) => f.id === DEBT.gate), `${DEBT.gate} is a feature of M5`);
  for (const entry of DEBT.tokens) assert.ok(entry.token && entry.mockup && entry.app && entry.why, `debt.json token entry ${JSON.stringify(entry)}`);
  for (const entry of DEBT.fonts) assert.ok(entry.family && entry.why, `debt.json font entry ${JSON.stringify(entry)}`);
  assert.ok(!m5.done.includes(DEBT.gate) || (DEBT.tokens.length === 0 && Object.keys(DEBT.literals).length === 0), `${DEBT.gate} is done: debt.json must be empty`);
});

test('tokens.ts is the generated mirror of tokens.css', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'), generate(), 'run node scripts/gen-ui-tokens.js');
});

if (process.argv.includes('--print-literals')) console.log(JSON.stringify(rendererLiterals(), null, 2));
