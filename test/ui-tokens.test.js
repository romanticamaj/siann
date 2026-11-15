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
//   - the shared rules name a token for every colour and every size: no
//     literal is left in app/renderer/ui (m5-ui-tokens-spacing, decided by the
//     maintainer 2026-11-15: every size literal becomes a token, no allowlist);
//   - every fixed size of the mockup's layout (bars, rows, strips, headers)
//     is the token the SIZES table names, and four of them carry the values
//     the redesign spec gives (the mockup wins);
//   - the mockup's script holds no colour or size literal: it reads the
//     custom properties of :root through one helper, with names tokens.css
//     declares;
//   - new size tokens follow the file's convention for the UI scale, and a
//     spacing step has one token;
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
const MOCKUP_FILE = MOCKUP_PATH.join('/');
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

const COLOUR = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*[\d.]+\s*[, ][^)$]*\)/g;

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
  // The font shorthand names a weight and a size token.
  let fonts = 0;
  for (const m of UI_CSS.matchAll(/[{;]font:\s*([^;}]+)/g)) {
    assert.match(m[1], /^var\(--fw-[\w-]+\) var\(--fs-[\w-]+\)[ /]/, `font:${m[1]} names a weight and a size token`);
    fonts += 1;
  }
  assert.ok(fonts >= 13, `${fonts} font shorthands`);
  for (const m of UI_CSS.matchAll(/var\(--([\w-]+)\)/g)) {
    // --c is a track's colour, set on the element.
    if (m[1] !== 'c') assert.ok(tokens.has(m[1]), `tokens.css has no --${m[1]}`);
  }
});

// The mockup's fixed sizes and the token each one names: the pattern captures
// the name of the token the shared rule uses.
const V = 'var\\(--[\\w-]+\\)';
const N = 'var\\(--([\\w-]+)\\)';
const at = (source) => new RegExp(source.replace(/§/g, V).replace(/@/g, N));
const SIZES = [
  ['app-w', at(String.raw`\.app\{width:@`)],
  ['app-h', at(String.raw`\.app\{[^}]*height:@`)],
  ['top-bar', at(String.raw`\.app\{[^}]*grid-template-rows:@`)],
  ['status-bar', at(String.raw`\.app\{[^}]*grid-template-rows:§ minmax\(0,1fr\) @`)],
  ['left-zone-w', at(String.raw`\.app\{[^}]*grid-template-columns:@`)],
  ['right-zone-w', at(String.raw`\.app\{[^}]*grid-template-columns:§ minmax\(0,1fr\) @`)],
  ['lower-zone-h', at(String.raw`\.center\{[^}]*grid-template-rows:minmax\(0,1fr\) @`)],
  ['toolbar', at(String.raw`\.arrange\{[^}]*grid-template-rows:@`)],
  ['info-line', at(String.raw`\.arrange\{[^}]*grid-template-rows:§ @`)],
  ['track-list-w', at(String.raw`\.arr-body\{[^}]*grid-template-columns:@`)],
  ['zone-head', at(String.raw`\.z-head\{height:@`)],
  ['zone-head', at(String.raw`\.p-head\{height:@`)],
  ['zone-tabs', at(String.raw`\.tab\{height:@`)],
  ['zone-tabs', at(String.raw`\.lower\{[^}]*grid-template-rows:@`)],
  ['ruler-h', at(String.raw`\.corner\{height:@`)],
  ['marker-h', at(String.raw`\.mk\{height:@`)],
  ['track-h', at(String.raw`\.th\{height:@`)],
  ['strip-w', at(String.raw`\.strip\{width:@`)],
  ['strip-master-w', at(String.raw`\.strip\.master\{width:@`)],
  ['ms-h', at(String.raw`\.msr\{width:§;height:@`)],
  ['control-h', at(String.raw`\.seg \.b\{height:@`)],
  ['transport-h', at(String.raw`\.tbtn\{width:§;height:@`)],
  ['display-h', at(String.raw`\.lcd\{[^}]*height:@`)],
  ['fader-cap-h', at(String.raw`\.cap\{[^}]*height:@`)],
  ['meter-w', at(String.raw`\.meter \.ch\{width:@`)],
  ['meter-master-w', at(String.raw`\.strip\.master \.meter \.ch\{width:@`)],
  ['meter-scale-h', at(String.raw`\.meter \.ch i\{[^}]*background-size:100% @`)],
  ['status-dot', at(String.raw`\.statusbar \.ok\{width:@`)],
  ['status-chip-h', at(String.raw`\.statusbar \.loc\{[^}]*height:@`)],
  ['icon', at(String.raw`svg\.i\{width:@`)],
  ['icon-s', at(String.raw`svg\.i\.s\{width:@`)],
  ['letter-spacing', at(String.raw`body\{[^}]*letter-spacing:@`)],
  ['fs-body', at(String.raw`body\{font:§ @`)],
  ['fw-ui', at(String.raw`body\{font:@`)],
  ['hairline', at(String.raw`\.arrange::after\{[^}]*border:@ solid`)],
  ['focus', at(String.raw`\.arrange::after\{[^}]*border:§ solid @`)],
];

