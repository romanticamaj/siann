// Disconnected and reconnected states (m5-ui-connection; UI redesign spec 7
// P1-6, 4.5 C8 and 3.0). The real siann-engine on the fake device opens a
// bundle seeded with siann-cli (support/seed.ts) under SIANN_SHELL_TEST=1; the
// crash is the engine process killed through the shell's pid(), as the UX
// tour does, so it runs without the hostile plugin.
//
// (a) With a restart delay far longer than the test, the window stays
// disconnected: a full-width banner shows, every zone is inert and dimmed, and
// a user's clicks and keys on the controls send nothing. "Nothing" is counted
// twice: the frames the page sends on any WebSocket, and the session client's
// log of requests it refused as disconnected (window.__siannClient, test
// builds only), which a control that tried to send would land in.
// (b) With a short restart delay the shell brings the engine back: a toast
// names the recovered revision, the clip selection is cleared, and the banner
// and the inert zones are gone.
// (c) A first launch that fails (an engine that rejects its command line, so
// every launch exits) shows the same disconnected state: the start is no
// exception once the shell reports the failed launch.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { engineClient } from './support/engine-client';
import { agentFor, hash8, launchApp, seedBundle } from './support/seed';

const ZONES = ['left', 'project', 'lower', 'right'] as const;
// The methods a control sends (the mixer, the timeline, plan review). The
// background readers (engine.status, plan.list, plan.preview, ...) are refused
// too while disconnected, and may be: no frame leaves either way.
const CONTROL_METHOD = /^(command\.execute|gesture\.|plan\.(approve|reject|apply|propose)$|audition\.hear$|proposal\.)/;

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function launch(backoffMs: number): Promise<void> {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-connection-'));
  const sessionDir = seedBundle(scratch, [{ id: 'trk_a', name: 'Alpha' }], [{ id: 'clp_a', trackId: 'trk_a', at: 0.5 }]);
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], backoffMs });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('clip-count')).toHaveText('1');
  // The first connection shows no banner and no toast.
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveCount(0);
}

// A click on the clip in the timeline canvas, as a user selects it.
async function selectClip(clipId: string): Promise<void> {
  const rects = async () =>
    page.evaluate(() => {
      const hooks = (window as unknown as { __siannTimeline?: { clips(): Array<{ clipId: string; x: number; y: number; width: number; height: number }> } })
        .__siannTimeline;
      return hooks ? hooks.clips() : [];
    });
  await expect.poll(async () => (await rects()).some((r) => r.clipId === clipId)).toBe(true);
  const rect = (await rects()).find((r) => r.clipId === clipId)!;
  const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
  await page.mouse.click(box.x + rect.x + rect.width / 2, box.y + rect.y + rect.height / 2);
  await expect(page.getByTestId('selected-clip')).toHaveText(clipId);
}

async function killEngine(): Promise<void> {
  const pid = await app!.evaluate(() => (globalThis as unknown as { __siannShell: { pid(): number | null } }).__siannShell.pid());
  expect(pid).not.toBeNull();
  process.kill(pid!);
}

async function refused(): Promise<string[]> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __siannClient?: { refused(): Array<{ method: string }> } }).__siannClient;
    if (!hook) throw new Error('window.__siannClient is missing (SIANN_SHELL_TEST=1)');
    return hook.refused().map((r) => r.method);
  });
}

// Lets the renderer finish what an input started (promise chains, a React
// commit, the gesture controller's first send): two animation frames.
async function frames(): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function opacity(zone: string): Promise<number> {
  return Number(await page.getByTestId(`zone-${zone}`).evaluate((el) => getComputedStyle(el).opacity));
}

