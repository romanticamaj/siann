'use strict';

// The Windows installer's configuration (m5b-package-windows, acceptances 2 to
// 4): app/electron-builder.json, read as JSON so this dependency-free test
// can check it, and app/package.json's pin and dist script. Nothing here may
// name a signing certificate, key or secret.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const config = () => readJson(path.join(APP, 'electron-builder.json'));
const appPackage = () => readJson(path.join(APP, 'package.json'));

// electron-builder's options that sign, or hand it a certificate or a key
// (its Configuration, WindowsConfiguration and the CSC_* settings).
const SIGNING_KEYS = new Set([
  'certificateFile', 'certificatePassword', 'certificateSubjectName', 'certificateSha1', 'signtoolOptions',
  'azureSignOptions', 'sign', 'cscLink', 'cscKeyPassword', 'publisherName', 'signingHashAlgorithms', 'rfc3161TimeStampServer',
  'timeStampServer', 'signDlls', 'signExts',
].map((k) => k.toLowerCase()));

// Every signing key anywhere in the configuration, as a JSON path.
function signingFields(value, at = '$') {
  if (Array.isArray(value)) return value.flatMap((item, i) => signingFields(item, `${at}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  const found = [];
  for (const [key, inner] of Object.entries(value)) {
    if (SIGNING_KEYS.has(key.toLowerCase())) found.push(`${at}.${key}`);
    found.push(...signingFields(inner, `${at}.${key}`));
  }
  return found;
}

test('electron-builder is an exact devDependency pin, and dist builds an x64 NSIS installer without publishing', () => {
  const pkg = appPackage();
  assert.equal(pkg.devDependencies['electron-builder'], '26.18.0');
  assert.equal(pkg.dependencies?.['electron-builder'], undefined);
  assert.match(pkg.scripts.dist, /^npm run build && /);
  assert.match(pkg.scripts.dist, /node scripts\/collect-licenses\.js/);
  assert.match(pkg.scripts.dist, /electron-builder --win nsis --x64 --publish never$/);
  // The lock file holds the same version.
  const lock = readJson(path.join(APP, 'package-lock.json'));
  assert.equal(lock.packages['node_modules/electron-builder'].version, '26.18.0');
  assert.equal(lock.packages['node_modules/electron-builder'].dev, true);
});

test('the installer: SIANN, NSIS x64, the artifact name, a licence page with the AGPL text', () => {
  const c = config();
  assert.equal(c.productName, 'SIANN');
  assert.equal(c.directories.output, 'release');
  const targets = c.win.target.map((t) => (typeof t === 'string' ? { target: t } : t));
  assert.deepEqual(targets, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(c.nsis.artifactName, 'SIANN-Setup-${version}-x64.exe');
  // An assisted installer: it shows the licence page, and /S /D=<dir> installs silently.
  assert.equal(c.nsis.oneClick, false);
  assert.equal(c.nsis.license, 'build/licenses/AGPL-3.0.txt');
});

test("the AGPL text is the FSF's, byte for byte", () => {
  // https://www.gnu.org/licenses/agpl-3.0.txt; git may turn its line ends into CRLF.
  const text = fs.readFileSync(path.join(APP, 'build', 'licenses', 'AGPL-3.0.txt'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'),
    '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0');
});

test("the desktop-release engine goes where main.ts's engineExecutable() looks when packaged, beside the licences", () => {
  const extra = config().extraResources;
  assert.deepEqual(extra.find((e) => e.to === 'siann-engine.exe'),
    { from: '../native/build/desktop-release/apps/engine/siann-engine.exe', to: 'siann-engine.exe' });
  assert.deepEqual(extra.find((e) => e.to === 'licenses'), { from: 'build/licenses', to: 'licenses' });
  const main = fs.readFileSync(path.join(APP, 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /if \(app\.isPackaged\) return path\.join\(process\.resourcesPath, name\);/);
});

test('the package holds the built main, preload and renderer, not the tests', () => {
  const files = config().files;
  assert.ok(files.includes('dist/src/**/*'), JSON.stringify(files));
  assert.ok(files.includes('renderer/**/*'), JSON.stringify(files));
  assert.ok(files.includes('!dist/test/**'), JSON.stringify(files));
});

test('nothing in the configuration signs or names a certificate', () => {
  const c = config();
  assert.deepEqual(signingFields(c), []);
  assert.notEqual(c.forceCodeSigning, true);
  assert.notEqual(c.win?.forceCodeSigning, true);
  // Nor does app/package.json carry a `build` block with any of it.
  assert.deepEqual(signingFields(appPackage()), []);
});

test('the signing check fails when a signing field is added', () => {
  const c = structuredClone(config());
  c.win.certificateFile = 'cert.pfx';
  assert.deepEqual(signingFields(c), ['$.win.certificateFile']);
  const nested = structuredClone(config());
  nested.win.signtoolOptions = { certificateSha1: 'ab' };
  assert.deepEqual(signingFields(nested), ['$.win.signtoolOptions', '$.win.signtoolOptions.certificateSha1']);
  assert.deepEqual(signingFields({ nsis: { CSCLink: 'x' } }), ['$.nsis.CSCLink']);
});

test('the installer output stays out of git', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^app\/release\/$/m);
});
