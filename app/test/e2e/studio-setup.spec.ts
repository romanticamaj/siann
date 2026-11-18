// Studio Setup end to end (m5b-ui-project; UI redesign UR-4, 3.0; Protocol
// engine v0, engine.devices, engine.select_device, engine.status): the real
// siann-engine on the fake device. Studio > Studio Setup (the native menu's
// item, clicked in the main process) lists `fake` with 2 inputs and 2
// outputs; selecting the output and the input sends engine.select_device and
// the dialog shows the rate, buffer, latencies and the SRC state. With every
// open of the fake device refused (--fake-open-failures) and a device
// backoff long enough that the engine does not retry during the test, the
// transport's tooltip names Studio Setup after the reason, a click on a
// transport button opens it, and a refused selection shows device_open_failed
// with no second selection sent, since no device ran before it.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { en } from '../../src/renderer/i18n/en';
import { launchApp, seedBundle } from './support/seed';

let scratch = '';
let app: ElectronApplication | undefined;
let page: Page;

test.beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-studio-setup-'));
});

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

async function launch(extraEngineArgs: readonly string[] = []): Promise<void> {
  app = await launchApp({
    sessionDir: seedBundle(scratch, [{ id: 'trk_a', name: 'Alpha' }]),
    userData: path.join(scratch, 'user-data'),
    languages: ['en-US'],
    extraEngineArgs,
  });
  page = await app.firstWindow();
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'connected');
}

async function selects(): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => window.__siannClient!.sent().filter((r) => r.method === 'engine.select_device').map((r) => ({ ...r.params })));
}

async function openFromMenu(): Promise<void> {
  await expect
    .poll(() => app!.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('studio.setup')?.label ?? null))
    .toBe(en['menu.studioSetup']);
  await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('studio.setup')!.click());
  await expect(page.getByTestId('studio-setup')).toBeVisible();
}

test('Studio Setup lists the fake device with its channels, selects output and input, and shows the device\'s figures', async () => {
  await launch();
  await openFromMenu();
  const row = page.getByTestId('setup-device-fake');
  await expect(row.getByTestId('setup-inputs')).toHaveText('2');
  await expect(row.getByTestId('setup-outputs')).toHaveText('2');
  await page.getByTestId('setup-output').selectOption('fake');
  await page.getByTestId('setup-input').selectOption('fake');
  await page.getByTestId('setup-apply').click();
  await expect.poll(selects).toEqual([{ id: 'fake', inputId: 'fake' }]);
  await expect(page.getByTestId('setup-error')).toHaveCount(0);
  await expect(page.getByTestId('setup-rate')).toHaveText(en['setup.rateValue'].replace('{hz}', '48000'));
  await expect(page.getByTestId('setup-buffer')).toHaveText(/^\d+/);
  await expect(page.getByTestId('setup-input-latency')).toHaveText(/\d+.*ms/);
  await expect(page.getByTestId('setup-output-latency')).toHaveText(/\d+.*ms/);
  // The session runs at the device's rate: no device-side conversion.
  await expect(page.getByTestId('setup-src')).toHaveText(en['setup.srcInactive']);
  // The input is open: the dialog's input list shows the one engine.status names.
  await expect(page.getByTestId('setup-input')).toHaveValue('fake');
  await page.getByTestId('setup-close').click();
  await expect(page.getByTestId('studio-setup')).toBeHidden();
});

test('with no device the transport\'s tooltip names Studio Setup, a click opens it, and a refused selection sends nothing back', async () => {
  // Every open of the fake device refused; no retry while the test runs.
  await launch(['--fake-open-failures', '5', '--device-backoff', '600000:600000:600000']);
  const play = page.getByTestId('transport-play');
  await expect(play).toHaveAttribute('aria-disabled', 'true');
  await expect(play).toHaveAttribute('title', `device_open_failed: ${en['transport.noDevice']}\n${en['transport.studioSetupHint']}`);
  // aria-disabled: Playwright's actionability check refuses it, a person's click does not.
  await play.click({ force: true });
  await expect(page.getByTestId('studio-setup')).toBeVisible();
  // The transport sent nothing.
  expect(await page.evaluate(() => window.__siannClient!.sent().filter((r) => r.method.startsWith('transport.')).length)).toBe(0);
  await page.getByTestId('setup-output').selectOption('fake');
  await page.getByTestId('setup-apply').click();
  await expect(page.getByTestId('setup-error')).toContainText('device_open_failed');
  expect(await selects()).toEqual([{ id: 'fake' }]);
  // No device ran before it, so there is nothing to go back to: still one selection.
  await expect.poll(async () => page.evaluate(() => window.__siannClient!.answered().filter((r) => r.method === 'engine.select_device').length)).toBe(1);
  expect(await selects()).toHaveLength(1);
});