test('every fixed size of the mockup is the token the table names', () => {
  for (const [name, pattern] of SIZES) {
    const found = pattern.exec(UI_CSS);
    assert.ok(found, `the shared rules no longer match ${pattern} (token ${name})`);
    assert.ok(tokens.has(name), `tokens.css has no --${name}`);
    assert.equal(found[1], name, `${pattern} names --${found[1]}, not --${name}`);
  }
  // The body's line height is a number, not a size: the rule keeps it, and it
  // equals the token the app's own rules use.
  const lineHeight = /body\{font:var\(--fw-ui\) var\(--fs-body\)\/([\d.]+) /.exec(UI_CSS);
  assert.ok(lineHeight, 'the body names its line height');
  assert.equal(lineHeight[1], value('line-height'));
});

// UI redesign spec 1.4 and 3.2 (decided by the maintainer, 2026-11-15: the
// mockup wins): the four values the ledger used to name, from the spec's text.
test('the ruler, the zone tab rows, the meter slot and the focus frame carry the spec\'s values', () => {
  assert.equal(value('ruler-h'), '40px');
  assert.equal(value('ruler-upper-h'), '18px', 'the locators\' half');
  assert.equal(value('ruler-lower-h'), '22px', 'the cursor\'s half');
  assert.equal(parseFloat(value('ruler-upper-h')) + parseFloat(value('ruler-lower-h')), parseFloat(value('ruler-h')));
  assert.equal(value('zone-tabs'), '26px');
  assert.equal(value('meter-w'), '6px');
  assert.equal(colour(value('focus')), '232,235,241,0.2');
});

// The zone frame is --focus at 20 %; the 2 px keyboard ring of a control and
// of a divider keeps its 55 % through an app-only token (UI redesign 2.1:
// every stop shows a visible focus ring; 10.7, 4a: the 2 px focus ring is an
// app-only token), so the frame's new value dims nothing else.
test('the zone frame is --focus and the 2 px ring of a control and a divider is --focus-ring at 55 %', () => {
  assert.equal(colour(value('focus-ring')), '232,235,241,0.55');
  const shell = noComments(read('app', 'renderer', 'shell.css'));
  const rule = (selector) => {
    const at = shell.indexOf(`${selector} {`);
    assert.ok(at >= 0, `shell.css has ${selector}`);
    return shell.slice(at, shell.indexOf('}', at));
  };
  assert.match(rule('.zone[data-focused="true"]'), /outline: 1px solid var\(--focus\);/);
  assert.match(rule(':where(a[href], button, input, select, textarea, [tabindex]:not(.zone)):focus-visible'), /outline: 2px solid var\(--focus-ring\);/);
  assert.match(rule('.divider:focus-visible'), /outline: 2px solid var\(--focus-ring\);/);
  assert.doesNotMatch(rule('.divider:focus-visible'), /var\(--focus\)/);
});

// ---- the renderer names tokens: no colour or size literal of its own

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

// Literals in a stylesheet. Not counted: 0 without a unit, percentages,
// unitless numbers, times and angles, and the conditions of media and container
// queries: CSS cannot name a custom property in a query's condition, so a
// breakpoint there can never be a token (decided by the maintainer, 2026-11-15;
// UI redesign 2.3 and 2.4 are built on container queries). Only the condition
// is skipped: the rules inside the query are counted like any others.
function cssLiterals(text) {
  const body = noComments(text).replace(/@(?:media|container)[^{]*\{/g, '{');
  return {
    colours: (body.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) || []).length,
    sizes: (body.match(/(?<![\w.-])\d*\.?\d+(?:px|em|rem|pt)\b/g) || []).length,
  };
}

// Negative sizes, which cssLiterals does not count (its lookbehind skips the
// minus sign); token names (`--space-2`) are not sizes.
function negativeLiterals(text) {
  const body = noComments(text).replace(/var\(--[\w-]+\)/g, 'var()');
  return body.match(/-\d*\.?\d+(?:px|em|rem|pt)\b/g) || [];
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

test('the shared rules hold no size literal, negative ones included', () => {
  for (const file of UI_FILES) {
    const text = read('app', 'renderer', 'ui', file);
    assert.deepEqual(cssLiterals(text), { colours: 0, sizes: 0 }, `app/renderer/ui/${file}: name a token of app/renderer/tokens.css`);
    assert.deepEqual(negativeLiterals(text), [], `app/renderer/ui/${file}: a negative size is calc(var(--token) * -1)`);
  }
});

// The mockup's script reads every colour and size from the custom properties
// of :root, through one helper (and readers built on it).
function mockupHelpers() {
  const READ = 'getComputedStyle(document.documentElement).getPropertyValue';
  const body = stripComments(MOCKUP_JS);
  const definitions = body.split(READ).length - 1;
  const helper = new RegExp(String.raw`const (\w+)=\(?\w+\)?=>getComputedStyle\(document\.documentElement\)\.getPropertyValue`).exec(body);
  const readers = helper ? [...body.matchAll(new RegExp(String.raw`const (\w+)=\(?\w+\)?=>[^\n]*\b${helper[1]}\(`, 'g'))].map((m) => m[1]) : [];
  return { body, definitions, helper: helper && helper[1], names: helper ? [helper[1], ...readers] : [] };
}

test('the mockup\'s script holds no colour or size literal: it reads tokens through one helper', () => {
  assert.deepEqual(codeLiterals(MOCKUP_JS), { colours: 0, sizes: 0 }, 'colour and px literals in the mockup\'s script');
  const { body, definitions, helper, names } = mockupHelpers();
  assert.equal(definitions, 1, 'one helper reads the custom properties of :root');
  assert.ok(helper, 'the helper is `const <name>=n=>getComputedStyle(document.documentElement).getPropertyValue(...)`');
  // No em or rem literal in a string either (letter spacing is a token too).
  for (const m of body.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
    assert.deepEqual(m[0].match(/(?<![\w.-])\d*\.?\d+(?:em|rem|pt)\b/g) || [], [], `size literal in ${m[0].slice(0, 80)}`);
  }
  let colours = 0;
  let sizes = 0;
  const count = (name) => {
    assert.ok(tokens.has(name), `the mockup reads --${name}, which tokens.css does not declare`);
    if (colour(value(name))) colours += 1;
    else if (/^(fs|fw|letter-spacing)/.test(name) || /^-?[\d.]+(px|em)$/.test(value(name))) sizes += 1;
  };
  const call = new RegExp(String.raw`\b(${names.join('|')})\(`, 'g');
  for (const m of body.matchAll(call)) {
    const rest = body.slice(m.index + m[0].length);
    // A reader's own definition passes its parameter on.
    if (/^\w+\)/.test(rest) && new RegExp(String.raw`const \w+=\(?(\w+)\)?=>[^\n]*$`).test(body.slice(0, m.index).split('\n').pop())) continue;
    const arg = /^'([\w-]+)'\)/.exec(rest);
    assert.ok(arg, `${m[1]}( is called with a token name: ${rest.slice(0, 40)}`);
    count(arg[1]);
  }
  for (const m of body.matchAll(/var\(--([\w-]+)\)/g)) if (m[1] !== 'c') count(m[1]);
  // Floors, so an emptied script cannot pass: the 74 colours and the font
  // sizes, weights and spacings it drew with literals.
  assert.ok(colours >= 74, `${colours} colour reads`);
  assert.ok(sizes >= 13, `${sizes} font and size reads`);
  // Every canvas font names a weight and a size token.
  const fonts = [...body.matchAll(/\bg\.font=([^;]+);/g)].map((m) => m[1]);
  assert.ok(fonts.length >= 6, `${fonts.length} canvas fonts`);
  for (const font of fonts) {
    assert.match(font, new RegExp(String.raw`^${helper}\('fw-[\w-]+'\)\+' '\+${helper}\('fs-[\w-]+'\)\+`), `g.font=${font}`);
  }
});

// New size tokens follow the file's convention for the UI scale: a px size is
// calc(Npx * var(--scale)). Font sizes, radii and the divider's fixed widths
// are the families the convention left plain. Letter spacing is in em and so
// scales with its font. A step of the spacing scale has one token.
test('size tokens scale with the UI, and a spacing step has one token', () => {
  const plain = /^(fs|radius|divider)-/;
  for (const [name, raw] of tokens) {
    if (/^[\d.]+px$/.test(raw)) assert.ok(plain.test(name), `--${name}: ${raw} is calc(${raw} * var(--scale))`);
    if (/^calc\(/.test(raw) && /px/.test(raw)) assert.match(raw, /^calc\([\d.]+px \* var\(--scale\)\)$/, `--${name}`);
    if (/em$/.test(raw)) assert.match(name, /^letter-spacing/, `--${name}: an em token is a letter spacing`);
  }
  const steps = new Map();
  for (const name of tokens.keys()) {
    if (!/^space(-|$)/.test(name)) continue;
    const v = value(name);
    assert.ok(!steps.has(v), `--${name} and --${steps.get(v)} are both ${v}`);
    steps.set(v, name);
  }
  assert.ok(steps.size >= 8, `${steps.size} spacing steps`);
  for (const n of [1, 2, 3, 4]) assert.ok(steps.has(`${4 * n}px`), `the grid step ${4 * n}px has a token`);
});

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

// A font weight in the shared rules or the mockup is a weight token or the
// value of one (UI redesign 10.2: layer 1 holds the mockup's weights to
// tokens): a weight with no token, 800 say, fails here.
function weightsWithoutToken(text) {
  const weights = new Set([...tokens.keys()].filter((name) => name.startsWith('fw-')).map(value));
  const missing = [];
  for (const m of text.matchAll(/font-weight:\s*([^;}"'`]+)/g)) {
    const v = m[1].trim();
    const token = /^var\(--(fw-[\w-]+)\)$/.exec(v);
    if (token ? !tokens.has(token[1]) : !weights.has(v)) missing.push(v);
  }
  return missing;
}

test('every font weight of the shared rules and the mockup is a weight token or its value', () => {
  assert.deepEqual(weightsWithoutToken(`${UI_CSS}\n${MOCKUP}`), [], 'font weights with no --fw-* token');
  const count = [...`${UI_CSS}\n${MOCKUP}`.matchAll(/font-weight:/g)].length;
  assert.ok(count >= 30, `${count} font-weight declarations`);
  // The mockup's own font sizes name a type-scale token or carry its value.
  const sizes = new Set([...tokens.keys()].filter((name) => name.startsWith('fs-')).map(value));
  for (const m of MOCKUP.matchAll(/font-size:\s*([\d.]+px)/g)) assert.ok(sizes.has(m[1]), `font-size:${m[1]} in the mockup is a --fs-* value`);
});

test('the literal scanners see what they should', () => {
  assert.deepEqual(weightsWithoutToken('a{font-weight:800}b{font-weight:600}c{font-weight:var(--fw-heavy)}d{font-weight:var(--fw-strong)}'), ['800', 'var(--fw-heavy)']);
  assert.deepEqual(cssLiterals('a{color:#fff;margin:0 4px;width:50%;transition:120ms}/* #000 9px */'), { colours: 1, sizes: 1 });
  assert.deepEqual(cssLiterals('a{color:var(--tx-1);height:var(--track-h);flex:1 1 0}'), { colours: 0, sizes: 0 });
  // A query's condition is not counted, for @media and @container alike (a
  // named container included); what the query holds is.
  assert.deepEqual(cssLiterals('@media (max-width: 700px){a{width:var(--x)}}'), { colours: 0, sizes: 0 });
  assert.deepEqual(cssLiterals('@container (max-width: 200px){a{width:var(--x)}}'), { colours: 0, sizes: 0 });
  assert.deepEqual(cssLiterals('@container track-header (min-width: 12.5em) and (max-width: 200px){a{width:var(--x)}}'), { colours: 0, sizes: 0 });
  assert.deepEqual(cssLiterals('@container (max-width: 700px){a{width:320px;color:#fff}}b{margin:2px}'), { colours: 1, sizes: 2 });
  assert.deepEqual(cssLiterals('a{container-type:inline-size;width:200px}'), { colours: 0, sizes: 1 });
  assert.deepEqual(negativeLiterals('a{top:-5px;margin:0 -1.5em;left:var(--space-2);right:calc(var(--space-1h) * -1)}'), ['-5px', '-1.5em']);
  assert.deepEqual(codeLiterals("const a = '#FF00AA'; // '#000000'\nconst f = `600 10px ${x}`; const n = 10;"), { colours: 1, sizes: 1 });
  assert.deepEqual(codeLiterals('class A { #abc = 1; f() { return this.#abc; } }'), { colours: 0, sizes: 0 });
});

test('the debt ledger is owned by a feature of M5', () => {
  const m5 = JSON.parse(read('.claude', 'milestones', 'M5.json'));
  assert.ok(m5.features.some((f) => f.id === DEBT.gate), `${DEBT.gate} is a feature of M5`);
  for (const entry of DEBT.fonts) assert.ok(entry.family && entry.why, `debt.json font entry ${JSON.stringify(entry)}`);
  assert.ok(!m5.done.includes(DEBT.gate) || (DEBT.tokens.length === 0 && Object.keys(DEBT.literals).length === 0), `${DEBT.gate} is done: debt.json must be empty`);
});

// m5-ui-tokens-spacing cleared the token entries and the literals of the
// shared rules and of the mockup; what is left belongs to the alignment
// features of the regions, and the font entry to m5-ui-alignment-chrome.
test('the ledger holds no token entry and nothing of the shared rules or the mockup', () => {
  assert.deepEqual(DEBT.tokens, [], 'every token carries the mockup\'s value');
  const files = Object.keys(DEBT.literals);
  assert.deepEqual(files.filter((file) => file.startsWith('app/renderer/ui/')), []);
  assert.ok(!files.includes(MOCKUP_FILE), 'the mockup\'s script has no literal debt');
  const left = ['app/renderer/shell.css', 'app/src/renderer/mixer/MixerMeters.ts', 'app/src/renderer/timeline/TimelineCanvas.ts'];
  assert.deepEqual(files.filter((file) => !left.includes(file)), [], 'what is left belongs to the alignment features');
  assert.equal(DEBT.fonts.length, 0, 'm5-ui-alignment-chrome bundles JetBrains Mono Medium: no font entry is left');
});

// m5-ui-alignment-chrome (decided by the maintainer, 2026-11-15): JetBrains
// Mono Medium (500) is bundled beside Regular, from the same release, and has
// its own @font-face.
test('tokens.css has an @font-face for JetBrains Mono 500 naming fonts/JetBrainsMono-Medium.woff2', () => {
  const faces = TOKENS_CSS.match(/@font-face\s*{[^}]*}/g) || [];
  const mono = faces.filter((face) => /font-family:\s*["']?JetBrains Mono["']?\s*;/.test(face));
  const weightOf = (face) => /font-weight:\s*(\d+)\s*;/.exec(face)?.[1];
  assert.deepEqual(mono.map(weightOf).sort(), ['400', '500'], 'Regular and Medium');
  const medium = mono.find((face) => weightOf(face) === '500');
  assert.match(medium, /src:\s*url\(["']?fonts\/JetBrainsMono-Medium\.woff2["']?\)\s*format\(["']?woff2["']?\)/);
  assert.match(medium, /font-style:\s*normal/);
  assert.ok(fs.existsSync(path.join(ROOT, 'app', 'renderer', 'fonts', 'JetBrainsMono-Medium.woff2')), 'the file is bundled');
});

// No rule asks JetBrains Mono for a weight that is not bundled: a rule that
// names --font-num or --font-mono, or styles .mono, sets no weight, or 400 or
// 500 (600 of JetBrains Mono is not bundled; Inter is variable and carries the
// rest). The runtime sweep of app/test/e2e/fonts.spec.ts covers inherited weights.
function monoWeights(css, where) {
  const weights = new Set(['400', '500']);
  const found = [];
  for (const m of noComments(css).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const [, selector, body] = m;
    const mono = /--font-(num|mono)\b/.test(body) || /\.mono\b/.test(selector);
    if (!mono) continue;
    for (const decl of body.matchAll(/(?:^|;)\s*(font-weight|font)\s*:\s*([^;]+)/g)) {
      const first = decl[2].trim().split(/\s+/)[0];
      const token = /^var\(--(fw-[\w-]+)\)$/.exec(first);
      const weight = token ? value(token[1]) : first;
      // A font shorthand without a weight starts with a size or a style.
      if (decl[1] === 'font' && !token && !/^\d{3}$/.test(first)) continue;
      if (!weights.has(String(weight))) found.push(`${where}: ${selector.trim()} { ${decl[0].replace(/^;/, '').trim()} }`);
    }
  }
  return found;
}

test('no rule of tokens.css, ui/*.css, shell.css or mockup.html that names --font-num, --font-mono or .mono asks for a weight other than 400 or 500', () => {
  const found = [
    ...monoWeights(TOKENS_CSS, 'tokens.css'),
    ...UI_FILES.flatMap((f) => monoWeights(read('app', 'renderer', 'ui', f), `ui/${f}`)),
    ...monoWeights(read('app', 'renderer', 'shell.css'), 'shell.css'),
    // The mockup's inline styles, as one rule each.
    ...[...MOCKUP.matchAll(/class="([^"]*)"[^>]*style="([^"]*)"/g)].flatMap((m) => monoWeights(`.${m[1].trim().split(/\s+/).join('.')}{${m[2]}}`, 'mockup.html')),
  ];
  assert.deepEqual(found, []);
  // The scanner sees a 600 asked of the mono family.
  assert.equal(monoWeights('.x{font:var(--fw-strong) var(--fs-small) var(--font-num)}', 't').length, 1);
  assert.equal(monoWeights('.mono{font-weight:600}', 't').length, 1);
  assert.equal(monoWeights('.mono{font-weight:var(--fw-ui)}.y{font-weight:700}', 't').length, 0);
});

test('tokens.ts is the generated mirror of tokens.css', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'), generate(), 'run node scripts/gen-ui-tokens.js');
});

if (process.argv.includes('--print-literals')) console.log(JSON.stringify(rendererLiterals(), null, 2));
