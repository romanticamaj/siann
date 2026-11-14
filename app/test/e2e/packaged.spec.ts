// The packaged app (m5b-package-windows, acceptance 6): SIANN.exe from
// electron-builder's win-unpacked directory, or from an installed copy, starts
// the siann-engine.exe in its resources directory on its own. SIANN_ENGINE_EXE
// is removed from the environment, so main.ts's engineExecutable() takes the
// packaged path. The test hooks (SIANN_SHELL_TEST=1, SIANN_USER_DATA, an empty
// directory, and SIANN_ENGINE_TEST_ARGS=--device fake) are read by main.ts
// packaged or not; this test depends on that.
//
// Its own Playwright project, `packaged`, which exists only when
// SIANN_PACKAGED_EXE is set (the package step of scripts/check-all.js and the
// package CI job set it); the electron project ignores this file.
// SIANN_EXPECT_COMMIT is the commit the engine must report (git rev-parse HEAD).

import { expect, test, type ElectronApplication } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient } from './support/engine-client';
import { launchElectron } from './support/launch';

let app: ElectronApplication | undefined;
let scratch = '';

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The executable a running process was started from (Windows).
function executableOf(pid: number): string {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).Path`],
    { encoding: 'utf8', windowsHide: true },
  );
  return result.stdout.trim();
}

test('the packaged app starts its own engine, connects, reports AGPL and the commit, plays, and leaves no engine behind', async () => {
  const exe = process.env.SIANN_PACKAGED_EXE;
  if (!exe) throw new Error('set SIANN_PACKAGED_EXE to the packaged SIANN.exe');
  if (!fs.existsSync(exe)) throw new Error(`SIANN_PACKAGED_EXE points at a missing file: ${exe}`);
  const commit = (process.env.SIANN_EXPECT_COMMIT ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('set SIANN_EXPECT_COMMIT to the 40-hex commit the build is from');

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-packaged-'));
  const userData = path.join(scratch, 'user-data');
  fs.mkdirSync(userData);
  const env: Record<string, string | undefined> = { ...process.env };
  // The packaged path, not a developer's engine or session.
  delete env.SIANN_ENGINE_EXE;
  delete env.SIANN_SESSION_DIR;
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIANN_SHELL_TEST = '1';
  env.SIANN_USER_DATA = userData;
  env.SIANN_ENGINE_TEST_ARGS = '--device fake';

  app = await launchElectron({ executablePath: exe, args: [], env, languages: ['en-US'] });
  const page = await app.firstWindow();
  await expect(page).toHaveTitle(/SIANN/);

  // The token handshake: the renderer is connected to the engine.
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');

  const pid = await app.evaluate(() => (globalThis as unknown as { __siannShell: { pid(): number | null } }).__siannShell.pid());
  expect(pid).not.toBeNull();
  if (process.platform === 'win32') {
    const expected = path.join(path.dirname(exe), 'resources', 'siann-engine.exe');
    expect(executableOf(pid!).toLowerCase()).toBe(expected.toLowerCase());
  }

  // The licence line: the JUCE build's licence and the build's commit.
  const about = page.getByTestId('about');
  await expect(about.locator('.about-license')).toHaveText('AGPL-3.0-or-later');
  await expect(about.locator('.about-summary')).toContainText(new RegExp(`\\(${commit.slice(0, 12)}(\\+dirty)?\\)`));

  // Playback on the fake device moves the playhead.
  const client = await engineClient(page);
  try {
    const started = await client.call('transport.play');
    expect(started.playing).toBe(true);
    const start = Number(started.position);
    await expect
      .poll(async () => {
        const state = await client.call('transport.play');
        return Number(state.position);
      })
      .toBeGreaterThan(start);
    await client.call('transport.stop');
  } finally {
    client.close();
  }

  // Quitting stops the engine with the app.
  await app.close();
  app = undefined;
  await expect.poll(() => alive(pid!)).toBe(false);
  // The user data directory was the test's own.
  expect(fs.readdirSync(userData).length).toBeGreaterThan(0);
});
