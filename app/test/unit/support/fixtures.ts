// Reads the repository's shared fixtures (fixtures/ at the repo root), which
// come from generators and published vectors outside the code under test.
// The compiled tests run from app/dist/test/unit, so the root is found by
// walking up to the directory that holds fixtures/jcs.

import * as fs from 'node:fs';
import * as path from 'node:path';

function repoRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'fixtures', 'jcs', 'cases.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no fixtures/ above ${__dirname}`);
    dir = parent;
  }
}

export function readFixture<T>(...parts: string[]): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot(), 'fixtures', ...parts), 'utf8')) as T;
}
