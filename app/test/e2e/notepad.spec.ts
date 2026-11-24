// The Inspector's Notepad end to end (m5b-ui-notepad, UR-17; UI redesign 3.4,
// 2.1, 3.0, 4.5 C5, 10.11 item 23). The app runs the real siann-engine
// (SIANN_ENGINE_EXE) on the fake device under SIANN_SHELL_TEST=1, the bundle
// prepared with siann-cli (SIANN_CLI_EXE); a second protocol client is
// another connection. Controls are found by role and test id; waits are
// Playwright condition waits, never sleeps.
//
// The section is shut by default and its head opens it (click, Enter,
// Space), kept over a relaunch. Leaving the text area or Ctrl/Cmd+Enter
// commits one track.set_notes (one revision, one undo); Escape discards; from
// the area m does not mute; a refused text keeps its draft with the refusal
// line. The text follows another connection while clean and keeps a dirty
// draft with the "changed elsewhere" line; an applied plan and the selection
// are followed. While a proposal is heard the area is read-only with the
// guard's reason. Against capabilities without the command the part is absent
// and its box keeps the closed section's height.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { en } from '../../src/renderer/i18n/en';
import { engineClient, type EngineClient } from './support/engine-client';
import { agentFor, launchApp, seedBundle, selectPlan } from './support/seed';

let scratch = '';
let sessionDir = '';
let app: ElectronApplication | undefined;
let page: Page;
let engine: EngineClient | undefined;

type Request = { method: string; params: Record<string, unknown> };

test.beforeEach(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-notepad-'));
  sessionDir = seedBundle(scratch, [
    { id: 'trk_a', name: 'Drums' },
    { id: 'trk_b', name: 'Bass' },
  ]);
});

