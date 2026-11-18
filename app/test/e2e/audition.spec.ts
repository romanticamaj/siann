// Plan review in place: the audition (m5b-ui-audition; UI redesign 4.3, 4.5
// C4 and C5, 3.6, P2-3). While audition.changed reports a branch the window
// has the 2 px violet frame (.app[data-hearing="proposal"]), the banner names
// the plan with Hear main, Merge and Discard, the branch chip names the plan,
// and the hearing switch and the status bar show Proposal; all of it follows
// the event, also when a second connection flips the side. Shift+A flips the
// side heard while a plan is auditioned and sends nothing otherwise;
// Ctrl+Return in the right zone runs the selected plan's primary. While the
// proposal is heard the ghosts are solid from the branch snapshot (with
// main's values as the outline) and the structural edits are disabled with
// the reason, while a fader gesture goes onto the branch. Merge and Discard
// close the proposal; a partial approval merges only the ticked steps. The
// app runs the real siann-engine on the fake device under SIANN_SHELL_TEST=1;
// waits are Playwright condition waits or a round-trip of the watcher.

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { translator } from '../../src/renderer/i18n/t';
import { engineClient, type EngineClient } from './support/engine-client';
import { agentFor, hash8, launchApp, seedBundle, selectPlan, type Agent } from './support/seed';

const t = translator('en');
const RATE = 48000;
const audio = (seconds: number) => ({ domain: 'audio', value: String(Math.round(seconds * RATE)) });

// Three steps on three entities: a gain, a clip move, a pan.
const STEPS: ReadonlyArray<Record<string, unknown>> = [
  { op: 'track.set_gain', trackId: 'trk_a', gainMilliDb: -6000 },
  { op: 'clip.move', clipId: 'clp_1', position: audio(1) },
  { op: 'track.set_pan', trackId: 'trk_b', pan: -2000 },
];

let scratch: string;
let app: ElectronApplication;
let page: Page;
let agent: Agent;
let watcher: EngineClient;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-audition-'));
  const sessionDir = seedBundle(
    scratch,
    [
      { id: 'trk_a', name: 'Keys', gain: -9000 },
      { id: 'trk_b', name: 'Bass' },
      { id: 'trk_c', name: 'Vox' },
    ],
    [
      { id: 'clp_1', trackId: 'trk_a', at: 0 },
      { id: 'clp_2', trackId: 'trk_b', at: 2 },
    ],
  );
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], hook: true });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('clip-count')).toHaveText('2');
  agent = await agentFor(app);
  watcher = await engineClient(page, { events: true });
});

