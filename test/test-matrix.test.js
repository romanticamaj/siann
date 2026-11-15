'use strict';

// docs/harness/test-matrix.md, rule 8.4: every platform skip or env gate
// carries a reason and a row in the matrix's section 3. An app e2e spec gates
// a test on a flag variable (`process.env.SIANN_X === '1'` or `!== '1'`); each
// such flag is named in the table of section 3.2.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MATRIX = path.join(ROOT, 'docs', 'harness', 'test-matrix.md');
const E2E = path.join(ROOT, 'app', 'test', 'e2e');

function section32() {
  const text = fs.readFileSync(MATRIX, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('### 3.2 ');
  assert.ok(start >= 0, 'the matrix has a section 3.2');
  const end = text.indexOf('\n### ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

function e2eFlags() {
  const flags = new Map();
  for (const name of fs.readdirSync(E2E)) {
    if (!name.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(E2E, name), 'utf8');
    for (const [, flag] of source.matchAll(/process\.env\.(SIANN_[A-Z0-9_]+)\s*[!=]==\s*'1'/g)) {
      if (!flags.has(flag)) flags.set(flag, name);
    }
  }
  return flags;
}

test('every flag that gates an app e2e test has a row in section 3.2 of the test matrix', () => {
  const flags = e2eFlags();
  assert.ok(flags.has('SIANN_FIDELITY') && flags.has('SIANN_UX_TOUR'), 'the scan finds the known gates');
  const rows = section32().split('\n').filter((line) => line.startsWith('| '));
  for (const [flag, spec] of flags) {
    const row = rows.find((line) => line.split('|')[2]?.includes(`\`${flag}=1\``));
    assert.ok(row, `${flag} (${spec}) has a row in section 3.2 with the flag in its Gate column`);
    assert.ok(row.split('|')[1].includes(spec), `the 3.2 row for ${flag} names ${spec}`);
  }
});
