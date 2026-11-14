'use strict';

// scripts/pe-imports.js (m5b-package-windows, acceptance 5): the import and
// delay-import directories of a PE image. The fixture comes from a separate
// generator (scripts/generate-pe-fixture.js) that writes the PE/COFF layout
// itself, so the names expected here are the generator's input, not the
// parser's output.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildPe, DEFAULT_IMPORTS, DEFAULT_DELAY_IMPORTS } = require('../scripts/generate-pe-fixture');
const { peImports, peImportsOfFile } = require('../scripts/pe-imports');

test('the import and delay-import DLLs of a PE32+ image, in table order', () => {
  const image = buildPe();
  const parsed = peImports(image);
  assert.equal(parsed.format, 'PE32+');
  assert.equal(parsed.machine, 0x8664);
  assert.deepEqual(parsed.imports, ['KERNEL32.dll', 'USER32.dll', 'siann-helper.dll']);
  assert.deepEqual(parsed.delayImports, ['WINMM.dll', 'VCRUNTIME140.dll']);
  assert.deepEqual(parsed.imports, Object.keys(DEFAULT_IMPORTS));
  assert.deepEqual(parsed.delayImports, Object.keys(DEFAULT_DELAY_IMPORTS));
});

test('other DLL names come back as written, and an image with no delay imports has none', () => {
  const image = buildPe({ imports: { 'ntdll.dll': ['RtlGetVersion'], 'api-ms-win-core-synch-l1-2-0.dll': ['Sleep'] }, delayImports: {} });
  const parsed = peImports(image);
  assert.deepEqual(parsed.imports, ['ntdll.dll', 'api-ms-win-core-synch-l1-2-0.dll']);
  assert.deepEqual(parsed.delayImports, []);
});

test('reads a file from disk (the CLI form the package tests use)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-pe-'));
  try {
    const file = path.join(dir, 'fixture.exe');
    const generator = path.join(__dirname, '..', 'scripts', 'generate-pe-fixture.js');
    const { spawnSync } = require('node:child_process');
    const made = spawnSync(process.execPath, [generator, file], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const parsed = peImportsOfFile(file);
    assert.deepEqual(parsed.imports, Object.keys(DEFAULT_IMPORTS));
    assert.deepEqual(parsed.delayImports, Object.keys(DEFAULT_DELAY_IMPORTS));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated image is refused, not read as having fewer imports', () => {
  const image = buildPe();
  for (const length of [0, 0x40, 0x90, 0x200, image.length - 100]) {
    assert.throws(() => peImports(image.subarray(0, length)), /truncated|not a PE/i, `length ${length}`);
  }
});

test('a file that is not a PE image is refused', () => {
  assert.throws(() => peImports(Buffer.from('#!/bin/sh\necho hello\n'.padEnd(1024, ' '))), /not a PE/i);
  const image = buildPe();
  image.write('XX', 0x80, 'latin1'); // the PE signature
  assert.throws(() => peImports(image), /not a PE/i);
});
