// The project zone toolbar's helpers for the e2e specs (m5-ui-port-toolbar;
// UI redesign 10.8): the media buttons left the toolbar for the Pool, which
// Ctrl+P (Cmd+P) opens, and the grid type is a field whose menu holds Bar,
// Beat and Adapt to Zoom. Every spec that placed from the toolbar's pool or
// chose a grid type in the old select goes through these.

import { expect, type Locator, type Page } from '@playwright/test';

import type { GridType, SnapType } from '../../../src/renderer/timeline/snap';

// Opens the Pool with Ctrl+P (Cmd+P on macOS) unless it is open.
export async function openPool(page: Page): Promise<Locator> {
  const pool = page.getByTestId('media-pool');
  if ((await pool.count()) === 0) await page.keyboard.press('ControlOrMeta+KeyP');
  await expect(pool).toBeVisible();
  return pool;
}

// Arms placing for one media from the Pool: the next click in the event
// display places it. The Pool steps aside once it is armed.
export async function armPlacing(page: Page, mediaId: string): Promise<void> {
  await openPool(page);
  await page.getByTestId(`pool-${mediaId}`).click();
  await expect(page.getByTestId('media-pool')).toHaveCount(0);
}

// Chooses a grid type from the grid type field's menu.
export async function chooseGrid(page: Page, grid: GridType): Promise<void> {
  await page.getByTestId('grid-type').click();
  const menu = page.getByTestId('grid-type-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId(`grid-type-${grid}`).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('grid-type')).toHaveAttribute('data-grid', grid);
}

// Chooses a snap type from the snap field's menu (m5b-ui-edit-more; UI
// redesign 3.2): the field's chevron opens it, a click elsewhere on the field
// still turns snap on and off.
export async function chooseSnapType(page: Page, type: SnapType): Promise<void> {
  const field = page.getByTestId('snap-toggle');
  const pressed = await field.getAttribute('aria-pressed');
  await field.locator('svg').last().click();
  const menu = page.getByTestId('snap-type-menu');
  await expect(menu).toBeVisible();
  await menu.getByTestId(`snap-type-${type}`).click();
  await expect(menu).toHaveCount(0);
  await expect(field).toHaveAttribute('data-snap-type', type);
  // Opening the menu did not toggle snap.
  await expect(field).toHaveAttribute('aria-pressed', pressed ?? 'true');
}
