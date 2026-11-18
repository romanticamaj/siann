// The project zone's helpers for the e2e specs (m5-ui-port-toolbar;
// UI redesign 10.8): the grid type is a field whose menu holds Bar, Beat and
// Adapt to Zoom. Placing goes through the right zone's Media tab
// (m5b-ui-media; UR-5), which replaced the Pool: Ctrl+P (Cmd+P) opens it, and
// a row dragged to the event display places a clip there. Every spec that
// placed from the Pool or chose a grid type goes through these.

import { expect, type Locator, type Page } from '@playwright/test';

import type { GridType, SnapType } from '../../../src/renderer/timeline/snap';

// Opens the Media tab with Ctrl+P (Cmd+P on macOS) unless it shows.
export async function openMedia(page: Page): Promise<Locator> {
  const tab = page.getByTestId('media-tab');
  if (!(await tab.isVisible().catch(() => false))) await page.keyboard.press('ControlOrMeta+KeyP');
  await expect(tab).toBeVisible();
  return tab;
}

// Drags a Media tab row to a client point of the event display: dragstart on
// the row (it writes the app's drag type), then dragenter, dragover and drop
// on the event display at the point, as the window's drag does.
export async function dragMediaRow(page: Page, mediaId: string, at: { x: number; y: number }): Promise<void> {
  await openMedia(page);
  await expect(page.getByTestId(`media-row-${mediaId}`)).toHaveAttribute('draggable', 'true');
  await page.evaluate(
    ({ id, x, y }) => {
      const row = document.querySelector(`[data-testid="media-row-${id}"]`)!;
      const target = document.querySelector('[data-testid="event-display"]')!;
      const data = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: x, clientY: y }));
      }
      row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
    },
    { id: mediaId, x: at.x, y: at.y },
  );
}

// Places one media at a canvas point (canvas pixels of the event display) by
// dragging its Media tab row there.
export async function placeMedia(page: Page, mediaId: string, canvasX: number, canvasY: number): Promise<void> {
  const box = (await page.getByTestId('event-display').boundingBox())!;
  await dragMediaRow(page, mediaId, { x: box.x + canvasX, y: box.y + canvasY });
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
