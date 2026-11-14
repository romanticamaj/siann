#!/usr/bin/env node
// The DLLs a Windows PE image (an .exe or a .dll) imports, from its import
// directory and its delay-load import directory (Microsoft's "PE Format":
// data directories 1 and 13). The package tests (test/package/imports.test.js)
// run it over the packaged siann-engine.exe and every DLL beside it.
//
//   node scripts/pe-imports.js <image> [<image> ...]   prints one line per DLL
//
// A truncated image or one that is not a PE throws; it is never read as an
// image with fewer imports.
'use strict';

const fs = require('node:fs');

const IMPORT_DIRECTORY = 1;
const DELAY_IMPORT_DIRECTORY = 13;
// More than any real image has: a corrupt table must not read forever.
const MAX_DESCRIPTORS = 4096;

function reader(buffer) {
  const need = (offset, size, what) => {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > buffer.length) {
      throw new Error(`truncated PE image: ${what} at 0x${Number(offset).toString(16)} lies past the end (${buffer.length} bytes)`);
    }
  };
  return {
    u16(offset, what) {
      need(offset, 2, what);
      return buffer.readUInt16LE(offset);
    },
    u32(offset, what) {
      need(offset, 4, what);
      return buffer.readUInt32LE(offset);
    },
    u64(offset, what) {
      need(offset, 8, what);
      return buffer.readBigUInt64LE(offset);
    },
    cstring(offset, what) {
      need(offset, 1, what);
      const end = buffer.indexOf(0, offset);
      if (end < 0) throw new Error(`truncated PE image: ${what} at 0x${offset.toString(16)} has no terminator`);
      return buffer.toString('latin1', offset, end);
    },
  };
}

function peImports(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('peImports needs a Buffer');
  if (buffer.length < 0x40) throw new Error(`truncated PE image: ${buffer.length} bytes is less than a DOS header`);
  if (buffer.toString('latin1', 0, 2) !== 'MZ') throw new Error('not a PE image: no MZ signature');
  const r = reader(buffer);
  const pe = r.u32(0x3c, 'e_lfanew');
  if (pe + 4 > buffer.length) throw new Error('truncated PE image: the PE header lies past the end');
  if (buffer.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE image: no PE signature');

  const coff = pe + 4;
  const machine = r.u16(coff, 'Machine');
  const sectionCount = r.u16(coff + 2, 'NumberOfSections');
  const optionalSize = r.u16(coff + 16, 'SizeOfOptionalHeader');
  const opt = coff + 20;
  const magic = r.u16(opt, 'optional header magic');
  let format;
  let imageBase;
  let dirCountAt;
  if (magic === 0x20b) {
    format = 'PE32+';
    imageBase = r.u64(opt + 24, 'ImageBase');
    dirCountAt = opt + 108;
  } else if (magic === 0x10b) {
    format = 'PE32';
    imageBase = BigInt(r.u32(opt + 28, 'ImageBase'));
    dirCountAt = opt + 92;
  } else {
    throw new Error(`not a PE image: optional header magic 0x${magic.toString(16)}`);
  }
  const dirCount = r.u32(dirCountAt, 'NumberOfRvaAndSizes');
  const directory = (index) => {
    if (index >= dirCount) return { rva: 0, size: 0 };
    const at = dirCountAt + 4 + index * 8;
    return { rva: r.u32(at, `data directory ${index}`), size: r.u32(at + 4, `data directory ${index} size`) };
  };

  const sections = [];
  const sectionTable = opt + optionalSize;
  for (let i = 0; i < sectionCount; i += 1) {
    const at = sectionTable + i * 40;
    sections.push({
      virtualSize: r.u32(at + 8, 'section VirtualSize'),
      virtualAddress: r.u32(at + 12, 'section VirtualAddress'),
      rawSize: r.u32(at + 16, 'section SizeOfRawData'),
      rawPointer: r.u32(at + 20, 'section PointerToRawData'),
    });
  }
  const headersEnd = sectionTable + sectionCount * 40;
  // A file offset for an RVA, or a throw when no section (or the headers) maps it.
  const offsetOf = (rva, what) => {
    for (const s of sections) {
      const span = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
        const offset = s.rawPointer + (rva - s.virtualAddress);
        if (rva - s.virtualAddress >= s.rawSize || offset >= buffer.length) {
          throw new Error(`truncated PE image: ${what} (RVA 0x${rva.toString(16)}) is not in the file`);
        }
        return offset;
      }
    }
    if (rva < headersEnd) return rva;
    throw new Error(`truncated PE image: ${what} (RVA 0x${rva.toString(16)}) is in no section`);
  };

  const imports = [];
  const importDir = directory(IMPORT_DIRECTORY);
  if (importDir.rva !== 0) {
    const base = offsetOf(importDir.rva, 'the import directory');
    for (let i = 0; ; i += 1) {
      if (i >= MAX_DESCRIPTORS) throw new Error('corrupt PE image: the import directory has no end');
      const at = base + i * 20;
      const lookup = r.u32(at, 'import descriptor');
      const name = r.u32(at + 12, 'import descriptor Name');
      const first = r.u32(at + 16, 'import descriptor FirstThunk');
      if (lookup === 0 && name === 0 && first === 0) break;
      imports.push(r.cstring(offsetOf(name, 'an imported DLL name'), 'an imported DLL name'));
    }
  }

  const delayImports = [];
  const delayDir = directory(DELAY_IMPORT_DIRECTORY);
  if (delayDir.rva !== 0) {
    const base = offsetOf(delayDir.rva, 'the delay-load directory');
    for (let i = 0; ; i += 1) {
      if (i >= MAX_DESCRIPTORS) throw new Error('corrupt PE image: the delay-load directory has no end');
      const at = base + i * 32;
      const attributes = r.u32(at, 'delay-load descriptor');
      const name = r.u32(at + 4, 'delay-load descriptor DllNameRVA');
      const names = r.u32(at + 16, 'delay-load descriptor ImportNameTableRVA');
      if (attributes === 0 && name === 0 && names === 0) break;
      // Attribute bit 0 clear: an old (Visual C++ 6) table of virtual addresses.
      const rva = attributes & 1 ? name : Number(BigInt(name) - (imageBase & 0xffffffffn));
      delayImports.push(r.cstring(offsetOf(rva, 'a delay-loaded DLL name'), 'a delay-loaded DLL name'));
    }
  }
  return { format, machine, imports, delayImports };
}

function peImportsOfFile(file) {
  return peImports(fs.readFileSync(file));
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write('usage: node scripts/pe-imports.js <image> [<image> ...]\n');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    try {
      const { imports, delayImports } = peImportsOfFile(file);
      for (const dll of imports) process.stdout.write(`${file}\t${dll}\n`);
      for (const dll of delayImports) process.stdout.write(`${file}\t${dll}\t(delay-load)\n`);
    } catch (error) {
      process.stderr.write(`${file}: ${error.message}\n`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { peImports, peImportsOfFile };