test.afterAll(async () => {
  watcher?.close();
  await app?.close().catch(() => undefined);
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function submit(steps: ReadonlyArray<Record<string, unknown>> = STEPS): Promise<string> {
  const hash = (await agent.tool('submit_plan', { steps })).hash as string;
  await selectPlan(page, hash);
  return hash;
}

async function status(hash: string): Promise<Record<string, unknown>> {
  return watcher.call('plan.status', { plan: hash });
}

async function head(): Promise<string> {
  return (await watcher.call('session.inspect')).revision as string;
}

async function heard(): Promise<string> {
  return (await watcher.call('session.inspect')).heard as string;
}

// The events of a type the watcher has seen since `from` (an index into its log).
const since = (from: number, type: string) => watcher.events.slice(from).filter((e) => e.type === type);

// A round-trip of the watcher: every event the engine published before it is in the log.
async function roundTrip(): Promise<void> {
  await watcher.call('session.inspect');
}

interface GhostEntry {
  readonly kind: string;
  readonly step: number;
  readonly mode?: string;
  readonly after?: unknown;
  readonly replaced?: unknown;
  readonly position?: string;
}

async function ghosts(): Promise<GhostEntry[]> {
  return page.evaluate(() => (window as unknown as { __siannGhosts: { list(): GhostEntry[] } }).__siannGhosts.list().map((g) => ({ ...g })));
}

async function canvasGhosts(): Promise<GhostEntry[]> {
  return page.evaluate(() => (window as unknown as { __siannTimeline: { ghosts(): GhostEntry[] } }).__siannTimeline.ghosts().map((g) => ({ ...g })));
}

interface ClipBox {
  readonly clipId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function clipBoxes(): Promise<ClipBox[]> {
  return page.evaluate(() => {
    const hooks = (window as unknown as { __siannTimeline?: { clips(): ClipBox[] } }).__siannTimeline;
    return hooks ? hooks.clips().map(({ clipId, x, y, width, height }) => ({ clipId, x, y, width, height })) : [];
  });
}

// The canvas's box of a clip, once it is drawn and at rest: the layout is
// filled by a draw (after a reload, later than the DOM the tests wait on), so
// this waits until the clip is listed with the same box in two reads running.
async function clipBox(clipId: string): Promise<ClipBox> {
  let last = '';
  let found: ClipBox | undefined;
  await expect
    .poll(async () => {
      found = (await clipBoxes()).find((c) => c.clipId === clipId);
      const now = found ? JSON.stringify(found) : '';
      const settled = now !== '' && now === last;
      last = now;
      return settled;
    })
    .toBe(true);
  return found!;
}

const shell = () => page.getByTestId('shell');
const banner = () => page.getByTestId('audition-banner');
const chip = () => page.locator('[data-part="branch-chip"]');

async function expectHearingProposal(name: RegExp | string): Promise<void> {
  await expect(shell()).toHaveAttribute('data-hearing', 'proposal');
  await expect(banner()).toBeVisible();
  await expect(chip()).toContainText(name);
  await expect(page.getByTestId('hear-proposal')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('status-heard')).toHaveText(t('status.hearProposal'));
}

async function expectHearingMain(): Promise<void> {
  await expect(shell()).not.toHaveAttribute('data-hearing', 'proposal');
  expect(await shell().evaluate((el) => getComputedStyle(el, '::after').borderTopStyle)).not.toBe('solid');
  await expect(banner()).toHaveCount(0);
  await expect(chip()).toContainText(/^main\s*r\d+$/);
  await expect(page.getByTestId('hear-main')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('status-heard')).toHaveText(t('status.hearMain'));
}

async function focusRight(): Promise<void> {
  await page.getByTestId('zone-right').focus();
  await expect(page.getByTestId('zone-right')).toHaveAttribute('data-focused', 'true');
}

async function focusProject(): Promise<void> {
  await page.getByTestId('zone-project').focus();
  await expect(page.getByTestId('zone-project')).toHaveAttribute('data-focused', 'true');
}

let branch = '';
let hash = '';

test('the frame, banner, chip and both switches follow audition.changed, also from a second client', async () => {
  // Acceptance 7: the chip's id is in the window, reading main r<head> while main is heard.
  await expect(chip()).toHaveCount(1);
  await expectHearingMain();
  await expect(chip()).toContainText(await head());

  hash = await submit();
  await page.getByTestId('plan-audition').click();
  await expect.poll(async () => (await status(hash)).proposalBranch).toBeTruthy();
  branch = (await status(hash)).proposalBranch as string;
  const name = /3 steps/;
  await expectHearingProposal(name);
  // The 2 px violet frame, over the zones (the window's edge).
  const outline = await shell().evaluate((el) => {
    const style = getComputedStyle(el, '::after');
    return { width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor, position: style.position, inset: style.inset, events: style.pointerEvents };
  });
  expect([outline.position, outline.inset, outline.events]).toEqual(['fixed', '0px', 'none']);
  expect(outline.width).toBe('2px');
  expect(outline.style).toBe('solid');
  const violet = await page.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--ai)';
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  expect(outline.color).toBe(violet);
  // The banner names the plan, with its three buttons.
  await expect(banner()).toContainText(name);
  for (const id of ['banner-hear-main', 'banner-merge', 'banner-discard']) await expect(page.getByTestId(id)).toBeVisible();
  // The chip's title holds the whole name.
  expect(await chip().getAttribute('title')).toMatch(name);

  // A second connection flips the side: everything follows, without a click in the window.
  await watcher.call('audition.hear', { side: 'main' });
  await expectHearingMain();
  await watcher.call('audition.hear', { side: branch });
  await expectHearingProposal(name);
});

test('Shift+A flips the side heard; Ctrl+Return in the project zone does nothing', async () => {
  await focusProject();
  let from = watcher.events.length;
  await page.keyboard.press('Shift+KeyA');
  await expect.poll(() => since(from, 'audition.changed').map((e) => e.heard)).toEqual(['main']);
  await expectHearingMain();
  from = watcher.events.length;
  await page.keyboard.press('Shift+KeyA');
  await expect.poll(() => since(from, 'audition.changed').map((e) => e.heard)).toEqual([branch]);
  await expectHearingProposal(/3 steps/);
  // Ctrl+Return outside the right zone runs nothing.
  const sent = await page.evaluate(() => (window as unknown as { __siannClient: { sent(): unknown[] } }).__siannClient.sent().length);
  await page.keyboard.press('ControlOrMeta+Enter');
  await roundTrip();
  const after = await page.evaluate(() => (window as unknown as { __siannClient: { sent(): Array<{ method: string }> } }).__siannClient.sent().map((r) => r.method));
  expect(after.slice(sent).filter((m) => m.startsWith('proposal.') || m.startsWith('plan.apply'))).toEqual([]);
  expect((await status(hash)).state).toBe('approved');
});

test('while heard the ghosts are solid from the branch, with main\'s values as the outline', async () => {
  await expect.poll(async () => (await ghosts()).map((g) => `${g.kind} ${g.step} ${g.mode}`)).toEqual(['gain 1 solid', 'clip-move 2 solid', 'pan 3 solid']);
  const gain = (await ghosts()).find((g) => g.kind === 'gain')!;
  expect(gain.after).toBe(-6000);
  expect(gain.replaced).toBe(-9000);
  // The canvas draws the same descriptors.
  await expect.poll(async () => (await canvasGhosts()).map((g) => g.mode)).toEqual(['solid', 'solid', 'solid']);
  // The strip: the solid ghost cap and the real cap at main's value, marked as the outline.
  if ((await page.getByTestId('zone-lower').getAttribute('data-visible')) !== 'true') await page.getByTestId('zone-button-lower').click();
  await page.getByTestId('tab-lower-mixconsole').click();
  await expect(page.getByTestId('fader-trk_a-ghost-1')).toHaveAttribute('data-ghost-mode', 'solid');
  await expect(page.getByTestId('fader-trk_a').locator('[data-part-of="cap"]')).toHaveAttribute('data-replaced', 'true');

  // After a reload with the proposal still open: frame, banner, chip and switches still on, ghosts dashed.
  await page.reload();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await selectPlan(page, hash);
  await expectHearingProposal(/3 steps/);
  await expect.poll(async () => (await ghosts()).map((g) => `${g.kind} ${g.step} ${g.mode ?? 'dashed'}`)).toEqual(['gain 1 dashed', 'clip-move 2 dashed', 'pan 3 dashed']);
  // The canvas has them drawn again (an empty list would not say so), none solid.
  await expect.poll(async () => (await canvasGhosts()).map((g) => g.mode ?? 'dashed')).toEqual(['dashed', 'dashed', 'dashed']);
});

async function expectGuarded(control: Locator): Promise<void> {
  await expect(control).toBeDisabled();
  await expect(control).toHaveAttribute('title', t('guard.structural'));
}

test('structural edits are disabled with the reason; a fader gesture goes onto the branch', async () => {
  const mainHead = await head();
  await expectGuarded(page.getByTestId('track-add'));
  await expectGuarded(page.getByTestId('tool-split'));
  await expectGuarded(page.getByTestId('track-mute-trk_c'));
  await expectGuarded(page.getByTestId('track-solo-trk_c'));
  await expectGuarded(page.getByTestId('mute-trk_c'));
  await expectGuarded(page.getByTestId('solo-trk_c'));
  // The keys and the canvas are inert: T, Delete, Alt+X, Ctrl+D, M, S on a selected clip and track.
  const clip = await clipBox('clp_2');
  const box = (await page.getByTestId('timeline-canvas').boundingBox())!;
  const centre = { x: box.x + clip.x + clip.width / 2, y: box.y + clip.y + clip.height / 2 };
  await page.mouse.click(centre.x, centre.y);
  for (const key of ['KeyT', 'Delete', 'Alt+KeyX', 'ControlOrMeta+KeyD', 'KeyM', 'KeyS']) {
    await page.keyboard.press(key);
    await roundTrip();
    expect(await head(), key).toBe(mainHead);
  }
  // A clip drag.
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y, { steps: 6 });
  await page.mouse.up();
  await roundTrip();
  expect(await head()).toBe(mainHead);
  // A rename by double-click opens no field.
  await page.getByTestId('track-name-trk_c').dblclick();
  await expect(page.getByTestId('track-rename-trk_c')).toHaveCount(0);

  // A fader drag ends in proposal.changed on the branch; main's head does not move.
  const from = watcher.events.length;
  const cap = page.getByTestId('fader-trk_c').locator('[data-part-of="cap"]');
  const capBox = (await cap.boundingBox())!;
  await page.mouse.move(capBox.x + capBox.width / 2, capBox.y + capBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(capBox.x + capBox.width / 2, capBox.y + capBox.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => since(from, 'proposal.changed').filter((e) => e.branch === branch).length).toBeGreaterThan(0);
  expect(await head()).toBe(mainHead);
  // The branch value the gesture set is a solid ghost on trk_c, with main's 0 dB as the outline.
  await expect.poll(async () => (await ghosts()).filter((g) => g.kind === 'gain' && g.step === 0).map((g) => [g.mode, g.replaced])).toEqual([['solid', 0]]);

  // With main heard everything is enabled again.
  await watcher.call('audition.hear', { side: 'main' });
  await expectHearingMain();
  for (const id of ['track-add', 'tool-split', 'track-mute-trk_c', 'mute-trk_c']) await expect(page.getByTestId(id)).toBeEnabled();
  await watcher.call('audition.hear', { side: branch });
  await expectHearingProposal(/3 steps/);
});

test('the primary shows its key; Ctrl+Return in the right zone merges a proposed plan', async () => {
  await selectPlan(page, hash);
  await expect(page.getByTestId('plan-merge').locator('kbd')).toHaveText('⏎');
  await focusRight();
  const from = watcher.events.length;
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(() => since(from, 'proposal.closed').map((e) => [e.branch, e.merged])).toEqual([[branch, true]]);
  await expectHearingMain();
  await expect(page.getByTestId(`plan-state-${hash8(hash)}`)).toHaveAttribute('data-state', 'applied');
  await expect.poll(async () => (await ghosts()).filter((g) => g.mode === 'solid').length).toBe(0);
});

test('Ctrl+Return in the right zone applies a validated plan, and Shift+A with no proposal sends nothing', async () => {
  const plan = await submit([{ op: 'track.set_pan', trackId: 'trk_c', pan: 3000 }]);
  await expect(page.getByTestId('plan-approve-apply').locator('kbd')).toHaveText('⏎');
  // Shift+A while main is heard and no proposal is open: no request, no event.
  const from = watcher.events.length;
  const sent = await page.evaluate(() => (window as unknown as { __siannClient: { sent(): unknown[] } }).__siannClient.sent().length);
  await focusProject();
  await page.keyboard.press('Shift+KeyA');
  await roundTrip();
  expect(since(from, 'audition.changed')).toEqual([]);
  const after = await page.evaluate(() => (window as unknown as { __siannClient: { sent(): Array<{ method: string }> } }).__siannClient.sent().map((r) => r.method));
  expect(after.slice(sent).filter((m) => m === 'audition.hear')).toEqual([]);
  expect(await heard()).toBe('main');
  await focusRight();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await status(plan)).state).toBe('applied');
});

