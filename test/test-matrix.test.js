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

// A path gate: the spec reads a variable naming a built file
// (`const PLUGIN = process.env.SIANN_TEST_PLUGIN_CLAP;`) and a test skips
// without it (`test.skip(!PLUGIN, ...)`). Each spec with such a gate has a row
// in section 3.2 whose Test column names the spec and whose Gate column names
// the variable.
function e2ePathGates() {
  const gates = [];
  for (const name of fs.readdirSync(E2E)) {
    if (!name.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(E2E, name), 'utf8');
    const seen = new Set();
    for (const [, local, variable] of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.(SIANN_[A-Z0-9_]+)\s*;/g)) {
      const skip = new RegExp(`test\\.skip\\(\\s*!${local.replace(/\$/g, '\\$')}\\b`);
      if (skip.test(source) && !seen.has(variable)) {
        seen.add(variable);
        gates.push({ spec: name, variable });
      }
    }
  }
  return gates;
}

test('every variable a test of an app e2e spec skips without has a section 3.2 row naming the spec', () => {
  const gates = e2ePathGates();
  assert.ok(gates.some((g) => g.spec === 'inserts.spec.ts' && g.variable === 'SIANN_TEST_PLUGIN_CLAP'), 'the scan finds the known gate');
  const rows = section32().split('\n').filter((line) => line.startsWith('| '));
  for (const { spec, variable } of gates) {
    const row = rows.find((line) => line.split('|')[1]?.includes(`\`${spec}\``) && line.split('|')[2]?.includes(`\`${variable}\``));
    assert.ok(row, `${spec} skips without ${variable}: section 3.2 has a row naming ${spec} with ${variable} in its Gate column`);
  }
});

