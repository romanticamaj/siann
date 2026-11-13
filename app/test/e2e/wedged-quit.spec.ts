// The bounded quit on a wedged engine (m5-shell-hardening; architecture spec,
// "Process model", Ending the engine): the engine runs with the test-only
// --test-wedge, so it ignores stdin EOF and SIGTERM, and the shell's graces are set
// short. Quitting must still return within stopGraceMs + killGraceMs + 2 s, exit 0
// and leave no engine behind: SIGKILL ends it (TerminateProcess on Windows).

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { launchElectron } from './support/launch';

const APP_DIR = path.resolve(__dirname, '..', '..');
const MAIN = path.join(APP_DIR, 'dist', 'src', 'main', 'main.js');

const STOP_GRACE_MS = 500;
const KILL_GRACE_MS = 500;

function engineExe(): string {
  const exe = process.env.SIANN_ENGINE_EXE;
  if (!exe) throw new Error('set SIANN_ENGINE_EXE to the built siann-engine executable');
  if (!fs.existsSync(exe)) throw new Error(`SIANN_ENGINE_EXE points at a missing file: ${exe}`);
  return exe;
}

// As in shell.spec.ts: EPERM is a process that exists.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let scratch: string;
let app: ElectronApplication | undefined;
let page: Page;
let enginePidSeen: number | null = null;

test.beforeEach(async () => {
  if (!fs.existsSync(MAIN)) throw new Error(`${MAIN} is missing: run npm run build first`);
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-wedged-'));
  app = await launchElectron({
    args: [MAIN],
    cwd: APP_DIR,
    env: {
      ...process.env,
      SIANN_ENGINE_EXE: engineExe(),
      SIANN_SESSION_DIR: path.join(scratch, 'sessions'),
      SIANN_USER_DATA: path.join(scratch, 'user-data'),
      SIANN_SHELL_TEST: '1',
      SIANN_ENGINE_TEST_ARGS: '--device fake --test-wedge',
      SIANN_SHELL_STOP_GRACE_MS: String(STOP_GRACE_MS),
      SIANN_SHELL_KILL_GRACE_MS: String(KILL_GRACE_MS),
    },
  });
  page = await app.firstWindow();
});

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  // A wedged engine that outlived a failed test must not outlive the run.
  if (enginePidSeen !== null && isAlive(enginePidSeen)) process.kill(enginePidSeen, 'SIGKILL');
  enginePidSeen = null;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

test('quitting with a wedged engine returns within the graces, exits 0 and ends the engine', async () => {
  await expect(page.getByTestId('status')).toHaveText('connected');
  const pid = await app!.evaluate(() => {
    const shell = (globalThis as { __siannShell?: { pid(): number | null } }).__siannShell;
    return shell ? shell.pid() : null;
  });
  expect(pid).not.toBeNull();
  enginePidSeen = pid;

  // Held before close: the application object lets go of it then.
  const shell = app!.process();
  const t0 = Date.now();
  await app!.close();
  const elapsed = Date.now() - t0;

  expect(elapsed).toBeLessThan(STOP_GRACE_MS + KILL_GRACE_MS + 2_000);
  expect(shell.exitCode).toBe(0);
  await expect.poll(() => isAlive(pid!)).toBe(false);
});
