#!/usr/bin/env node
// Gathers the licence texts the Windows installer carries into app/build/licenses
// (electron-builder copies the directory to resources/licenses; `npm run dist`
// runs this first). AGPL-3.0.txt is checked in there: it is the package's
// licence as a whole (ADR-0017) and the installer's licence page. The rest are
// copied here, so each is the text of the source the build used:
//
// - GPL-2.0.txt: SIANN's own sources (the repository's LICENSE);
// - JUCE's licence, and the notices of the Steinberg SDKs JUCE carries (ASIO,
//   VST3), from the JUCE source the engine build used;
// - CLAP, IXWebSocket, r8brain and dr_libs, linked into siann-engine;
// - the OFL texts of the fonts the renderer ships.
//
// The engine build's dependency sources are found as scripts/check-all.js finds
// them (the shared cache recorded in CMakeCache.txt, else _deps); the build is
// native/build/desktop-release, or SIANN_LICENSE_BUILD_DIR. A missing text fails.
// Electron's own LICENSE.electron.txt and LICENSES.chromium.html come with the
// Electron distribution electron-builder packages.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { dependencySource } = require('../../scripts/check-all.js');

const APP = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP, '..');
const OUT = path.join(APP, 'build', 'licenses');

function sources(buildDir) {
  const dep = (name) => dependencySource(buildDir, name);
  const juce = dep('juce');
  return {
    'GPL-2.0.txt': path.join(ROOT, 'LICENSE'),
    'JUCE-LICENSE.md': path.join(juce, 'LICENSE.md'),
    'ASIO-SDK-LICENSE.txt': path.join(juce, 'modules', 'juce_audio_devices', 'native', 'asio', 'LICENSE.txt'),
    'VST3-SDK-LICENSE.txt': path.join(juce, 'modules', 'juce_audio_processors_headless', 'format_types', 'VST3_SDK',
      'LICENSE.txt'),
    'CLAP-LICENSE.txt': path.join(dep('clap'), 'LICENSE'),
    'IXWebSocket-LICENSE.txt': path.join(dep('ixwebsocket'), 'LICENSE.txt'),
    'r8brain-LICENSE.txt': path.join(dep('r8brain'), 'LICENSE'),
    'dr_libs-LICENSE.txt': path.join(dep('dr_libs'), 'LICENSE'),
    'Inter-OFL.txt': path.join(APP, 'renderer', 'fonts', 'Inter-OFL.txt'),
    'JetBrainsMono-OFL.txt': path.join(APP, 'renderer', 'fonts', 'JetBrainsMono-OFL.txt'),
  };
}

function collect(buildDir = process.env.SIANN_LICENSE_BUILD_DIR || path.join(ROOT, 'native', 'build', 'desktop-release')) {
  if (!fs.existsSync(path.join(buildDir, 'CMakeCache.txt'))) {
    throw new Error(`${buildDir} is not a configured build: run cmake --preset desktop-release in native/ first`);
  }
  const wanted = sources(buildDir);
  const missing = Object.entries(wanted).filter(([, from]) => !fs.existsSync(from)).map(([name, from]) => `${name} (${from})`);
  if (missing.length) throw new Error(`licence texts not found: ${missing.join(', ')}`);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, from] of Object.entries(wanted)) fs.copyFileSync(from, path.join(OUT, name));
  if (!fs.existsSync(path.join(OUT, 'AGPL-3.0.txt'))) throw new Error('app/build/licenses/AGPL-3.0.txt is missing');
  return Object.keys(wanted);
}

if (require.main === module) {
  try {
    const names = collect();
    process.stdout.write(`[collect-licenses] ${names.length} texts in ${path.relative(ROOT, OUT)}\n`);
  } catch (error) {
    process.stderr.write(`[collect-licenses] ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { collect, sources };
