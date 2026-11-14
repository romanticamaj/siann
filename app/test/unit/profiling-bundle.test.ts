// The profiling bundle (m5-ui-mixer; UI redesign spec 5.6): the production
// react-dom/client never calls a <Profiler>'s onRender, so the e2e's count of
// React commits is taken on a second bundle, renderer.profiling.js, built
// with react-dom/client aliased to react-dom/profiling. main.ts serves it in
// place of renderer.js only under SIANN_SHELL_TEST=1 with
// SIANN_SHELL_PROFILING=1; every other request, and every other environment,
// gets the file asked for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { rendererRequestPath } from '../../src/main/serve';

// dist/test/unit -> dist/src/renderer
const DIST_RENDERER = path.resolve(__dirname, '..', '..', 'src', 'renderer');

test('the build writes both bundles; only the profiling one calls onRender', () => {
  const production = fs.readFileSync(path.join(DIST_RENDERER, 'renderer.js'), 'utf8');
  const profiling = fs.readFileSync(path.join(DIST_RENDERER, 'renderer.profiling.js'), 'utf8');
  assert.match(profiling, /typeof onRender/);
  assert.doesNotMatch(production, /typeof onRender/);
});

test('renderer.js maps to the profiling bundle only under both flags', () => {
  const both = { SIANN_SHELL_TEST: '1', SIANN_SHELL_PROFILING: '1' };
  assert.equal(rendererRequestPath('/renderer.js', both), '/renderer.profiling.js');
  assert.equal(rendererRequestPath('/renderer.js', {}), '/renderer.js');
  assert.equal(rendererRequestPath('/renderer.js', { SIANN_SHELL_PROFILING: '1' }), '/renderer.js');
  assert.equal(rendererRequestPath('/renderer.js', { SIANN_SHELL_TEST: '1' }), '/renderer.js');
  assert.equal(rendererRequestPath('/renderer.js', { SIANN_SHELL_TEST: '1', SIANN_SHELL_PROFILING: '0' }), '/renderer.js');
  assert.equal(rendererRequestPath('/index.html', both), '/index.html');
  assert.equal(rendererRequestPath('/shell.css', both), '/shell.css');
});

test('the profiling bundle is never reachable by its own name without the flags', () => {
  assert.equal(rendererRequestPath('/renderer.profiling.js', {}), null);
  assert.equal(rendererRequestPath('/renderer.profiling.js', { SIANN_SHELL_TEST: '1' }), null);
  assert.equal(rendererRequestPath('/renderer.profiling.js', { SIANN_SHELL_TEST: '1', SIANN_SHELL_PROFILING: '1' }), '/renderer.profiling.js');
});