test.afterEach(async () => {
  engine?.close();
  engine = undefined;
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function launch(env: Record<string, string> = {}): Promise<void> {
  app = await launchApp({ sessionDir, userData: path.join(scratch, 'user-data'), languages: ['en-US'], env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
  await expect(page.getByTestId('about-track-count')).toHaveText('2');
  engine = await engineClient(page);
}

async function relaunch(env: Record<string, string> = {}): Promise<void> {
  engine?.close();
  engine = undefined;
  await app!.close();
  await launch(env);
}

const header = (id: string) => page.getByTestId(`track-header-${id}`);
const section = () => page.locator('[data-part="inspector-notepad"]');
const head = () => section().getByRole('button', { name: en['inspector.notepad'] });
const area = () => page.getByTestId('notepad-text');
const leftFrame = () => page.getByTestId('zone-left');
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function selectTrack(id: string): Promise<void> {
  await header(id).locator('.name').click();
  await expect(header(id)).toHaveAttribute('aria-selected', 'true');
}

async function open(): Promise<void> {
  if ((await head().getAttribute('aria-expanded')) !== 'true') await head().click();
  await expect(area()).toBeVisible();
}

async function revisions(): Promise<number> {
  return (await engine!.call('session.inspect')).revisions as number;
}

async function notesOf(id: string): Promise<string | undefined> {
  const fetched = (await engine!.call('session.fetch', { refs: [`track:${id}`] })) as { entities: Array<{ entity: { notes?: string } }> };
  return fetched.entities[0]!.entity.notes;
}

async function sent(): Promise<Request[]> {
  return page.evaluate(() => {
    const client = (window as unknown as { __siannClient?: { sent(): Request[] } }).__siannClient;
    if (!client) throw new Error('window.__siannClient is missing (SIANN_SHELL_TEST=1)');
    return client.sent().map((r) => ({ method: r.method, params: r.params }));
  });
}

async function commands(op: string): Promise<Array<Record<string, unknown>>> {
  return (await sent())
    .filter((r) => r.method === 'command.execute')
    .flatMap((r) => (r.params.commands as Array<Record<string, unknown>>) ?? [])
    .filter((c) => c.op === op);
}

async function typeIn(text: string): Promise<void> {
  await area().click();
  await page.keyboard.type(text);
  await expect(area()).toHaveValue(new RegExp(`${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
}

test('the section is shut by default; a click, Enter and Space on its head open and close it; its state survives a relaunch', async () => {
  await launch();
  await selectTrack('trk_a');
  await expect(section()).toHaveCount(1);
  await expect(section()).toHaveClass(/\bshut\b/);
  await expect(head()).toBeVisible();
  await expect(head()).toHaveAttribute('aria-expanded', 'false');
  await expect(area()).toHaveCount(0);
  await head().click();
  await expect(head()).toHaveAttribute('aria-expanded', 'true');
  await expect(section()).not.toHaveClass(/\bshut\b/);
  await expect(area()).toBeVisible();
  await head().focus();
  await page.keyboard.press('Enter');
  await expect(head()).toHaveAttribute('aria-expanded', 'false');
  // Space opens it and is no transport key here.
  await page.keyboard.press('Space');
  await expect(head()).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('transport-play')).toHaveAttribute('aria-pressed', 'false');
  await relaunch();
  await selectTrack('trk_a');
  await expect(head()).toHaveAttribute('aria-expanded', 'true');
  await expect(area()).toBeVisible();
  // [data-part=inspector-notepad] is in the window (acceptance 6).
  await expect(page.locator('[data-part="inspector-notepad"]')).toHaveCount(1);
});

test('typed and left by a click on a track header: one revision, another connection reads the notes, one undo restores them', async () => {
  await launch();
  await selectTrack('trk_a');
  await open();
  const before = await revisions();
  await typeIn('Kick at bar 9');
  await selectTrack('trk_a');
  await expect.poll(revisions).toBe(before + 1);
  expect(await notesOf('trk_a')).toBe('Kick at bar 9');
  expect(await commands('track.set_notes')).toEqual([{ op: 'track.set_notes', trackId: 'trk_a', notes: 'Kick at bar 9' }]);
  // A focus and a blur with no typing send nothing.
  await area().click();
  await selectTrack('trk_a');
  expect(await commands('track.set_notes')).toHaveLength(1);
  await engine!.call('session.undo');
  await expect.poll(() => notesOf('trk_a')).toBeUndefined();
  await expect(area()).toHaveValue('');
});

test('Ctrl/Cmd+Enter commits one revision and puts the focus on the left zone; Escape discards and does the same', async () => {
  await launch();
  await selectTrack('trk_a');
  await open();
  const before = await revisions();
  await typeIn('Bridge: half time');
  await page.keyboard.press(`${MOD}+Enter`);
  await expect.poll(revisions).toBe(before + 1);
  await expect(leftFrame()).toBeFocused();
  expect(await notesOf('trk_a')).toBe('Bridge: half time');
  expect(await commands('track.set_notes')).toHaveLength(1);
  // Escape: no revision, the text back, the focus on the frame.
  await typeIn(' and louder');
  await page.keyboard.press('Escape');
  await expect(leftFrame()).toBeFocused();
  await expect(area()).toHaveValue('Bridge: half time');
  expect(await revisions()).toBe(before + 1);
  expect(await commands('track.set_notes')).toHaveLength(1);
});

test('with the focus in the text area m does not mute the track and the letter is in the text', async () => {
  await launch();
  await selectTrack('trk_a');
  await open();
  await area().click();
  await page.keyboard.press('KeyM');
  await expect(area()).toHaveValue('m');
  await expect(page.getByTestId('track-mute-trk_a')).toHaveAttribute('aria-pressed', 'false');
  expect(await commands('track.set_mute')).toEqual([]);
});

test('a text holding U+202E is refused as invalid_notes: the refusal line, the draft kept, no revision', async () => {
  await launch();
  await selectTrack('trk_a');
  await open();
  const before = await revisions();
  await area().fill('Left to right ‮ reversed');
  await selectTrack('trk_a');
  await expect(page.getByTestId('notepad-refusal')).toHaveAttribute('data-code', 'invalid_notes');
  await expect(page.getByTestId('notepad-refusal')).toContainText(`invalid_notes: ${en['error.invalid_notes']}`);
  await expect(area()).toHaveValue('Left to right ‮ reversed');
  expect(await revisions()).toBe(before);
  expect(await notesOf('trk_a')).toBeUndefined();
});

test('another connection\'s change: followed while clean; while dirty the draft stays with the changed-elsewhere line, and Escape shows it', async () => {
  await launch();
  await selectTrack('trk_a');
  await open();
  await engine!.call('command.execute', { commands: [{ op: 'track.set_notes', trackId: 'trk_a', notes: 'From the other window\r\nline two' }] });
  // Stored CR LF shows as LF.
  await expect(area()).toHaveValue('From the other window\nline two');
  await typeIn(' (mine)');
  await engine!.call('command.execute', { commands: [{ op: 'track.set_notes', trackId: 'trk_a', notes: 'Changed again' }] });
  await expect(page.getByTestId('notepad-changed')).toHaveText(en['notepad.changedElsewhere']);
  await expect(page.getByTestId('notepad-changed')).toHaveAttribute('role', 'status');
  await expect(area()).toHaveValue('From the other window\nline two (mine)');
  await page.keyboard.press('Escape');
  await expect(area()).toHaveValue('Changed again');
  await expect(page.getByTestId('notepad-changed')).toHaveCount(0);
  // Nothing went from the window.
  expect(await commands('track.set_notes')).toEqual([]);
});

test('an applied plan\'s track.set_notes is followed, and selecting another track shows that track\'s notes', async () => {
  await launch();
  await selectTrack('trk_a');
  await open();
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) !== 'true') await page.getByTestId('plans-button').click();
  const agent = await agentFor(app!);
  const hash = (await agent.tool('submit_plan', { steps: [{ op: 'track.set_notes', trackId: 'trk_a', notes: 'From the plan' }] })).hash as string;
  await selectPlan(page, hash);
  await page.getByTestId('plan-approve-apply').click();
  await expect(area()).toHaveValue('From the plan');
  await engine!.call('command.execute', { commands: [{ op: 'track.set_notes', trackId: 'trk_b', notes: 'Bass notes' }] });
  await selectTrack('trk_b');
  await expect(area()).toHaveValue('Bass notes');
  await expect(area()).toHaveAttribute('aria-label', en['notepad.label']({ track: 'Bass' }));
  await selectTrack('trk_a');
  await expect(area()).toHaveValue('From the plan');
});

test('while a proposal is heard the text area is read-only with the guard\'s reason and sends nothing', async () => {
  await launch();
  await selectTrack('trk_a');
  await open();
  const agent = await agentFor(app!);
  if ((await page.getByTestId('zone-right').getAttribute('data-visible')) !== 'true') await page.getByTestId('plans-button').click();
  const hash = (await agent.tool('submit_plan', { steps: [{ op: 'track.set_gain', trackId: 'trk_b', gainMilliDb: -6000 }] })).hash as string;
  await selectPlan(page, hash);
  await page.getByTestId('plan-audition').click();
  await expect.poll(async () => (await engine!.call('session.inspect')).heard as string).not.toBe('main');
  await expect(area()).toHaveAttribute('readonly', '');
  await expect(area()).toHaveAttribute('title', en['guard.structural']);
  const before = await revisions();
  await area().click();
  await page.keyboard.type('blocked');
  await expect(area()).toHaveValue('');
  await page.keyboard.press(`${MOD}+Enter`);
  await selectTrack('trk_a');
  expect(await commands('track.set_notes')).toEqual([]);
  expect(await revisions()).toBe(before);
  await engine!.call('audition.hear', { side: 'main' });
  await expect(area()).not.toHaveAttribute('readonly', '');
});

test('against capabilities without track.set_notes the section is absent and its empty box keeps the closed section\'s height', async () => {
  await launch();
  await selectTrack('trk_a');
  const tabsWith = (await page.locator('[data-part="inspector-tabs"]').boundingBox())!;
  const boxWith = (await section().boundingBox())!;
  const capabilities = (await engine!.call('engine.capabilities')) as { commands: string[] };
  const reduced = { ...capabilities, commands: capabilities.commands.filter((c) => c !== 'track.set_notes') };
  const file = path.join(scratch, 'capabilities-without-notes.json');
  fs.writeFileSync(file, JSON.stringify(reduced));
  await relaunch({ SIANN_TEST_CAPABILITIES: file });
  await selectTrack('trk_a');
  await expect(page.locator('[data-part="inspector-notepad"]')).toHaveCount(0);
  await expect(page.getByTestId('notepad-text')).toHaveCount(0);
  const empty = page.locator('.inspector-hold.notepad');
  await expect(empty).toHaveCount(1);
  await expect(empty).toHaveAttribute('aria-hidden', 'true');
  for (const attr of ['role', 'tabindex', 'data-part']) expect(await empty.getAttribute(attr), attr).toBeNull();
  await expect(empty).toHaveText('');
  const box = (await empty.boundingBox())!;
  expect(Math.abs(box.y - boxWith.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.height - boxWith.height)).toBeLessThanOrEqual(1);
  const tabs = (await page.locator('[data-part="inspector-tabs"]').boundingBox())!;
  for (const side of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(tabs[side] - tabsWith[side]), side).toBeLessThanOrEqual(1);
});
