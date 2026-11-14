'use strict';

// What the package tests share: the unpacked installer directory
// (electron-builder's win-unpacked), from SIANN_PACKAGE_DIR. These tests are
// not in the root `npm test` glob; the package step of scripts/check-all.js
// and the package CI job run them after `npm run dist`. When the variable is
// unset they skip; when it is set and the directory is missing they fail.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function packageDir(t) {
  const dir = process.env.SIANN_PACKAGE_DIR;
  if (!dir) {
    t.skip('set SIANN_PACKAGE_DIR to app/release/win-unpacked');
    return null;
  }
  assert.ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory(), `SIANN_PACKAGE_DIR is not a directory: ${dir}`);
  return path.resolve(dir);
}

// Every file under `dir`, as forward-slash paths relative to it.
function listFiles(dir) {
  const out = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

module.exports = { listFiles, packageDir };