test('Discard closes the proposal unmerged; the card reads Approved', async () => {
  const plan = await submit([{ op: 'track.set_gain', trackId: 'trk_b', gainMilliDb: -12000 }]);
  await page.getByTestId('plan-audition').click();
  await expectHearingProposal(/1 step/);
  const proposed = (await status(plan)).proposalBranch as string;
  const from = watcher.events.length;
  await page.getByTestId('banner-discard').click();
  await expect.poll(() => since(from, 'proposal.closed').map((e) => [e.branch, e.merged])).toEqual([[proposed, false]]);
  await expectHearingMain();
  await expect(page.getByTestId(`plan-state-${hash8(plan)}`)).toHaveAttribute('data-state', 'approved');
  await expect.poll(async () => (await ghosts()).filter((g) => g.mode === 'solid').length).toBe(0);
});

test('a partial approval auditions and merges only the ticked steps', async () => {
  const plan = await submit([
    { op: 'track.set_gain', trackId: 'trk_c', gainMilliDb: -3000 },
    { op: 'track.set_pan', trackId: 'trk_b', pan: 5000 },
    { op: 'track.set_gain', trackId: 'trk_b', gainMilliDb: -1500 },
  ]);
  const before = (await watcher.call('session.fetch', { refs: ['track:trk_b', 'track:trk_c'] })).entities as Array<{ ref: string; entity: Record<string, unknown> }>;
  await page.getByTestId('step-1').getByRole('checkbox').uncheck();
  await page.getByTestId('plan-audition').click();
  await expectHearingProposal(/2 steps/);
  const from = watcher.events.length;
  await page.getByTestId('banner-merge').click();
  await expect.poll(() => since(from, 'proposal.closed').filter((e) => e.merged === true).length).toBe(1);
  const merged = since(from, 'proposal.closed')[0]!.revision as string;
  const at = (await watcher.call('session.fetch', { refs: ['track:trk_b', 'track:trk_c'], revision: merged })).entities as Array<{ ref: string; entity: Record<string, unknown> }>;
  const of = (list: typeof at, ref: string) => list.find((e) => e.ref === ref)!.entity;
  expect(of(at, 'track:trk_c').gainMilliDb).toBe(-3000);
  expect(of(at, 'track:trk_b').gainMilliDb).toBe(-1500);
  expect(of(at, 'track:trk_b').pan).toBe(of(before, 'track:trk_b').pan);
  await expectHearingMain();
  void plan;
});

