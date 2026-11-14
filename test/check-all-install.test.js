'use strict';

// `check-all --app` re-runs `npm ci` when app/package-lock.json changed since the last
// install, not only when node_modules is missing (a dependency added after the first
// install never arrived: "Cannot find module 'react-resizable-panels'").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { needsInstall, recordInstall } = require('../scripts/check-all');

function packageDir(lock = '{"lockfileVersion":3,"packages":{}}\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-install-'));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), lock);
  return dir;
}

const setMtime = (file, seconds) => fs.utimesSync(file, seconds, seconds);

test('no node_modules: install', () => {
  const dir = packageDir();
  try {
    assert.equal(needsInstall(dir), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the recorded lockfile hash decides once an install has run', () => {
  const dir = packageDir();
  try {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    recordInstall(dir);
    assert.equal(needsInstall(dir), false, 'same lockfile');
    // A touched but unchanged lockfile (a checkout) does not reinstall.
    setMtime(path.join(dir, 'package-lock.json'), Date.now() / 1000 + 60);
    assert.equal(needsInstall(dir), false, 'same content, newer mtime');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/react-resizable-panels":{}}}\n');
    assert.equal(needsInstall(dir), true, 'a dependency was added');
    recordInstall(dir);
    assert.equal(needsInstall(dir), false, 'installed again');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installs from before the stamp compare mtimes with npm\'s .package-lock.json', () => {
  const dir = packageDir();
  try {
    const modules = path.join(dir, 'node_modules');
    fs.mkdirSync(modules);
    assert.equal(needsInstall(dir), true, 'no record of any install');
    const installed = path.join(modules, '.package-lock.json');
    fs.writeFileSync(installed, '{}');
    setMtime(path.join(dir, 'package-lock.json'), 1000);
    setMtime(installed, 2000);
    assert.equal(needsInstall(dir), false, 'lockfile older than the install');
    setMtime(path.join(dir, 'package-lock.json'), 3000);
    assert.equal(needsInstall(dir), true, 'lockfile changed after the install');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a package without a lockfile installs only when node_modules is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-install-'));
  try {
    assert.equal(needsInstall(dir), true);
    fs.mkdirSync(path.join(dir, 'node_modules'));
    assert.equal(needsInstall(dir), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
