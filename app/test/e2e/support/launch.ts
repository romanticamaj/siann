// The one Electron launcher of the e2e specs (m5-ui-i18n): it pins the system
// language the renderer sees, so a spec that reads English text passes on a
// machine whose OS is in Chinese. Two levers, both given:
//
// - Chromium's --lang=<tag>, which sets the app locale (and navigator.language)
//   on Windows and Linux; macOS ignores it and reports the OS languages.
// - SIANN_TEST_LANGS, which main.ts honours under SIANN_SHELL_TEST=1 only: the
//   preload hands it to the renderer as window.siannTest.languages, and
//   locale detection reads that before navigator.languages. This is what makes
//   the pin hold on every OS. A spec that tests detection itself passes
//   `hook: false`: only --lang is given, and the renderer reads
//   navigator.languages as it does outside the tests (Windows and Linux only).
//
// The window's viewport is pinned to 1440x900 (the redesign's reference size,
// m5-ui-shell) once the first window is up: Windows clamps a window to the
// screen's work area, and a CI runner's screen is smaller than that, which
// would turn the right zone into a closed drawer (UI redesign spec 2.4).
// `viewport: null` keeps the window as the shell made it.
//
// SIANN_E2E_DEVICE_SCALE=<factor> launches with Chromium's
// --force-device-scale-factor, to run the specs at a display scale other than
// the machine's (canvas backing stores are CSS px x devicePixelRatio).
//
// Specs pass their own args (the main script included) and env as before.

import { _electron as electron, type ElectronApplication } from '@playwright/test';

export const DEFAULT_LANGUAGES: readonly string[] = ['en-US'];
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;

export interface LaunchOptions {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  // The system languages to report, first one decides (default en-US).
  readonly languages?: readonly string[];
  // false: report the languages through --lang alone, without SIANN_TEST_LANGS
  // (default true).
  readonly hook?: boolean;
  // The first window's viewport (default DEFAULT_VIEWPORT); null leaves it alone.
  readonly viewport?: { readonly width: number; readonly height: number } | null;
}

export async function launchElectron(options: LaunchOptions): Promise<ElectronApplication> {
  const languages = options.languages ?? DEFAULT_LANGUAGES;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? process.env)) if (value !== undefined) env[key] = value;
  if (options.hook === false) delete env.SIANN_TEST_LANGS;
  else env.SIANN_TEST_LANGS = languages.join(',');
  const factor = process.env.SIANN_E2E_DEVICE_SCALE;
  const scale = factor ? [`--force-device-scale-factor=${factor}`] : [];
  const app = await electron.launch({
    args: [`--lang=${languages[0] ?? 'en-US'}`, ...scale, ...options.args],
    cwd: options.cwd,
    env,
  });
  const viewport = options.viewport === undefined ? DEFAULT_VIEWPORT : options.viewport;
  if (viewport) {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
  }
  return app;
}
