#!/usr/bin/env node
// Writes a minimal PE32+ image whose import and delay-import directories name
// the DLLs and functions it is given: the fixture of test/pe-imports.test.js.
// It is written from the PE/COFF layout (Microsoft's "PE Format" document),
// not from scripts/pe-imports.js, so the parser's test does not take its
// expectation from the parser. The image is never loaded or run: it holds the
// headers, one section (.idata) and nothing else.
//
//   node scripts/generate-pe-fixture.js <out.exe>
//
// writes the default fixture (DEFAULT_IMPORTS, DEFAULT_DELAY_IMPORTS).
'use strict';

const fs = require('node:fs');

const DEFAULT_IMPORTS = {
  'KERNEL32.dll': ['ExitProcess', 'GetStdHandle'],
  'USER32.dll': ['MessageBoxW'],
  'siann-helper.dll': ['siann_helper_init'],
};
const DEFAULT_DELAY_IMPORTS = {
  'WINMM.dll': ['timeBeginPeriod'],
  'VCRUNTIME140.dll': ['memcpy'],
};

const FILE_ALIGNMENT = 0x200;
const SECTION_ALIGNMENT = 0x1000;
const IMAGE_BASE = 0x140000000n;
const SECTION_RVA = 0x1000;
const OPTIONAL_HEADER_SIZE = 112 + 16 * 8; // PE32+ fields, then 16 data directories

const align = (value, to) => Math.ceil(value / to) * to;

// The .idata section: import descriptors (20 bytes each, a zero one last),
// delay-load descriptors (32 bytes each, a zero one last), the thunk arrays
// (8 bytes per entry, zero-terminated), the hint/name entries and the DLL names.
function idata(imports, delayImports) {
  const importDlls = Object.keys(imports);
  const delayDlls = Object.keys(delayImports);
  let size = 0;
  const reserve = (bytes) => {
    const at = size;
    size += bytes;
    return at;
  };
  const importDir = reserve((importDlls.length + 1) * 20);
  const delayDir = reserve((delayDlls.length + 1) * 32);
  const thunks = new Map();
  for (const [kind, table] of [['i', imports], ['d', delayImports]]) {
    for (const dll of Object.keys(table)) thunks.set(`${kind}:${dll}`, reserve((table[dll].length + 1) * 8));
  }
  const hintNames = new Map();
  for (const table of [imports, delayImports]) {
    for (const names of Object.values(table)) {
      for (const name of names) {
        if (!hintNames.has(name)) hintNames.set(name, reserve(align(2 + name.length + 1, 2)));
      }
    }
  }
  const dllNames = new Map();
  for (const dll of [...importDlls, ...delayDlls]) if (!dllNames.has(dll)) dllNames.set(dll, reserve(dll.length + 1));

  const data = Buffer.alloc(align(size, FILE_ALIGNMENT));
  const rva = (offset) => SECTION_RVA + offset;
  importDlls.forEach((dll, i) => {
    const at = importDir + i * 20;
    data.writeUInt32LE(rva(thunks.get(`i:${dll}`)), at); // OriginalFirstThunk (import lookup table)
    data.writeUInt32LE(rva(dllNames.get(dll)), at + 12); // Name
    data.writeUInt32LE(rva(thunks.get(`i:${dll}`)), at + 16); // FirstThunk (the same table: not bound)
  });
  delayDlls.forEach((dll, i) => {
    const at = delayDir + i * 32;
    data.writeUInt32LE(1, at); // Attributes: RVA-based
    data.writeUInt32LE(rva(dllNames.get(dll)), at + 4); // DllNameRVA
    data.writeUInt32LE(rva(thunks.get(`d:${dll}`)), at + 16); // ImportNameTableRVA
  });
  for (const [kind, table] of [['i', imports], ['d', delayImports]]) {
    for (const [dll, names] of Object.entries(table)) {
      names.forEach((name, i) => {
        data.writeBigUInt64LE(BigInt(rva(hintNames.get(name))), thunks.get(`${kind}:${dll}`) + i * 8);
      });
    }
  }
  for (const [name, at] of hintNames) data.write(name, at + 2, 'latin1');
  for (const [dll, at] of dllNames) data.write(dll, at, 'latin1');
  return {
    data,
    size,
    importDir: { rva: rva(importDir), size: (importDlls.length + 1) * 20 },
    delayDir: { rva: rva(delayDir), size: (delayDlls.length + 1) * 32 },
  };
}

function buildPe({ imports = DEFAULT_IMPORTS, delayImports = DEFAULT_DELAY_IMPORTS } = {}) {
  const section = idata(imports, delayImports);
  const headersSize = FILE_ALIGNMENT;
  const headers = Buffer.alloc(headersSize);
  // DOS header: the MZ signature and e_lfanew.
  headers.write('MZ', 0, 'latin1');
  const peOffset = 0x80;
  headers.writeUInt32LE(peOffset, 0x3c);
  headers.write('PE\0\0', peOffset, 'latin1');
  // COFF file header.
  const coff = peOffset + 4;
  headers.writeUInt16LE(0x8664, coff); // Machine: AMD64
  headers.writeUInt16LE(1, coff + 2); // NumberOfSections
  headers.writeUInt16LE(OPTIONAL_HEADER_SIZE, coff + 16);
  headers.writeUInt16LE(0x0022, coff + 18); // EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE
  // Optional header (PE32+).
  const opt = coff + 20;
  headers.writeUInt16LE(0x20b, opt);
  headers.writeBigUInt64LE(IMAGE_BASE, opt + 24);
  headers.writeUInt32LE(SECTION_ALIGNMENT, opt + 32);
  headers.writeUInt32LE(FILE_ALIGNMENT, opt + 36);
  headers.writeUInt16LE(6, opt + 40); // MajorOperatingSystemVersion
  headers.writeUInt16LE(6, opt + 48); // MajorSubsystemVersion
  headers.writeUInt32LE(SECTION_RVA + align(section.size, SECTION_ALIGNMENT), opt + 56); // SizeOfImage
  headers.writeUInt32LE(headersSize, opt + 60); // SizeOfHeaders
  headers.writeUInt16LE(3, opt + 68); // Subsystem: console
  headers.writeUInt32LE(16, opt + 108); // NumberOfRvaAndSizes
  const dir = (index, { rva, size }) => {
    headers.writeUInt32LE(rva, opt + 112 + index * 8);
    headers.writeUInt32LE(size, opt + 112 + index * 8 + 4);
  };
  dir(1, section.importDir);
  dir(13, section.delayDir);
  // The one section header.
  const sh = opt + OPTIONAL_HEADER_SIZE;
  headers.write('.idata', sh, 'latin1');
  headers.writeUInt32LE(section.size, sh + 8); // VirtualSize
  headers.writeUInt32LE(SECTION_RVA, sh + 12); // VirtualAddress
  headers.writeUInt32LE(section.data.length, sh + 16); // SizeOfRawData
  headers.writeUInt32LE(headersSize, sh + 20); // PointerToRawData
  headers.writeUInt32LE(0xc0000040, sh + 36); // INITIALIZED_DATA | READ | WRITE
  return Buffer.concat([headers, section.data]);
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write('usage: node scripts/generate-pe-fixture.js <out.exe>\n');
    process.exit(2);
  }
  fs.writeFileSync(out, buildPe());
}

module.exports = { DEFAULT_DELAY_IMPORTS, DEFAULT_IMPORTS, buildPe };
