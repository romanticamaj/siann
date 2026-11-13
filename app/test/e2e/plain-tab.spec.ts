// The built bundle in a plain Chromium tab (m5-ui-shell; UI redesign spec
// 5.8): Playwright's own Chromium, not Electron, loads index.html from a
// local HTTP server that serves app/renderer and app/dist/src/renderer the
// way main.ts's siann://app handler does. There is no preload, so
// window.siann is undefined: the shell must render its disconnected state,
// the three zones and the project zone, with no page error and no console
// error. Runs in the Playwright project "chromium".

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';

const APP_DIR = path.resolve(__dirname, '..', '..');
const ROOTS = [path.join(APP_DIR, 'renderer'), path.join(APP_DIR, 'dist', 'src', 'renderer')];
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

let server: http.Server;
let origin = '';

test.beforeAll(async () => {
  const bundle = path.join(APP_DIR, 'dist', 'src', 'renderer', 'renderer.js');
  if (!fs.existsSync(bundle)) throw new Error(`${bundle} is missing: run npm run build first`);
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const relative = pathname === '/' ? '/index.html' : pathname;
    for (const root of ROOTS) {
      const file = path.resolve(root, `.${relative}`);
      if (!file.startsWith(root + path.sep)) continue;
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      response.end(fs.readFileSync(file));
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('the bundle renders its disconnected state in a plain tab without an exception', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  const failed: string[] = [];
  page.on('requestfailed', (request) => failed.push(request.url()));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/index.html`);
  await expect(page.getByTestId('status')).toHaveAttribute('data-status', 'disconnected');
  for (const zone of ['project', 'left', 'lower', 'right']) {
    await expect(page.getByTestId(`zone-${zone}`)).toBeAttached();
  }
  await expect(page.getByTestId('zone-project')).toHaveAttribute('data-visible', 'true');
  // The bundled fonts load from the same origin.
  const loaded = await page.evaluate(async () => [
    (await document.fonts.load('12px Inter')).filter((face) => face.status === 'loaded').length,
    (await document.fonts.load('12px "JetBrains Mono"')).filter((face) => face.status === 'loaded').length,
  ]);
  expect(loaded).toEqual([1, 1]);
  expect(failed).toEqual([]);
  expect(errors).toEqual([]);
});
