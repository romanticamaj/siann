import { defineConfig } from '@playwright/test';

// Electron tests only (no browsers): one worker, so each test owns the one
// app and engine it starts. Waits are Playwright condition waits bounded by
// these timeouts, never sleeps.
export default defineConfig({
  testDir: './test/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  projects: [{ name: 'electron' }],
});
