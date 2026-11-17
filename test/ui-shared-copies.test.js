'use strict';

// The right zone's copies of shared rules (m5-ui-port-plans; UI redesign
// 10.10, P1-13 notes, "The tab row"). The Plans tab uses the mockup's .tab,
// .seg .b and .stepn, whose rules live in app/renderer/ui/lower-zone.css and
// ui/project-zone.css. Those files are not linked by the app until
// m5-ui-port-mixer-strip and the project zone's ports, because their class
// names (.tab, .strip, .meter, .field...) would restyle the components not
// ported yet. Until then app/renderer/shell.css carries the rules the right
// zone needs as `:where(.plans) <shared selector>{<shared declarations>}`.
// This test holds them to their source, so they cannot drift or drop a
// declaration: each copy is the shared rule verbatim, with the shared rule's
// specificity (the prefix is under :where), and m5-ui-port-cleanup deletes
// them (docs/harness/agent-rules.md, "UI fidelity": no second rule for what
// the shared rules draw).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'app', 'renderer');
const PREFIX = ':where(.plans) ';
const SOURCES = ['ui/lower-zone.css', 'ui/project-zone.css'];

// Flat rules: [selector, declarations], comments removed, whitespace collapsed.
function rules(file) {
  const text = fs.readFileSync(path.join(RENDERER, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push([m[1].trim().replace(/\s+/g, ' '), m[2].trim().replace(/\s+/g, ' ')]);
  }
  return out;
}

const copies = rules('shell.css').filter(([selector]) => selector.startsWith(PREFIX));
const shared = new Map(SOURCES.flatMap((file) => rules(file).map(([selector, body]) => [selector, { file, body }])));

test('shell.css carries the right zone\'s copies of .tab, .seg .b and .stepn', () => {
  assert.deepEqual(
    copies.map(([selector]) => selector.slice(PREFIX.length)).sort(),
    ['.seg', '.seg .b', '.seg .b.on', '.stepn', '.tab', '.tab.on', '.tab.on::after'],
  );
});

test('each copy is its shared rule verbatim, under :where(.plans) only', () => {
  for (const [selector, body] of copies) {
    const source = selector.slice(PREFIX.length);
    assert.ok(!source.includes(','), `${selector}: one selector per copy, so the prefix scopes all of it`);
    const original = shared.get(source);
    assert.ok(original, `${selector}: no rule "${source}" in ${SOURCES.join(' or ')}`);
    assert.equal(body, original.body, `${selector} differs from ${original.file}`);
  }
});
