import { defineConfig } from '@playwright/test';

// Electron tests only (no browsers): one worker, so each test owns the one
// app and engine it starts. Waits are Playwright condition waits bounded by
// these timeouts, never sleeps.
export default defineConfig({
  testDir: './test/e2e',
  // The UX screenshot tour runs only when asked for (SIANN_UX_TOUR=1).
  testIgnore: process.env.SIANN_UX_TOUR === '1' ? [] : ['**/ux-tour.spec.ts'],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  projects: [{ name: 'electron' }],
});
