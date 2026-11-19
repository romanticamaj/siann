'use strict';

// scripts/check-tour-output.js (m5b-nightly-quality, acceptance item 1): after
// the nightly tour job's three runs of app/test/e2e/ux-tour.spec.ts, every
// locale folder has an index.json, every captured state's PNG is there and not
// empty, and the three locales captured the same states. Fixture trees are made
// in a temporary directory; the PNG bytes are the file signature (RFC 2083) and
// nothing the checker decodes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-tour-output.js');
const LOCALES = ['en', 'zh-Hant', 'zh-Hans'];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const STATES = [
  { file: '01-empty-session.png', state: 'Empty session', notes: 'no tracks' },
  { file: '02-two-tracks.png', state: 'Two tracks', notes: 'imported' },
  { file: null, state: 'Plugin insert and editor (not captured)', notes: 'a native window' },
];

function tree(edit = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-tour-check-'));
  for (const locale of LOCALES) {
    const dir = path.join(root, locale);
    fs.mkdirSync(dir);
    const shots = STATES.map((s) => ({ ...s, notes: `${s.notes} (${locale})` }));
    for (const shot of shots) if (shot.file) fs.writeFileSync(path.join(dir, shot.file), PNG);
    fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(shots, null, 2)}\n`);
  }
  edit(root);
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
}

const { checkTourOutput } = fs.existsSync(SCRIPT) ? require(SCRIPT) : {};

test('the checker exists and exports checkTourOutput', () => {
  assert.ok(fs.existsSync(SCRIPT), 'scripts/check-tour-output.js exists');
  assert.equal(typeof checkTourOutput, 'function');
});

test('a complete tree in three locales passes', () => {
  const root = tree();
  const result = checkTourOutput(root, LOCALES);
  assert.deepEqual(result.errors, []);
  assert.equal(result.captured, 2, 'captured states per locale');
  const cli = run(root);
  assert.equal(cli.status, 0, cli.stderr);
});

test('a locale folder with no index.json fails', () => {
  const root = tree((dir) => fs.rmSync(path.join(dir, 'zh-Hans', 'index.json')));
  const result = checkTourOutput(root, LOCALES);
  assert.ok(result.errors.some((e) => /zh-Hans/.test(e) && /index\.json/.test(e)), result.errors.join('\n'));
  assert.notEqual(run(root).status, 0);
});

test('a missing locale folder fails', () => {
  const root = tree((dir) => fs.rmSync(path.join(dir, 'zh-Hant'), { recursive: true }));
  assert.ok(checkTourOutput(root, LOCALES).errors.some((e) => /zh-Hant/.test(e)));
  assert.notEqual(run(root).status, 0);
});

test('an index entry whose PNG is missing fails', () => {
  const root = tree((dir) => fs.rmSync(path.join(dir, 'en', '02-two-tracks.png')));
  const result = checkTourOutput(root, LOCALES);
  assert.ok(result.errors.some((e) => /en/.test(e) && /02-two-tracks\.png/.test(e)), result.errors.join('\n'));
  assert.notEqual(run(root).status, 0);
});

test('an index entry whose PNG is empty fails', () => {
  const root = tree((dir) => fs.writeFileSync(path.join(dir, 'zh-Hant', '01-empty-session.png'), ''));
  const result = checkTourOutput(root, LOCALES);
  assert.ok(result.errors.some((e) => /zh-Hant/.test(e) && /01-empty-session\.png/.test(e)), result.errors.join('\n'));
  assert.notEqual(run(root).status, 0);
});

test('locales with different state lists fail', () => {
  const root = tree((dir) => {
    const file = path.join(dir, 'zh-Hans', 'index.json');
    const shots = JSON.parse(fs.readFileSync(file, 'utf8')).filter((s) => s.state !== 'Two tracks');
    fs.writeFileSync(file, JSON.stringify(shots));
  });
  const result = checkTourOutput(root, LOCALES);
  assert.ok(result.errors.some((e) => /zh-Hans/.test(e) && /Two tracks/.test(e)), result.errors.join('\n'));
  assert.notEqual(run(root).status, 0);
});

test('an index.json that is not a list of shots fails', () => {
  const root = tree((dir) => fs.writeFileSync(path.join(dir, 'en', 'index.json'), '{"file": 1}'));
  assert.ok(checkTourOutput(root, LOCALES).errors.some((e) => /en/.test(e)));
  const empty = tree((dir) => fs.writeFileSync(path.join(dir, 'en', 'index.json'), '[]'));
  assert.ok(checkTourOutput(empty, LOCALES).errors.some((e) => /en/.test(e)), 'a tour with no state fails');
});
