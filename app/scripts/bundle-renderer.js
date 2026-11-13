#!/usr/bin/env node
// Bundles the React renderer (ADR-0019 point 4) into one script that
// renderer/index.html loads under the CSP `script-src 'self'`: an IIFE with no
// eval and no source map. tsc type-checks the same sources (npm run build runs
// it first); esbuild only strips types and bundles. The output goes where
// main.ts's RENDERER_ROOTS already serves files from.
//
// A second build, renderer.profiling.js, aliases react-dom/client to
// react-dom/profiling (shipped in the pinned react-dom): the production
// react-dom never calls a <Profiler>'s onRender, so the e2e's count of React
// commits (UI redesign spec 5.6) needs this one. main.ts serves it in place of
// renderer.js only under SIANN_SHELL_TEST=1 with SIANN_SHELL_PROFILING=1.
const path = require('node:path');
const esbuild = require('esbuild');

const APP_DIR = path.resolve(__dirname, '..');

// The Chromium of the pinned Electron 44 (process.versions.chrome is 152).
const TARGET = 'chrome152';

async function build(outName, alias) {
  await esbuild.build({
    absWorkingDir: APP_DIR,
    entryPoints: [path.join('src', 'renderer', 'index.tsx')],
    outfile: path.join('dist', 'src', 'renderer', outName),
    alias,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: TARGET,
    jsx: 'automatic',
    // React reads process.env.NODE_ENV; the sandboxed renderer has no `process`.
    define: { 'process.env.NODE_ENV': '"production"' },
    sourcemap: false,
    logLevel: 'warning',
  });
}

async function main() {
  await build('renderer.js', {});
  await build('renderer.profiling.js', { 'react-dom/client': 'react-dom/profiling' });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
