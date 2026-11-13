// Source checks over app/src/renderer (m5-ui-shell):
//
// - No licence literal (UI redesign spec 2.1, "Licence line"): the licence the
//   UI shows comes only from engine.about, so no renderer file, the catalogs
//   included, may name GPL or an "-or-later" licence.
// - Only index.tsx names window.siann (spec 5.8): the renderer's single
//   contact with Electron is the endpoint bridge read in the entry file, so
//   the same bundle runs in a plain browser tab. The pattern also matches
//   window.siannTest, the test-hook flag, which index.tsx reads and hands
//   down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// dist/test/unit -> app/src/renderer
const RENDERER = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx|css|html|json)$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function matches(pattern: RegExp, skip: (file: string) => boolean = () => false): string[] {
  const files = sources(RENDERER);
  assert.ok(files.some((f) => f.endsWith('index.tsx')), `no sources found under ${RENDERER}`);
  assert.ok(files.some((f) => f.endsWith(path.join('i18n', 'en.ts'))), 'the catalogs are walked');
  const found: string[] = [];
  for (const file of files) {
    if (skip(file)) continue;
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (pattern.test(line)) found.push(`${path.relative(RENDERER, file)}:${i + 1}: ${line.trim()}`);
      });
  }
  return found;
}

test('no renderer source names a licence', () => {
  assert.deepEqual(matches(/GPL|-or-later/), []);
});

test('only index.tsx references window.siann', () => {
  const entry = path.join(RENDERER, 'index.tsx');
  assert.match(fs.readFileSync(entry, 'utf8'), /window\.siann/, 'index.tsx reads the endpoint bridge');
  assert.deepEqual(
    matches(/window\.siann/, (file) => file === entry),
    [],
  );
});