// The crash scenario (acceptance 3; UI redesign 4.3, 4.5 C8): the engine ends
// while a proposal is heard; the shell restarts it and the renderer
// reconnects. The branch snapshot does not survive: no frame, no banner, no
// solid ghost, the chip reads main r<recovered head>, and nothing is fetched
// at the old branch revision.
test('an engine crash while a proposal is heard: after the restart nothing of the branch is left', async () => {
  const plan = await submit([{ op: 'track.set_gain', trackId: 'trk_c', gainMilliDb: -9000 }]);
  const from = watcher.events.length;
  await page.getByTestId('plan-audition').click();
  await expectHearingProposal(/1 step/);
  await expect.poll(() => since(from, 'proposal.changed').length).toBeGreaterThan(0);
  const branchRevision = since(from, 'proposal.changed').at(-1)!.revision as string;
  await expect.poll(async () => (await ghosts()).filter((g) => g.mode === 'solid').length).toBe(1);
  void plan;
  watcher.close();
  const pid = await app.evaluate(() => (globalThis as { __siannShell?: { pid(): number | null } }).__siannShell?.pid() ?? null);
  expect(pid).not.toBeNull();
  const sentBefore = await page.evaluate(() => (window as unknown as { __siannClient: { sent(): unknown[] } }).__siannClient.sent().length);
  process.kill(pid!);
  await expect(page.getByTestId('status')).not.toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  watcher = await engineClient(page, { events: true });
  const recovered = await head();
  await expect(shell()).not.toHaveAttribute('data-hearing', 'proposal');
  await expect(banner()).toHaveCount(0);
  await expect(chip()).toHaveText(new RegExp(`^main\\s*${recovered}$`));
  await expect.poll(async () => (await ghosts()).filter((g) => g.mode === 'solid').length).toBe(0);
  const fetches = await page.evaluate(
    (at) => (window as unknown as { __siannClient: { sent(): Array<{ method: string; params: Record<string, unknown> }> } }).__siannClient.sent().slice(at).filter((r) => r.method === 'session.fetch').map((r) => r.params.revision ?? null),
    sentBefore,
  );
  expect(fetches).not.toContain(branchRevision);
});