function matrixSection(heading) {
  const text = fs.readFileSync(MATRIX, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf(`\n## ${heading}`);
  assert.ok(start >= 0, `the matrix has a section "${heading}"`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

// m5b-protocol-parity: section 4 is the parity the tests assert, gap 2 is closed
// and rule 2 of section 8 names the parity tests.
test('section 4 of the test matrix names the protocol parity tests', () => {
  const section = matrixSection('4. ');
  assert.ok(section.includes('test/protocol-parity.test.js'), 'section 4 names test/protocol-parity.test.js');
  assert.ok(section.includes('protocol_parity_test'), 'section 4 names protocol_parity_test');
});

test('gap 2 (method/tool/doc/fixture parity) left the gap list of section 6', () => {
  const rows = matrixSection('6. ').split('\n').filter((line) => line.startsWith('| '));
  assert.ok(rows.length > 2, 'section 6 has its table');
  assert.equal(rows.find((line) => /^\|\s*2\s*\|/.test(line)), undefined, 'section 6 has no row for gap 2');
});

test('rule 2 of section 8 names the protocol parity tests', () => {
  const section = matrixSection('8. ');
  const start = section.indexOf('\n2. ');
  assert.ok(start >= 0, 'section 8 has rule 2');
  const end = section.indexOf('\n3. ', start);
  const rule = section.slice(start, end);
  assert.ok(rule.includes('test/protocol-parity.test.js'), 'rule 2 names test/protocol-parity.test.js');
  assert.ok(rule.includes('protocol_parity_test'), 'rule 2 names protocol_parity_test');
});

// m5b-bridge-native-client (acceptance item 6): layer G, the engine-gated Node
// tests, runs in CI (the bridge-engine job) on the three OSes; its section 3.2
// row and gap 3 are closed.
function matrixText() {
  return fs.readFileSync(MATRIX, 'utf8').replace(/\r\n/g, '\n');
}

test('layer G runs in the bridge-engine CI job on ubuntu, windows and macos', () => {
  const row = matrixText().split('\n').find((line) => line.startsWith('| **G** |'));
  assert.ok(row, 'the matrix has a layer G row');
  const cells = row.split('|').map((cell) => cell.trim());
  assert.match(cells[3], /bridge-engine/, 'the CI job column names bridge-engine');
  for (const os of ['ubuntu', 'windows', 'macos']) assert.match(cells[4], new RegExp(os), os);
  assert.doesNotMatch(row, /\bnever\b/);
});

test('the Ardour-era rows are gone: section 3.2 has no engine-gated row and section 6 no gap 3', () => {
  assert.doesNotMatch(section32(), /runtime-engine\.test\.js/);
  const text = matrixText();
  const start = text.indexOf('## 6. ');
  assert.ok(start >= 0, 'the matrix has a section 6');
  const section6 = text.slice(start, text.indexOf('\n## ', start + 1));
  assert.ok(!section6.split('\n').some((line) => /^\| 3 \|/.test(line)), 'gap 3 is closed');
  assert.doesNotMatch(text, /legacy Ardour checkout/);
});
// Rule 8.1: every acceptance item names its test. A paragraph headed
// "Per acceptance item (`<feature>`):" maps the manifest's items, in order, to
// the tests that cover them; a quoted title belongs to the last test file named
// before it and must be a title in that file ("..." elides part of it). Every
// native test the feature's row credits is one the paragraph cites.
const REQUIRE_ITEM_PARAGRAPH = ['m5b-engine-monitoring'];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function testFileIndex() {
  const files = new Map();
  for (const file of walk(path.join(ROOT, 'native'), [])) {
    if (path.basename(path.dirname(file)) === 'tests' && file.endsWith('.cpp')) {
      files.set(path.basename(file, '.cpp'), { file, native: true });
    }
  }
  for (const file of walk(path.join(ROOT, 'app', 'test', 'unit'), [])) {
    const match = /^(.+)\.test\.tsx?$/.exec(path.basename(file));
    if (match && !files.has(match[1])) files.set(match[1], { file, native: false });
  }
  for (const name of fs.readdirSync(path.join(ROOT, 'test'))) {
    const match = /^(.+)\.test\.js$/.exec(name);
    if (match && !files.has(match[1])) files.set(match[1], { file: path.join(ROOT, 'test', name), native: false });
  }
  return files;
}

function manifestFeatures() {
  const dir = path.join(ROOT, '.claude', 'milestones');
  const features = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    for (const feature of JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).features ?? []) {
      features.set(feature.id, feature);
    }
  }
  return features;
}

const squash = (s) => s.replace(/\s+/g, ' ');

function itemParagraphs(text) {
  const paragraphs = new Map();
  for (const block of text.split(/\n(?=\n|\|)/)) {
    const match = /^\n?Per acceptance item \(`([a-z0-9-]+)`\):/.exec(block);
    if (match) paragraphs.set(match[1], squash(block).trim());
  }
  return paragraphs;
}

test('a feature\'s "Per acceptance item" paragraph covers every item and cites real test titles', () => {
  const text = fs.readFileSync(MATRIX, 'utf8').replace(/\r\n/g, '\n');
  const paragraphs = itemParagraphs(text);
  const features = manifestFeatures();
  const files = testFileIndex();
  for (const id of REQUIRE_ITEM_PARAGRAPH) {
    assert.ok(paragraphs.has(id), `the matrix has a "Per acceptance item (\`${id}\`):" paragraph`);
  }
  // Only the features listed are held to the form: the paragraphs of features
  // that landed before the check was added follow no fixed form.
  for (const id of REQUIRE_ITEM_PARAGRAPH) {
    const paragraph = paragraphs.get(id);
    const feature = features.get(id);
    assert.ok(feature, `${id} is a feature of a milestone manifest`);
    const items = [...paragraph.matchAll(/(?:: |[.;] )(\d+) (?=`|Node |app |none|G: )/g)].map((m) => Number(m[1]));
    assert.deepEqual(items, feature.acceptance.map((_, i) => i + 1),
      `${id}: the paragraph names items 1 to ${feature.acceptance.length} in order`);

    const cited = new Set();
    let current = null;
    for (const [, name, title] of paragraph.matchAll(/`([^`]+)`|"([^"]+)"/g)) {
      if (name !== undefined) {
        if (files.has(name)) {
          current = name;
          cited.add(name);
        }
        continue;
      }
      assert.ok(current, `${id}: "${title}" follows a test file`);
      const source = squash(fs.readFileSync(files.get(current).file, 'utf8')).replace(/\\'/g, "'");
      let at = 0;
      for (const piece of title.split('...').map((p) => p.trim()).filter(Boolean)) {
        const found = source.indexOf(piece, at);
        assert.ok(found >= 0, `${id}: "${title}" is a test in ${current}`);
        at = found + piece.length;
      }
    }

    const row = text.split('\n').find((line) => line.startsWith(`| ${id} `));
    assert.ok(row, `${id} has a row in the matrix`);
    for (const [, name] of row.matchAll(/`([^`]+)`/g)) {
      if (files.get(name)?.native) assert.ok(cited.has(name), `${id}: the row credits ${name}, so the paragraph cites it`);
    }
  }
});

// m5b-bridge-cli-coverage (acceptance item 5): gaps 5 (rollback keeps media and
// renders) and 10 (bridge CLI holes) are closed, and the Node bridge table names
// the tests of reject-plan and validate-journal.
test('gaps 5 and 10 left section 6 and the Node bridge table names the reject-plan and validate-journal tests', () => {
  const rows = matrixSection('6. ').split('\n').filter((line) => line.startsWith('| '));
  assert.ok(rows.length > 2, 'section 6 has its table');
  for (const gap of [5, 10]) {
    assert.equal(rows.find((line) => new RegExp(`^\\|\\s*${gap}\\s*\\|`).test(line)), undefined, `no row for gap ${gap}`);
  }
  const text = matrixText();
  const start = text.indexOf('### Node bridge (`bin/siann.js`)');
  assert.ok(start >= 0, 'the matrix has the Node bridge table');
  const table = text.slice(start, text.indexOf('\n## ', start)).split('\n').filter((line) => line.startsWith('| '));
  for (const subcommand of ['workflow reject-plan', 'validate-journal']) {
    const row = table.find((line) => line.split('|')[1].includes(`\`${subcommand}`));
    assert.ok(row, `the Node bridge table has a row for ${subcommand}`);
    const tests = [...row.split('|')[2].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]);
    assert.ok(tests.length > 0, `the ${subcommand} row names its tests`);
    for (const name of tests) {
      assert.ok(fs.existsSync(path.join(ROOT, 'test', `${name}.test.js`)), `test/${name}.test.js exists (${subcommand})`);
    }
    assert.doesNotMatch(row, /\*\*none\*\*|untested/, `${subcommand} is no longer a hole`);
  }
});

// m5b-nightly-quality (acceptance item 7): the nightly layers are in section 1,
// sanitizers, fuzzing and the macOS long tests left "never", gaps 4, 6, 7, 9 and
// 12 are closed and section 7's proposals are done.
function section(prefix) {
  const text = matrixText();
  const start = text.indexOf(`\n${prefix}`);
  assert.ok(start >= 0, `the matrix has a section "${prefix}"`);
  const level = prefix.startsWith('### ') ? /\n#{2,3} /g : /\n## /g;
  level.lastIndex = start + 1;
  const next = level.exec(text);
  return text.slice(start + 1, next ? next.index : undefined);
}

const CLOSED_GAPS = [4, 6, 7, 9, 12];

test('section 1 has a row for each nightly layer', () => {
  const rows = section('## 1. ').split('\n').filter((line) => line.startsWith('| **'));
  const find = (re, what) => {
    const row = rows.find((line) => re.test(line.split('|')[2] ?? ''));
    assert.ok(row, `a section 1 row for ${what}`);
    assert.match(row.split('|')[3], /nightly/, `${what} runs in the nightly workflow`);
    return row;
  };
  find(/ux-tour\.spec\.ts/, 'the tour');
  find(/ASAN/, 'ASAN/UBSAN');
  find(/libFuzzer/, 'fuzzing');
  find(/llvm-cov/, 'native coverage');
  find(/perf\.spec\.ts/, 'the performance scenario');
  const long = rows.find((line) => line.startsWith('| **L** |'));
  assert.ok(long, 'the long tests row');
  assert.match(long.split('|')[4], /macos/);
});

test('section 3.1 no longer lists sanitizers, fuzzing or the macOS long tests as never run', () => {
  const text = section('### 3.1 ');
  const never = text.split('\n- ').find((item) => item.startsWith('**Never**'));
  assert.ok(never, 'a "Never" item');
  assert.doesNotMatch(never, /ASAN|UBSAN|fuzz/i);
  assert.match(never, /TSAN/, 'TSAN is still not built');
  assert.doesNotMatch(text, /long-tests/);
});

test('gaps 4, 6, 7, 9 and 12 are closed in the gap table and section 6', () => {
  const head = matrixText().split('\n## 1. ')[0].split('\n');
  for (const gap of CLOSED_GAPS) {
    const row = head.find((line) => line.startsWith(`| ${gap} `));
    if (row) assert.match(row, /closed by `m5b-nightly-quality`/, `gap ${gap} in the gap table`);
  }
  const six = section('## 6. ').split('\n');
  for (const gap of CLOSED_GAPS) {
    assert.ok(!six.some((line) => line.startsWith(`| ${gap} |`)), `gap ${gap} is out of section 6`);
  }
  // What gap 6 named and the feature does not fuzz: the media decoders.
  const decoders = six.find((line) => /^\| \d+ \|/.test(line) && /WAV/.test(line) && /FLAC/.test(line));
  assert.ok(decoders, 'a section 6 row for fuzzing the WAV and FLAC readers');
  assert.match(decoders, /\| Low[^|]*\|/, 'ranked low');
});

test('section 7 lists its proposals 1 to 3 and 5 to 7 as done', () => {
  const text = section('## 7. ');
  assert.doesNotMatch(text, /Proposed, not done/);
  for (const item of [1, 2, 3, 5, 6, 7]) {
    const line = text.split('\n').find((l) => l.startsWith(`${item}. `));
    assert.ok(line, `section 7 item ${item}`);
    assert.match(line, /done by `m5b-nightly-quality`/i, `item ${item} is done`);
  }
});

test('section 2 has a row for m5b-nightly-quality naming its tests', () => {
  const row = section('## 2. ').split('\n').find((line) => line.startsWith('| m5b-nightly-quality |'));
  assert.ok(row, 'an m5b-nightly-quality row');
  for (const name of ['ci-workflow', 'ci-long-tests', 'check-all-changed', 'test-matrix', 'native-quality-options', 'tour-output',
    'fuzz_smoke_test', 'perf-report', 'frame-marks', 'perf.spec']) {
    assert.ok(row.includes(name), `the row names ${name}`);
  }
});

test('section 3.2 says the tour runs nightly in three locales', () => {
  const row = section32().split('\n').find((line) => line.split('|')[2]?.includes('`SIANN_UX_TOUR=1`'));
  assert.ok(row, 'the tour row');
  assert.match(row, /nightly/);
  for (const locale of ['en', 'zh-Hant', 'zh-Hans']) assert.ok(row.includes(locale), locale);
});
