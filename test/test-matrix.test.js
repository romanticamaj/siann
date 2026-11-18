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
