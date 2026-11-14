'use strict';

// m5b-package-windows, acceptance 5: siann-engine.exe and every DLL beside it
// import only from the package itself or from Windows: no compiler runtime the
// user must install (the debug CRT is not even redistributable), so the
// desktop-release engine links the MSVC runtime statically.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { peImportsOfFile } = require('../../scripts/pe-imports');
const { listFiles, packageDir } = require('./support');

// DLLs every supported Windows (10 and 11, x64) ships in System32, lower case.
const SYSTEM_DLLS = new Set([
  'kernel32.dll', 'kernelbase.dll', 'ntdll.dll', 'user32.dll', 'gdi32.dll', 'advapi32.dll', 'shell32.dll',
  'ole32.dll', 'oleaut32.dll', 'winmm.dll', 'ws2_32.dll', 'comdlg32.dll', 'comctl32.dll', 'shlwapi.dll',
  'version.dll', 'imm32.dll', 'wininet.dll', 'winhttp.dll', 'dbghelp.dll', 'bcrypt.dll', 'crypt32.dll',
  'secur32.dll', 'iphlpapi.dll', 'rpcrt4.dll', 'setupapi.dll', 'cfgmgr32.dll', 'uxtheme.dll', 'dwmapi.dll',
  'avrt.dll', 'mmdevapi.dll', 'propsys.dll', 'd2d1.dll', 'dwrite.dll', 'd3d11.dll', 'dxgi.dll', 'dcomp.dll',
  'opengl32.dll', 'glu32.dll', 'usp10.dll', 'msimg32.dll', 'winspool.drv', 'shcore.dll', 'userenv.dll',
  'wtsapi32.dll', 'powrprof.dll', 'mfplat.dll', 'mf.dll', 'mfreadwrite.dll', 'mfuuid.dll', 'ksuser.dll',
  'hid.dll', 'netapi32.dll', 'normaliz.dll', 'wldap32.dll', 'psapi.dll', 'dnsapi.dll', 'mswsock.dll',
  'windowscodecs.dll', 'urlmon.dll', 'webservices.dll', 'ncrypt.dll', 'bcryptprimitives.dll',
]);
// API sets resolve to Windows' own DLLs.
const API_SET = /^(api|ext)-ms-win-[a-z0-9-]+\.dll$/;
// Never allowed: the Visual C++ runtime and the debug or redistributable CRT.
const COMPILER_RUNTIME = /^(vcruntime\d+|vcruntime\d+_1|msvcp\d+(_\w+)?|ucrtbased?|concrt\d+|vcomp\d+|msvcr\d+)d?\.dll$/;

function allowed(dll, shipped) {
  const name = dll.toLowerCase();
  if (COMPILER_RUNTIME.test(name)) return false;
  return SYSTEM_DLLS.has(name) || API_SET.test(name) || shipped.has(name);
}

test('the allow-list never lets the compiler runtime through', () => {
  for (const dll of ['VCRUNTIME140.dll', 'VCRUNTIME140_1.dll', 'MSVCP140.dll', 'MSVCP140D.dll', 'VCRUNTIME140D.dll',
    'ucrtbase.dll', 'ucrtbased.dll', 'MSVCP140_ATOMIC_WAIT.dll']) {
    assert.equal(allowed(dll, new Set([dll.toLowerCase()])), false, dll);
  }
  assert.equal(allowed('KERNEL32.dll', new Set()), true);
  assert.equal(allowed('api-ms-win-core-synch-l1-2-0.dll', new Set()), true);
  assert.equal(allowed('libfoo.dll', new Set()), false);
  assert.equal(allowed('libfoo.dll', new Set(['libfoo.dll'])), true);
});

test('siann-engine.exe and the DLLs beside it import from Windows or the package only', (t) => {
  const dir = packageDir(t);
  if (!dir) return;
  const files = listFiles(dir);
  const shipped = new Set(files.filter((f) => /\.dll$/i.test(f)).map((f) => path.posix.basename(f).toLowerCase()));
  const engine = path.join(dir, 'resources', 'siann-engine.exe');
  assert.ok(fs.existsSync(engine), `${engine} is missing`);
  const images = [engine, ...files.filter((f) => /^resources\/[^/]+\.dll$/i.test(f)).map((f) => path.join(dir, f))];
  const bad = [];
  for (const image of images) {
    const { imports, delayImports } = peImportsOfFile(image);
    assert.ok(imports.length > 0, `${image} has an import table`);
    for (const dll of [...imports, ...delayImports]) {
      if (!allowed(dll, shipped)) bad.push(`${path.relative(dir, image)}: ${dll}`);
    }
  }
  assert.deepEqual(bad, []);
  // A sanity check that the table was read: the engine talks to Windows.
  assert.ok(peImportsOfFile(engine).imports.some((dll) => dll.toLowerCase() === 'kernel32.dll'));
});
