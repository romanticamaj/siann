import { defineConfig } from '@playwright/test';

// Two projects. "electron": the Electron shell specs (they launch the app with
// Playwright's Electron driver), one worker, so each test owns the one app and
// engine it starts. "chromium": the built bundle in Playwright's own Chromium
// (plain-tab.spec.ts, m5-ui-shell), which needs `npx playwright install
// chromium`. Waits are Playwright condition waits bounded by these timeouts,
// never sleeps.

// The UX screenshot tour runs only when asked for (SIANN_UX_TOUR=1).
const tour = process.env.SIANN_UX_TOUR === '1' ? [] : ['**/ux-tour.spec.ts'];
const PLAIN_TAB = '**/plain-tab.spec.ts';
// The packaged app (m5b-package-windows): its own project, which exists only
// when SIANN_PACKAGED_EXE names a packaged SIANN.exe (the package step of
// scripts/check-all.js and the package CI job run `--project packaged`).
const PACKAGED = '**/packaged.spec.ts';
const packaged = process.env.SIANN_PACKAGED_EXE ? [{ name: 'packaged', testMatch: PACKAGED }] : [];
// The mockup fidelity gate runs only when asked for (SIANN_FIDELITY=1), as its
// own project: it opens the mockup in Chromium and the app in Electron.
const FIDELITY = '**/mockup-fidelity.spec.ts';
const fidelity = process.env.SIANN_FIDELITY === '1' ? [{ name: 'fidelity', testMatch: FIDELITY }] : [];

export default defineConfig({
  testDir: './test/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  projects: [
    { name: 'electron', testIgnore: [...tour, PLAIN_TAB, PACKAGED, FIDELITY] },
    { name: 'chromium', testMatch: PLAIN_TAB, use: { browserName: 'chromium' } },
    ...packaged,
    ...fidelity,
  ],
});