test('while the engine is down a full-width banner shows, the zones are inert and dimmed, and no control sends a request', async () => {
  // The shell waits ten minutes before a restart: the window stays disconnected.
  await launch(600_000);
  const agent = await agentFor(app!);
  const plan = await agent.tool('submit_plan', { steps: [{ op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -3000 }] });
  await page.getByTestId(`plan-${hash8(plan.hash as string)}`).click();
  await expect(page.getByTestId('plan-approve-apply')).toBeEnabled();
  await selectClip('clp_a');
  const revision = (await page.getByTestId('revision').textContent()) ?? '';
  expect(revision).not.toBe('');
  const before = await opacity('project');

  const sent: string[] = [];
  page.on('websocket', (socket) => socket.on('framesent', (frame) => sent.push(String(frame.payload))));

  await killEngine();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'disconnected');

  // The banner spans the shell.
  const banner = page.getByTestId('connection-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role', 'status');
  const shellBox = (await page.getByTestId('shell').boundingBox())!;
  const bannerBox = (await banner.boundingBox())!;
  expect(Math.abs(bannerBox.x - shellBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(bannerBox.width - shellBox.width)).toBeLessThanOrEqual(1);
  for (const zone of ZONES) {
    const frame = page.getByTestId(`zone-${zone}`);
    await expect(frame).toHaveAttribute('inert', '');
    await expect(frame).toHaveAttribute('data-offline', 'true');
  }
  await expect.poll(() => opacity('project')).toBeLessThan(before);
  for (const zone of ['lower', 'right']) expect(await opacity(zone)).toBeLessThan(before);

  // A user tries every kind of control: a mixer button, the timeline's
  // delete button and key, a fader key, a plan action.
  await page.getByTestId('mute-trk_a').click({ force: true });
  await page.getByTestId('delete-clip').click({ force: true });
  await page.keyboard.press('Delete');
  await page.getByTestId('fader-trk_a').press('ArrowUp');
  await page.getByTestId('plan-approve-apply').click({ force: true });
  await frames();

  expect((await refused()).filter((method) => CONTROL_METHOD.test(method))).toEqual([]);
  // Each frame by its method, or its type (auth), or as sent.
  const frameTypes = sent.map((payload) => {
    try {
      const frame = JSON.parse(payload) as { type?: string; method?: string };
      return frame.method ?? frame.type ?? payload;
    } catch {
      return payload;
    }
  });
  expect(frameTypes.filter((type) => type !== 'auth')).toEqual([]);
  await expect(page.getByTestId('revision')).toHaveText(revision);
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'disconnected');
});

test('on reconnect a toast names the recovered revision, the selection is cleared and the zones come back', async () => {
  await launch(50);
  await selectClip('clp_a');
  // Another client commits: the revision the restarted engine recovers.
  const other = await engineClient(page);
  let committed = '';
  try {
    const result = (await other.call('command.execute', {
      commands: [{ op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -1500 }],
    })) as { revision: { id: string } };
    committed = result.revision.id;
  } finally {
    other.close();
  }
  expect(committed).not.toBe('');
  await expect(page.getByTestId('revision')).toHaveText(committed);
  await expect(page.getByTestId('selected-clip')).toHaveText('clp_a');

  await killEngine();
  await expect(page.getByTestId('toast')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('toast')).toContainText(committed);
  await expect(page.getByTestId('revision')).toHaveText(committed);
  const recovered = await engineClient(page);
  try {
    const sync = await recovered.call('session.sync');
    expect(sync.revision).toBe(committed);
  } finally {
    recovered.close();
  }
  await expect(page.getByTestId('selected-clip')).toHaveText('');
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  for (const zone of ZONES) {
    await expect(page.getByTestId(`zone-${zone}`)).not.toHaveAttribute('inert');
    await expect(page.getByTestId(`zone-${zone}`)).not.toHaveAttribute('data-offline', 'true');
  }
});

test('a first launch that fails shows the banner and inert, dimmed zones, and no control sends a request', async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-connection-'));
  const sessionDir = seedBundle(scratch, [{ id: 'trk_a', name: 'Alpha' }], []);
  // Every launch exits with a usage error; the shell keeps restarting it (no
  // gave-up dialog within the test).
  app = await launchApp({
    sessionDir,
    userData: path.join(scratch, 'user-data'),
    languages: ['en-US'],
    backoffMs: 200,
    maxRestarts: 1000,
    extraEngineArgs: ['--siann-no-such-option'],
  });
  page = await app.firstWindow();
  const sent: string[] = [];
  page.on('websocket', (socket) => socket.on('framesent', (frame) => sent.push(String(frame.payload))));

  const banner = page.getByTestId('connection-banner');
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'disconnected');
  for (const zone of ZONES) {
    const frame = page.getByTestId(`zone-${zone}`);
    await expect(frame).toHaveAttribute('inert', '');
    await expect(frame).toHaveAttribute('data-offline', 'true');
  }
  // Nothing was ever loaded, so only the keys can try: a delete and the undo key.
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+z');
  await frames();
  expect((await refused()).filter((method) => CONTROL_METHOD.test(method))).toEqual([]);
  expect(sent).toEqual([]);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});
