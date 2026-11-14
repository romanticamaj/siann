'use strict';

// m5b-package-windows, acceptance 4: the unpacked package carries every licence
// text the build needs to (ADR-0017: AGPL-3.0 for the package as a whole,
// GPL-2.0 for SIANN's own sources, JUCE's licence and the ASIO SDK notice;
// Electron's and Chromium's licence files; the fonts' OFL texts; the notices of
// the libraries linked into siann-engine; the MIT notices of the npm packages
// esbuild bundles into the renderer inside app.asar).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listFiles, packageDir } = require('./support');

// Path in the package -> a line its text must hold.
const REQUIRED = {
  'resources/licenses/AGPL-3.0.txt': /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/,
  'resources/licenses/GPL-2.0.txt': /GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/,
  'resources/licenses/JUCE-LICENSE.md': /JUCE/,
  'resources/licenses/ASIO-SDK-LICENSE.txt': /Steinberg|ASIO/,
  'resources/licenses/VST3-SDK-LICENSE.txt': /Steinberg|VST/,
  'resources/licenses/CLAP-LICENSE.txt': /MIT License|Permission is hereby granted/,
  'resources/licenses/IXWebSocket-LICENSE.txt': /Redistribution and use in source and binary forms/,
  'resources/licenses/r8brain-LICENSE.txt': /Permission is hereby granted|MIT/,
  'resources/licenses/dr_libs-LICENSE.txt': /public domain|MIT/i,
  'resources/licenses/Inter-OFL.txt': /SIL OPEN FONT LICENSE/i,
  'resources/licenses/JetBrainsMono-OFL.txt': /SIL OPEN FONT LICENSE/i,
  'resources/licenses/react-LICENSE.txt': /Copyright \(c\) Meta Platforms[\s\S]*Permission is hereby granted/,
  'resources/licenses/react-dom-LICENSE.txt': /Copyright \(c\) Meta Platforms[\s\S]*Permission is hereby granted/,
  'resources/licenses/scheduler-LICENSE.txt': /Copyright \(c\) Meta Platforms[\s\S]*Permission is hereby granted/,
  'resources/licenses/react-resizable-panels-LICENSE.txt': /Copyright[\s\S]*Permission is hereby granted/,
  'LICENSE.electron.txt': /Electron|Permission is hereby granted/,
  'LICENSES.chromium.html': /Chromium|<html/i,
};

test('every licence text is in the unpacked package, and is the text it names', (t) => {
  const dir = packageDir(t);
  if (!dir) return;
  const files = new Set(listFiles(dir));
  const missing = Object.keys(REQUIRED).filter((file) => !files.has(file));
  assert.deepEqual(missing, [], `missing from ${dir}`);
  for (const [file, text] of Object.entries(REQUIRED)) {
    assert.match(fs.readFileSync(path.join(dir, file), 'utf8'), text, file);
  }
});

test("the installer's licence page is the AGPL text in the package", (t) => {
  const dir = packageDir(t);
  if (!dir) return;
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'electron-builder.json'), 'utf8'));
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'app', config.nsis.license), 'utf8').replace(/\r\n/g, '\n');
  const shipped = fs.readFileSync(path.join(dir, 'resources', 'licenses', 'AGPL-3.0.txt'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(shipped, page);
});

// The REQUIRED table above is written by hand; this one follows
// app/package-lock.json, so a runtime dependency added later cannot ship
// without its notice.
test('every package bundled into the renderer has its licence text in the package', (t) => {
  const dir = packageDir(t);
  if (!dir) return;
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'package-lock.json'), 'utf8'));
  const runtime = Object.entries(lock.packages)
    .filter(([at, entry]) => at.startsWith('node_modules/') && !entry.dev && !entry.devOptional)
    .map(([at]) => at.slice('node_modules/'.length));
  assert.ok(runtime.length > 0);
  const { npmLicenceName } = require('../../app/scripts/collect-licenses.js');
  for (const name of runtime) {
    const file = path.join(dir, 'resources', 'licenses', npmLicenceName(name));
    assert.ok(fs.existsSync(file), `${name}: ${file} is missing`);
    assert.match(fs.readFileSync(file, 'utf8'), /Permission is hereby granted|Redistribution and use/, file);
  }
});

test("the package carries no third-party executable whose notice it does not ship (electron-builder's elevate.exe)", (t) => {
  const dir = packageDir(t);
  if (!dir) return;
  assert.equal(fs.existsSync(path.join(dir, 'resources', 'elevate.exe')), false);
  const exes = listFiles(dir).filter((file) => /\.exe$/i.test(file));
  assert.deepEqual(exes, ['SIANN.exe', 'resources/siann-engine.exe']);
});
